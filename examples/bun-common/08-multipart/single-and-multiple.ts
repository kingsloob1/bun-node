/**
 * Multipart uploads — one file, several files on one field, files on named
 * fields, any files, and no files at all.
 *
 * ```bash
 * bun 08-multipart/single-and-multiple.ts
 * ```
 *
 * Each handler takes the request and transformed upload options, stores the
 * files and answers `{ body, file | files, removeFile, removeAll }`:
 *
 * | handler                                             | accepts                 |
 * |-----------------------------------------------------|-------------------------|
 * | `handleMultipartSingleFile(req, field, opts)`       | one file on `field`     |
 * | `handleMultipartMultipleFiles(req, field, n, opts)` | up to `n` on `field`    |
 * | `handleMultipartFileFields(req, map, opts)`         | files on fields in `map`|
 * | `handleMultipartAnyFiles(req, opts)`                | any file on any field   |
 * | `handleNoFiles(req, opts)`                          | fields only             |
 *
 * A file on a field a handler does not accept rejects the whole upload — the
 * handler throws — and whatever was already stored is removed. Text fields end
 * up in `body`, with bracketed names nested (`address[city]`) and repeated
 * names made arrays.
 *
 * Every request is a `FormData` body through `router.fetch()`. Storage here is
 * memory; `storage.ts` covers disk and custom storage.
 */
import type {
  JsonValue,
  RouterHandler,
  StorageFile,
} from "@kingsleyweb/bun-common";
import {
  BunRouter,
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  transformUploadOptions,
  uploadFieldsToMap,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Multipart uploads");

const router = new BunRouter();
const memory = transformUploadOptions({ storageType: "memory" });

/**
 * Runs an upload handler, answering 400 with the message when the upload is
 * rejected. (A router-level error handler works too, but must be registered
 * after the routes it covers.)
 */
function rejectsAs400(handler: RouterHandler): RouterHandler {
  return async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  };
}

/** A tiny file whose bytes really are a GIF — `validatedMimeType` sniffs them. */
function gif(name: string): File {
  return new File(["GIF89a\x01\x00\x01\x00\x00\x00\x00;"], name, {
    type: "image/gif",
  });
}

/** A plain-text file. */
function note(name: string, text = "hello"): File {
  return new File([text], name, { type: "text/plain" });
}

/** What is worth printing about a stored file. */
interface FileSummary {
  /** The form field the file came in on. */
  fieldname: string;
  /** The file name the client sent. */
  originalFilename: string;
  /** The MIME type the client declared. */
  mimetype: string;
  /** The MIME type sniffed from the bytes, or `null` when unrecognised. */
  sniffed: string | null;
  /** Size in bytes. */
  size: number;
}

/** The {@link FileSummary} of a stored file, or `null` for none. */
function describe(file: StorageFile | undefined): FileSummary | null {
  if (!file) {
    return null;
  }
  return {
    fieldname: file.fieldname,
    originalFilename: file.originalFilename,
    mimetype: file.mimetype,
    sniffed: file.validatedMimeType?.mime ?? null,
    size: file.size,
  };
}

/** POSTs a form built by `build` and reads back the status and JSON body. */
async function upload(
  path: string,
  build: (form: FormData) => void,
): Promise<{ status: number; body: JsonValue }> {
  const form = new FormData();
  build(form);
  const response = await router.fetch(path, { method: "POST", body: form });
  return {
    status: response.status,
    body: (await response.json()) as JsonValue,
  };
}

/* ------------------------------------------------------------------ */
step("handleMultipartSingleFile: one file on one field");

router.post(
  "/avatar",
  rejectsAs400(async (req, res) => {
    const { body, file } = await handleMultipartSingleFile(
      req,
      "avatar",
      memory,
    );
    res.json({ body, file: describe(file) });
  }),
);

show(
  "avatar + a text field",
  await upload("/avatar", (form) => {
    form.set("avatar", gif("me.gif"));
    form.set("displayName", "Ada");
  }),
);
show(
  "a file on another field",
  await upload("/avatar", (form) => {
    form.set("banner", gif("banner.gif"));
  }),
);
show(
  "two files on the field — rejected like multer's single(), nothing kept",
  await upload("/avatar", (form) => {
    form.append("avatar", gif("first.gif"));
    form.append("avatar", gif("second.gif"));
  }),
);
show(
  "fields only — file is absent, not an error",
  await upload("/avatar", (form) => {
    form.set("displayName", "Ada");
  }),
);

/* ------------------------------------------------------------------ */
step("handleMultipartMultipleFiles: up to n files on one field");

router.post(
  "/photos",
  rejectsAs400(async (req, res) => {
    const { body, files } = await handleMultipartMultipleFiles(
      req,
      "photos",
      3,
      memory,
    );
    res.json({ body, files: files.map(describe) });
  }),
);

show(
  "three photos",
  await upload("/photos", (form) => {
    for (const n of [1, 2, 3]) {
      form.append("photos", gif(`photo-${n}.gif`));
    }
    form.set("album", "holiday");
  }),
);
show(
  "four photos — one too many",
  await upload("/photos", (form) => {
    for (const n of [1, 2, 3, 4]) {
      form.append("photos", gif(`photo-${n}.gif`));
    }
  }),
);
show(
  "a file on another field",
  await upload("/photos", (form) => {
    form.append("photos", gif("photo.gif"));
    form.append("cover", gif("cover.gif"));
  }),
);

/* ------------------------------------------------------------------ */
step("uploadFieldsToMap + handleMultipartFileFields: files on named fields");

// `maxCount` defaults to 1.
const profileFields = uploadFieldsToMap([
  { name: "avatar" },
  { name: "gallery", maxCount: 4 },
]);
show("uploadFieldsToMap(...)", profileFields);

router.post(
  "/profile",
  rejectsAs400(async (req, res) => {
    const { body, files } = await handleMultipartFileFields(
      req,
      profileFields,
      memory,
    );
    const grouped: Record<string, (FileSummary | null)[]> = {};
    for (const [field, list] of Object.entries(files)) {
      grouped[field] = list.map(describe);
    }
    res.json({ body, files: grouped });
  }),
);

show(
  "an avatar and two gallery images",
  await upload("/profile", (form) => {
    form.set("avatar", gif("me.gif"));
    form.append("gallery", gif("g1.gif"));
    form.append("gallery", gif("g2.gif"));
    form.set("bio", "Mathematician");
  }),
);
show(
  "two avatars",
  await upload("/profile", (form) => {
    form.append("avatar", gif("a.gif"));
    form.append("avatar", gif("b.gif"));
  }),
);
show(
  "a field not in the map",
  await upload("/profile", (form) => {
    form.set("resume", note("cv.txt"));
  }),
);

/* ------------------------------------------------------------------ */
step("handleMultipartAnyFiles: whatever arrives");

router.post(
  "/anything",
  rejectsAs400(async (req, res) => {
    const { body, files } = await handleMultipartAnyFiles(req, memory);
    res.json({ body, files: files.map(describe) });
  }),
);

show(
  "files on three fields",
  await upload("/anything", (form) => {
    form.set("logo", gif("logo.gif"));
    form.append("attachments", note("a.txt", "first"));
    form.append("attachments", note("b.txt", "second"));
    // A Blob without a type arrives as application/octet-stream.
    form.set("raw", new Blob([new Uint8Array([1, 2, 3])]), "raw.bin");
  }),
);

/* ------------------------------------------------------------------ */
step("handleNoFiles: a form that must not carry files");

router.post(
  "/contact",
  rejectsAs400(async (req, res) => {
    const { body, files } = await handleNoFiles(req, memory);
    res.json({ body, fileCount: files.length });
  }),
);

show(
  "fields, nested and repeated",
  await upload("/contact", (form) => {
    form.set("name", "Ada");
    form.set("address[city]", "London");
    form.set("address[postcode]", "N1");
    form.append("topics", "billing");
    form.append("topics", "support");
    form.set("preferences", JSON.stringify({ newsletter: true }));
  }),
);
show(
  "a file sneaks in",
  await upload("/contact", (form) => {
    form.set("name", "Mallory");
    form.set("payload", note("payload.txt"));
  }),
);

/* ------------------------------------------------------------------ */
step("removeFile and removeAll: releasing what was stored");

router.post(
  "/scratch",
  rejectsAs400(async (req, res) => {
    const stored = await handleMultipartAnyFiles(req, memory);
    const [first] = stored.files;

    if (first) {
      await stored.removeFile(first);
    }
    const afterOne = stored.files.map((file) => "buffer" in file);

    await stored.removeAll();
    const afterAll = stored.files.map((file) => "buffer" in file);

    res.json({
      stored: stored.files.length,
      "holding bytes after removeFile(first)": afterOne,
      "holding bytes after removeAll()": afterAll,
    });
  }),
);

show(
  "memory storage drops the buffers",
  await upload("/scratch", (form) => {
    form.append("files", note("one.txt"));
    form.append("files", note("two.txt"));
  }),
);
