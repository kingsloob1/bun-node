/**
 * Limits and filters — deciding what an upload may contain.
 *
 * ```bash
 * bun 08-multipart/limits-and-filters.ts
 * ```
 *
 * Three layers, each with its own job:
 *
 * 1. **`maxContentLength`** (request option `parseBody`) caps the whole body.
 *    Over it, the adapter answers `413 Payload Too Large` before any route runs.
 * 2. **busboy `limits`** (`parseBody.contentTypes.multipart.opts`) cap parts
 *    while parsing. Over one, the upload is refused as multer refuses it: an
 *    `UploadError` with status 413 — `LIMIT_FILE_COUNT` for a file past
 *    `files`, `LIMIT_FILE_SIZE` (naming the field) for a file reaching
 *    `fileSize`, `LIMIT_FIELD_COUNT` for a field past `fields`. Nothing is
 *    ever cut short or dropped.
 * 3. **`filter`** (upload options) sees each stored file and answers `true`
 *    to keep it, `false` to leave it out quietly (it is removed from storage),
 *    or a string (or a throw) to
 *    reject the whole upload with that message.
 *
 * A refused upload is an **`UploadError`**, multer's `MulterError` shape: a
 * `code` to branch on (`LIMIT_UNEXPECTED_FILE` for a file on the wrong field
 * or over `maxCount`, `FILTER_REJECTED` for a filter's string answer), the
 * `field` it concerns, and a `status` — 413 for size and count limits, 400
 * otherwise. An error the filter *throws* is passed on as it is. The error
 * handler below renders all three.
 *
 * Where the busboy limits go: the request body is parsed once, when the
 * request is built, with the request's parser options — so limits there
 * refuse an oversized upload before any handler runs, and a handler asking
 * for the parts gets that same refusal. Limits in the upload options apply
 * too (`getBusBoyConfig` passes them on): `getMultiParts` re-parses the
 * buffered body with them merged over the request's. The last section shows
 * that. Text fields are also run through `JSON.parse` by the default
 * inflater, which is why `"1"` arrives as `1`.
 */
import type {
  CustomUploadOptions,
  JsonValue,
  RouterErrorMiddlewareHandler,
  RouterHandler,
  StorageFile,
  UploadFilterHandler,
  UploadOptions,
} from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  BunRouter,
  DEFAULT_UPLOAD_OPTIONS,
  filterUpload,
  getBusBoyConfig,
  handleMultipartAnyFiles,
  handleMultipartMultipleFiles,
  transformUploadOptions,
  UploadError,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Upload limits and filters");

/** A file of `bytes` bytes. */
function sized(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes).fill(65)], name);
}

/** A tiny file whose bytes really are a GIF. */
function gif(name: string): File {
  return new File(["GIF89a\x01\x00\x01\x00\x00\x00\x00;"], name, {
    type: "image/gif",
  });
}

/** A tiny file whose bytes really are a PDF. */
function pdf(name: string): File {
  return new File(["%PDF-1.4\n%%EOF\n"], name, { type: "application/pdf" });
}

/** A name, size and sniffed type for each stored file. */
function summarise(files: StorageFile[]): string[] {
  return files.map((file) => {
    return `${file.originalFilename} (${file.size}b, ${file.validatedMimeType?.mime ?? "unrecognised"})`;
  });
}

/**
 * Renders an upload rejection: an `UploadError` with its own status, code and
 * field; anything else (a filter's own throw) as a 400.
 */
const rejectUpload: RouterErrorMiddlewareHandler = (
  error,
  _req,
  res,
  _next,
) => {
  if (error instanceof UploadError) {
    res.status(error.status).json({
      code: error.code,
      field: error.field,
      error: error.message,
    });
    return;
  }
  res.status(400).json({ error: (error as Error).message });
};

/* ------------------------------------------------------------------ */
step("DEFAULT_UPLOAD_OPTIONS and transformUploadOptions");

show("DEFAULT_UPLOAD_OPTIONS", DEFAULT_UPLOAD_OPTIONS);
show(
  "transformUploadOptions() — the defaults, with a storage built",
  transformUploadOptions().storage.constructor.name,
);
show(
  "…{ storageType: 'disk' }",
  transformUploadOptions({ storageType: "disk" }).storage.constructor.name,
);
try {
  transformUploadOptions({ storageType: "custom" } as CustomUploadOptions);
} catch (error) {
  show(
    "…{ storageType: 'custom' } without a storage",
    `${(error as Error).name}: ${(error as Error).message}`,
  );
}
try {
  // Plain JS can pass a kind the types rule out; it throws rather than
  // answering options with no storage.
  transformUploadOptions({ storageType: "s3" } as unknown as UploadOptions);
} catch (error) {
  show(
    "…{ storageType: 's3' }, an unknown kind",
    `${(error as Error).name}: ${(error as Error).message}`,
  );
}

/* ------------------------------------------------------------------ */
step("UploadError: a code, the field and a status");

for (const code of [
  "LIMIT_FILE_SIZE",
  "LIMIT_FILE_COUNT",
  "LIMIT_UNEXPECTED_FILE",
  "FILTER_REJECTED",
] as const) {
  const error = new UploadError(code, { field: "files" });
  show(code, { status: error.status, message: error.message });
}

/* ------------------------------------------------------------------ */
step("getBusBoyConfig: the upload options minus what only storage uses");

const everything = transformUploadOptions({
  storageType: "disk",
  dest: "/tmp/never-written",
  filter: () => true,
  preservePath: true,
  limits: { files: 2 },
});
show("upload option keys", Object.keys(everything));
show("getBusBoyConfig keys", Object.keys(getBusBoyConfig(everything)));

/* ------------------------------------------------------------------ */
step("filter: keep, leave out, or reject");

/** Images are kept, PDFs quietly left out, anything unrecognised rejected. */
const imagesOnly: UploadFilterHandler = (_req, file) => {
  const sniffed = file.validatedMimeType?.mime;
  if (sniffed === undefined) {
    // A string rejects the upload with that message.
    return `${file.originalFilename}: not a recognised file type`;
  }
  // `false` drops just this file.
  return sniffed.startsWith("image/");
};

/** Async filters work too; throwing rejects like returning a string. */
const withinQuota: UploadFilterHandler = async (req, file) => {
  await Bun.sleep(1); // a quota lookup
  const remaining = Number(req.getHeader("x-quota-bytes") ?? Infinity);
  if (file.size > remaining) {
    throw new Error(`${file.originalFilename}: quota exceeded`);
  }
  return true;
};

const router = new BunRouter();
const imageUploads = transformUploadOptions({
  storageType: "memory",
  filter: imagesOnly,
});
const quotaUploads = transformUploadOptions({
  storageType: "memory",
  filter: withinQuota,
});

router.post("/gallery", (async (req, res) => {
  const { files } = await handleMultipartAnyFiles(req, imageUploads);
  res.json({ kept: summarise(files) });
}) satisfies RouterHandler);
router.post("/quota", (async (req, res) => {
  const { files } = await handleMultipartAnyFiles(req, quotaUploads);
  res.json({ kept: summarise(files) });
}) satisfies RouterHandler);
router.use(rejectUpload);

/** POSTs `files` to `path` on `target`, reading back status and body. */
async function post(
  target: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
  path: string,
  files: File[],
  init: {
    headers?: Record<string, string>;
    fields?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: JsonValue }> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  for (const [name, value] of Object.entries(init.fields ?? {})) {
    form.append(name, value);
  }
  const response = await target.fetch(path, {
    method: "POST",
    body: form,
    headers: init.headers,
  });
  const text = await response.text();
  // Either the parsed JSON or, failing that, the text — itself a `JsonValue`.
  let body: JsonValue = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — keep the text.
  }
  return { status: response.status, body };
}

show(
  "a GIF and a PDF",
  await post(router, "/gallery", [gif("cat.gif"), pdf("cv.pdf")]),
);
show(
  "a GIF and a text file that claims to be a PNG",
  await post(router, "/gallery", [
    gif("cat.gif"),
    new File(["not really"], "fake.png", { type: "image/png" }),
  ]),
);
show(
  "within quota",
  await post(router, "/quota", [sized("small.bin", 100)], {
    headers: { "X-Quota-Bytes": "500" },
  }),
);
show(
  "over quota",
  await post(router, "/quota", [sized("big.bin", 1000)], {
    headers: { "X-Quota-Bytes": "500" },
  }),
);

/* ------------------------------------------------------------------ */
step("filterUpload: the same decision, called directly");

router.post("/check", (async (req, res) => {
  const file: StorageFile = {
    size: 12,
    mimetype: "application/pdf",
    encoding: "7bit",
    fieldname: "files",
    originalFilename: "scan.pdf",
    validatedMimeType: { ext: "pdf", mime: "application/pdf" },
  };
  const noFilter = await filterUpload(transformUploadOptions(), req, file);
  const filtered = await filterUpload(imageUploads, req, file);
  res.json({ "without a filter": noFilter, "with imagesOnly": filtered });
}) satisfies RouterHandler);
show("filterUpload(...)", (await post(router, "/check", [])).body);

/* ------------------------------------------------------------------ */
step("busboy limits and maxContentLength, on the request options");

const FILE_SIZE = 1024;

const adapter = new BunHttpAdapter(0, {
  request: {
    parseBody: {
      contentTypes: {
        json: true,
        multipart: {
          // Over this, 413 before routing. Per content type; a top-level
          // `maxContentLength` would cap every kind.
          maxContentLength: "32kb",
          opts: {
            limits: { files: 3, fileSize: FILE_SIZE, fields: 2 },
          },
        },
      },
    },
  },
});

const memory = transformUploadOptions({ storageType: "memory" });

adapter.post("/any", (async (req, res) => {
  const { body, files } = await handleMultipartAnyFiles(req, memory);
  res.json({ fields: body, files: summarise(files) });
}) satisfies RouterHandler);
adapter.post("/two", (async (req, res) => {
  const { files } = await handleMultipartMultipleFiles(req, "files", 2, memory);
  res.json({ files: summarise(files) });
}) satisfies RouterHandler);
adapter.use(rejectUpload);

// busboy's rule decides the edge: `files` and `fields` refuse the one past
// the limit; `fileSize` refuses a file that reaches it.
show(
  "within every limit (3 files under 1024 bytes, 2 fields) — accepted",
  await post(
    adapter,
    "/any",
    [1, 2, 3].map((n) => sized(`f${n}.bin`, 10)),
    { fields: { first: "1", second: "2" } },
  ),
);
show(
  "files: 3 — five files sent: refused, 413 LIMIT_FILE_COUNT",
  await post(
    adapter,
    "/any",
    [1, 2, 3, 4, 5].map((n) => sized(`f${n}.bin`, 10)),
  ),
);
show(
  "fileSize: 1024 — a 4096-byte file: refused, 413 LIMIT_FILE_SIZE, never cut short",
  await post(adapter, "/any", [sized("big.bin", 4096)]),
);
show(
  "fields: 2 — three fields sent: refused, 413 LIMIT_FIELD_COUNT",
  await post(adapter, "/any", [], {
    fields: { first: "1", second: "2", third: "3" },
  }),
);
show(
  "…and the handler's maxCount still applies within the busboy limit",
  await post(
    adapter,
    "/two",
    [1, 2, 3].map((n) => sized(`f${n}.bin`, 10)),
  ),
);
show(
  "maxContentLength: '32kb' — a 64kb body never reaches the route",
  await post(adapter, "/any", [sized("huge.bin", 64 * 1024)]),
);

/* ------------------------------------------------------------------ */
step("busboy limits in the upload options apply too");

const late = transformUploadOptions({
  storageType: "memory",
  limits: { files: 1 },
});
router.post("/late", (async (req, res) => {
  const { files } = await handleMultipartAnyFiles(req, late);
  res.json({ received: files.length });
}) satisfies RouterHandler);
// An error handler sees errors from the routes registered before it.
router.use(rejectUpload);

show(
  "limits: { files: 1 } in the upload options, three files sent: refused",
  await post(
    router,
    "/late",
    [1, 2, 3].map((n) => sized(`f${n}.bin`, 10)),
  ),
);
