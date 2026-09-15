/**
 * Option tour: `UploadOptions`, `MultiPartOptions` and busboy's config, every
 * multipart handler, storage and filter — each asserted.
 *
 * ```bash
 * bun 12-options/multipart-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - The body is parsed **when the request is built**, with the request's
 *   `parseBody.contentTypes.multipart.opts`. That is where busboy's `limits`,
 *   `preservePath` and the `inflate` options take effect, so each check here
 *   builds its own request with `BunRequest.init`.
 * - busboy limits refuse the upload, as multer does: the parse rejects with an
 *   `UploadError` (a `LIMIT_*` code, status 413) and nothing truncated is ever
 *   resolved. busboy's own rule decides the edge: `files` and `fields` refuse
 *   the one past the limit; `parts`, `fileSize` and `fieldSize` refuse on
 *   reaching it. `maxContentLength` refuses the whole body, as 413, before
 *   parsing.
 * - A handler rejects with an `UploadError`: multer's `code`, the `field` it
 *   concerns and an HTTP `status`, keeping the readable message. Files it had
 *   already stored are removed with `force`. A file the filter leaves out is
 *   removed too.
 * - Disk writes go to a fresh directory under `os.tmpdir()`, removed at the end.
 */
import type {
  CustomUploadOptions,
  DiskStorageFile,
  MemoryStorageFile,
  MultiPartFileRecord,
  MultiPartOptions,
  RawMultiPartFields,
  Storage,
  StorageFile,
  UploadErrorCode,
  UploadFilterFile,
  UploadOptions,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunRequest,
  DEFAULT_UPLOAD_OPTIONS,
  DiskStorage,
  FETCH_STUB_SERVER,
  filterUpload,
  getBusBoyConfig,
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  MemoryStorage,
  removeStorageFiles,
  transformUploadOptions,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
  uploadFieldsToMap,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

/** An upload rejection's `code`, `field` and `status`, for comparing. */
function uploadDetails(
  error: Error | undefined,
): [UploadErrorCode, string | undefined, number] | Error | undefined {
  return error instanceof UploadError
    ? [error.code, error.field, error.status]
    : error;
}

/** Request-level parsing options for {@link formRequest}. */
interface FormRequestOptions {
  /** busboy and inflate options for the multipart parser. */
  multipart?: MultiPartOptions;
  /** Body size cap, in bytes or as `"1kb"`. */
  maxContentLength?: number | string;
  /** Request headers to add. */
  headers?: Record<string, string>;
}

/** One `removeFile` call a {@link SpyStorage} received. */
interface RemoveCall {
  /** The original filename of the file removed. */
  name: string;
  /** The `force` argument. */
  force: boolean | undefined;
}

title("Option tour: multipart uploads");

const scratch = await mkdtemp(join(tmpdir(), "bun-common-multipart-tour-"));
const GIF_BYTES = "GIF89a\x01\x00\x01\x00\x00\x00\x00;";

/** A tiny file whose bytes really are a GIF. */
function gif(name: string): File {
  return new File([GIF_BYTES], name, { type: "image/gif" });
}

/** A text file. */
function text(name: string, content = "hello"): File {
  return new File([content], name, { type: "text/plain" });
}

/** Builds a multipart request, parsed with the given request-level options. */
async function formRequest(
  build: (form: FormData) => void,
  options: FormRequestOptions = {},
): Promise<BunRequest> {
  const form = new FormData();
  build(form);
  return await BunRequest.init(
    new Request("http://localhost/upload", {
      method: "POST",
      body: form,
      headers: options.headers,
    }),
    FETCH_STUB_SERVER,
    {
      parseBody: {
        maxContentLength: options.maxContentLength,
        contentTypes: { multipart: { opts: options.multipart ?? {} } },
      },
      parseCookies: false,
      parseQuery: false,
    },
  );
}

/** A storage that keeps files in memory and records every removal. */
class SpyStorage implements Storage {
  /** Every `removeFile` call, in order. */
  readonly removed: RemoveCall[] = [];

  /** Files stored so far. */
  readonly stored: StorageFile[] = [];

  async handleFile(record: MultiPartFileRecord): Promise<StorageFile> {
    const file: StorageFile = {
      size: record.file.length,
      mimetype: record.mimeType,
      encoding: record.encoding,
      fieldname: record.fieldname,
      originalFilename: record.filename,
      validatedMimeType: record.validatedMimeType,
    };
    this.stored.push(file);
    return file;
  }

  removeFile(file: StorageFile, force?: boolean): void {
    this.removed.push({ name: file.originalFilename, force });
  }
}

/** A synthetic parsed file record, for calling storages directly. */
function record(
  filename: string,
  content: string,
  fieldname = "doc",
): MultiPartFileRecord {
  return {
    filename,
    encoding: "7bit",
    mimeType: "text/plain",
    fieldname,
    originalFilename: filename,
    validatedMimeType: undefined,
    file: Buffer.from(content),
    type: "file",
  };
}

const memory = transformUploadOptions({ storageType: "memory" });

/* ------------------------------------------------------------------ */
step("DEFAULT_UPLOAD_OPTIONS and transformUploadOptions");

checkEqual("DEFAULT_UPLOAD_OPTIONS", DEFAULT_UPLOAD_OPTIONS, {
  storageType: "memory",
});
const defaults = transformUploadOptions();
check("no options: a MemoryStorage", defaults.storage instanceof MemoryStorage);
checkEqual("…and storageType memory", defaults.storageType, "memory");
check("memory: a MemoryStorage", memory.storage instanceof MemoryStorage);
const disk = transformUploadOptions({
  storageType: "disk",
  dest: join(scratch, "d"),
});
check("disk: a DiskStorage", disk.storage instanceof DiskStorage);
checkEqual(
  "…constructed with the upload options, dest included",
  (disk.storage as DiskStorage).options?.dest,
  join(scratch, "d"),
);
const diskEverything = transformUploadOptions({
  storageType: "disk",
  dest: (file) => join(scratch, "by-field", file.fieldname),
  filename: "fixed.txt",
  removeAfter: true,
});
checkEqual(
  "disk: filename, removeAfter and a function dest reach the DiskStorage",
  [
    typeof (diskEverything.storage as DiskStorage).options?.dest,
    (diskEverything.storage as DiskStorage).options?.filename,
    (diskEverything.storage as DiskStorage).options?.removeAfter,
  ],
  ["function", "fixed.txt", true],
);
const keepingMemory = transformUploadOptions({
  storageType: "memory",
  removeAfter: false,
});
checkEqual(
  "memory: removeAfter reaches the MemoryStorage",
  (keepingMemory.storage as MemoryStorage).options,
  { removeAfter: false },
);
const spy = new SpyStorage();
check(
  "custom: the storage given",
  transformUploadOptions({ storageType: "custom", storage: spy }).storage ===
    spy,
);
await checkRejects(
  "custom without a storage: a TypeError",
  () =>
    transformUploadOptions({ storageType: "custom" } as CustomUploadOptions),
  { name: "TypeError", message: /requires a storage handler/ },
);
await checkRejects(
  "an unknown storageType (plain JS): a TypeError, not options without a storage",
  () =>
    transformUploadOptions({ storageType: "s3" } as unknown as UploadOptions),
  {
    name: "TypeError",
    message:
      /^Unknown upload storageType "s3": expected "disk", "memory" or "custom"$/,
  },
);
check(
  "every storageType answers a storage",
  [defaults, memory, disk].every((options) => options.storage !== undefined),
);
const keepFilter = () => true;
const carried = transformUploadOptions({
  storageType: "memory",
  filter: keepFilter,
  limits: { files: 1 },
});
check(
  "other options are carried through",
  carried.filter === keepFilter && carried.limits?.files === 1,
);

/* ------------------------------------------------------------------ */
step("getBusBoyConfig");

const busboyConfig = getBusBoyConfig(
  transformUploadOptions({
    storageType: "disk",
    dest: "/nowhere",
    filename: "x.txt",
    removeAfter: true,
    filter: keepFilter,
    limits: { fileSize: 10 },
    preservePath: true,
    defParamCharset: "utf8",
    inflate: false,
  }),
);
checkEqual(
  "storageType, filter, storage, dest, filename and removeAfter are removed",
  [
    "storageType",
    "filter",
    "storage",
    "dest",
    "filename",
    "removeAfter",
  ].filter((key) => key in busboyConfig),
  [],
);
// `getBusBoyConfig` answers busboy's config, which here still carries the
// multipart options (`inflate`) — so compare as `MultiPartOptions`.
checkEqual<MultiPartOptions>("everything else is kept", busboyConfig, {
  limits: { fileSize: 10 },
  preservePath: true,
  defParamCharset: "utf8",
  inflate: false,
});

/* ------------------------------------------------------------------ */
step("uploadFieldsToMap");

const fieldMap = uploadFieldsToMap([
  { name: "avatar" },
  { name: "gallery", maxCount: 3 },
]);
checkEqual("maxCount defaults to 1", fieldMap.get("avatar"), { maxCount: 1 });
checkEqual("…or is what was given, without the name", fieldMap.get("gallery"), {
  maxCount: 3,
});
checkEqual("keyed by field name", [...fieldMap.keys()], ["avatar", "gallery"]);

/* ------------------------------------------------------------------ */
step("handleMultipartSingleFile");

const single = await handleMultipartSingleFile(
  await formRequest((form) => {
    form.set("avatar", gif("me.gif"));
    form.set("name", "Ada");
  }),
  "avatar",
  memory,
);
const avatar = single.file as MemoryStorageFile | undefined;
checkEqual(
  "the stored file",
  [
    avatar?.type,
    avatar?.fieldname,
    avatar?.originalFilename,
    avatar?.mimetype,
    avatar?.size,
  ],
  ["memory", "avatar", "me.gif", "image/gif", GIF_BYTES.length],
);
checkEqual("encoding", avatar?.encoding, "7bit");
checkEqual(
  "validatedMimeType is sniffed from the bytes",
  avatar?.validatedMimeType,
  { ext: "gif", mime: "image/gif" },
);
checkEqual(
  "buffer holds the bytes",
  avatar?.buffer.toString("latin1"),
  GIF_BYTES,
);
checkEqual("fields are the body", single.body, { name: "Ada" });
checkEqual(
  "no file: undefined, not an error",
  (
    await handleMultipartSingleFile(
      await formRequest((form) => form.set("name", "Ada")),
      "avatar",
      memory,
    )
  ).file,
  undefined,
);
const singleForeign = await checkRejects(
  "a file on another field",
  async () =>
    handleMultipartSingleFile(
      await formRequest((form) => form.set("cover", gif("c.gif"))),
      "avatar",
      memory,
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Only Field avatar accept one file$/,
  },
);
checkEqual(
  "…field names the foreign field, status 400",
  uploadDetails(singleForeign),
  ["LIMIT_UNEXPECTED_FILE", "cover", 400],
);
const twiceSpy = new SpyStorage();
const singleTwice = await checkRejects(
  "two files on the field — rejected, as multer's single()",
  async () =>
    handleMultipartSingleFile(
      await formRequest((form) => {
        form.append("avatar", gif("1.gif"));
        form.append("avatar", gif("2.gif"));
      }),
      "avatar",
      transformUploadOptions({ storageType: "custom", storage: twiceSpy }),
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Only Field avatar accept one file$/,
  },
);
checkEqual("…field names the handler's own field", uploadDetails(singleTwice), [
  "LIMIT_UNEXPECTED_FILE",
  "avatar",
  400,
]);
checkEqual("…before anything was stored", twiceSpy.stored.length, 0);

/* ------------------------------------------------------------------ */
step("handleMultipartMultipleFiles");

const two = await handleMultipartMultipleFiles(
  await formRequest((form) => {
    form.append("photos", gif("1.gif"));
    form.append("photos", gif("2.gif"));
  }),
  "photos",
  2,
  memory,
);
checkEqual(
  "up to maxCount",
  two.files.map((file) => file.originalFilename).sort(),
  ["1.gif", "2.gif"],
);
const overSpy = new SpyStorage();
const overCount = await checkRejects(
  "over maxCount",
  async () =>
    handleMultipartMultipleFiles(
      await formRequest((form) => {
        for (const n of [1, 2, 3]) {
          form.append("photos", text(`${n}.txt`));
        }
      }),
      "photos",
      2,
      transformUploadOptions({ storageType: "custom", storage: overSpy }),
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Field photos accepts max 2 files$/,
  },
);
checkEqual(
  "…multer's code for an extra file, on the field, status 400",
  uploadDetails(overCount),
  ["LIMIT_UNEXPECTED_FILE", "photos", 400],
);
checkEqual(
  "…every stored file removed, with force",
  overSpy.removed.map((call) => call.force),
  [true, true, true],
);
const multipleForeign = await checkRejects(
  "a file on another field",
  async () =>
    handleMultipartMultipleFiles(
      await formRequest((form) => {
        form.append("photos", text("1.txt"));
        form.append("cover", text("c.txt"));
      }),
      "photos",
      5,
      memory,
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Only Field photos accept files$/,
  },
);
checkEqual("…field names the foreign field", uploadDetails(multipleForeign), [
  "LIMIT_UNEXPECTED_FILE",
  "cover",
  400,
]);

/* ------------------------------------------------------------------ */
step("handleMultipartFileFields");

const grouped = await handleMultipartFileFields(
  await formRequest((form) => {
    form.set("avatar", gif("a.gif"));
    form.append("gallery", gif("g1.gif"));
    form.append("gallery", gif("g2.gif"));
    form.set("bio", "hi");
  }),
  fieldMap,
  memory,
);
checkEqual(
  "files grouped by field",
  Object.fromEntries(
    Object.entries(grouped.files).map(([field, list]) => [field, list.length]),
  ),
  { avatar: 1, gallery: 2 },
);
checkEqual("fields are the body", grouped.body, { bio: "hi" });
const unmapped = await checkRejects(
  "a field not in the map",
  async () =>
    handleMultipartFileFields(
      await formRequest((form) => form.set("resume", text("cv.txt"))),
      fieldMap,
      memory,
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Field resume doesn't accept files$/,
  },
);
checkEqual("…on that field", uploadDetails(unmapped), [
  "LIMIT_UNEXPECTED_FILE",
  "resume",
  400,
]);
const fieldOverCount = await checkRejects(
  "over a field's maxCount",
  async () =>
    handleMultipartFileFields(
      await formRequest((form) => {
        form.append("avatar", gif("a.gif"));
        form.append("avatar", gif("b.gif"));
      }),
      fieldMap,
      memory,
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^Field avatar accepts max 1 files$/,
  },
);
checkEqual("…on that field", uploadDetails(fieldOverCount), [
  "LIMIT_UNEXPECTED_FILE",
  "avatar",
  400,
]);

/* ------------------------------------------------------------------ */
step("handleMultipartAnyFiles and handleNoFiles");

const anyFiles = await handleMultipartAnyFiles(
  await formRequest((form) => {
    form.set("a", text("a.txt"));
    form.set("b", text("b.txt"));
    form.set("note", "x");
  }),
  memory,
);
checkEqual(
  "any field, any number",
  anyFiles.files.map((file) => file.fieldname).sort(),
  ["a", "b"],
);
const noFiles = await handleNoFiles(
  await formRequest((form) => form.set("name", "Ada")),
  memory,
);
checkEqual(
  "handleNoFiles: body, an empty files list, no expandedFiles",
  [noFiles.body, noFiles.files, noFiles.expandedFiles],
  [{ name: "Ada" }, [], undefined],
);
const noneWithFile = await checkRejects(
  "handleNoFiles with a file",
  async () =>
    handleNoFiles(
      await formRequest((form) => form.set("f", text("f.txt"))),
      memory,
    ),
  {
    name: "UploadError",
    code: "LIMIT_UNEXPECTED_FILE",
    message: /^File upload is not accepted$/,
  },
);
checkEqual("…naming the file's field", uploadDetails(noneWithFile), [
  "LIMIT_UNEXPECTED_FILE",
  "f",
  400,
]);

/* ------------------------------------------------------------------ */
step("removeFile and removeAll");

const releasing = await handleMultipartAnyFiles(
  await formRequest((form) => {
    form.append("f", text("1.txt"));
    form.append("f", text("2.txt"));
  }),
  memory,
);
const [firstReleased] = releasing.files;
await releasing.removeFile(firstReleased!);
checkEqual(
  "removeFile(file): that file's buffer is dropped",
  releasing.files.map((file) => "buffer" in file),
  [false, true],
);
await releasing.removeAll();
checkEqual(
  "removeAll(): every buffer",
  releasing.files.map((file) => "buffer" in file),
  [false, false],
);

/* ------------------------------------------------------------------ */
step("filter and filterUpload");

const droppedSpy = new SpyStorage();
const dropping = await handleMultipartAnyFiles(
  await formRequest((form) => {
    form.append("f", text("keep.txt"));
    form.append("f", text("drop.txt"));
  }),
  transformUploadOptions({
    storageType: "custom",
    storage: droppedSpy,
    filter: (_req, file) => file.originalFilename === "keep.txt",
  }),
);
checkEqual(
  "false: the file left out is removed from storage, with force",
  [dropping.files.map((file) => file.originalFilename), droppedSpy.removed],
  [["keep.txt"], [{ name: "drop.txt", force: true }]],
);
const filterSaw: { name: string; hasRequest: boolean }[] = [];
const filtered = await handleMultipartAnyFiles(
  await formRequest((form) => {
    form.append("f", gif("keep.gif"));
    form.append("f", text("drop.txt"));
  }),
  transformUploadOptions({
    storageType: "memory",
    filter: (req, file) => {
      filterSaw.push({
        name: file.originalFilename,
        hasRequest: req instanceof BunRequest,
      });
      return file.validatedMimeType !== undefined;
    },
  }),
);
checkEqual(
  "true keeps, false drops",
  filtered.files.map((file) => file.originalFilename),
  ["keep.gif"],
);
checkEqual(
  "the filter sees the request and every stored file",
  filterSaw.map((seen) => [seen.name, seen.hasRequest]).sort(),
  [
    ["drop.txt", true],
    ["keep.gif", true],
  ],
);

const rejectSpy = new SpyStorage();
const filterRejected = await checkRejects(
  "a string rejects with that message",
  async () =>
    handleMultipartAnyFiles(
      await formRequest((form) => form.set("f", text("bad.txt"))),
      transformUploadOptions({
        storageType: "custom",
        storage: rejectSpy,
        filter: () => "not allowed",
      }),
    ),
  { name: "UploadError", code: "FILTER_REJECTED", message: /^not allowed$/ },
);
checkEqual(
  "…as FILTER_REJECTED on the file's field",
  uploadDetails(filterRejected),
  ["FILTER_REJECTED", "f", 400],
);
checkEqual("…removing the file with force", rejectSpy.removed, [
  { name: "bad.txt", force: true },
]);
await checkRejects(
  "a throw rejects too",
  async () =>
    handleMultipartAnyFiles(
      await formRequest((form) => form.set("f", text("bad.txt"))),
      transformUploadOptions({
        storageType: "memory",
        filter: async () => {
          throw new TypeError("filter blew up");
        },
      }),
    ),
  { name: "TypeError", message: /filter blew up/ },
);

const directRequest = await formRequest(() => {});
const candidate: UploadFilterFile = {
  size: 1,
  mimetype: "text/plain",
  encoding: "7bit",
  fieldname: "f",
  originalFilename: "x.txt",
  validatedMimeType: undefined,
};
checkEqual(
  "filterUpload without a filter: true",
  await filterUpload(memory, directRequest, candidate),
  true,
);
checkEqual(
  "filterUpload coerces a truthy answer to true",
  await filterUpload(
    transformUploadOptions({
      storageType: "memory",
      // Plain JS may answer any truthy value; the types allow only
      // `boolean | string`, so the cast goes through `unknown`.
      filter: () => 1 as unknown as boolean,
    }),
    directRequest,
    candidate,
  ),
  true,
);
checkEqual(
  "…and false stays false",
  await filterUpload(
    transformUploadOptions({ storageType: "memory", filter: () => false }),
    directRequest,
    candidate,
  ),
  false,
);

/* ------------------------------------------------------------------ */
step("UploadError: codes, field, status");

const tooLargeCodes: UploadErrorCode[] = [
  "LIMIT_PART_COUNT",
  "LIMIT_FILE_SIZE",
  "LIMIT_FILE_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
];
checkEqual(
  "size and count limits: 413",
  tooLargeCodes.map((code) => new UploadError(code).status),
  [413, 413, 413, 413, 413, 413],
);
checkEqual(
  "everything else: 400",
  (
    ["LIMIT_UNEXPECTED_FILE", "MISSING_FIELD_NAME", "FILTER_REJECTED"] as const
  ).map((code) => new UploadError(code).status),
  [400, 400, 400],
);
const sized = new UploadError("LIMIT_FILE_SIZE", { field: "avatar" });
checkEqual(
  "multer's message by default; statusCode mirrors status; expose is true",
  [sized.message, sized.statusCode, sized.expose, sized.field, sized.name],
  ["File too large", 413, true, "avatar", "UploadError"],
);
checkEqual(
  "UPLOAD_ERROR_MESSAGES holds those defaults",
  UPLOAD_ERROR_MESSAGES.LIMIT_UNEXPECTED_FILE,
  "Unexpected field",
);

/* ------------------------------------------------------------------ */
step("MemoryStorage");

await checkRejects(
  "handleFile refuses a record that is not a file",
  () =>
    // A field record where a file is expected, as plain JS could pass; its
    // `type` contradicts `MultiPartFileRecord`, so the cast needs `unknown`.
    new MemoryStorage().handleFile({
      ...record("x.txt", "x"),
      type: "field",
    } as unknown as MultiPartFileRecord),
  { message: /^Only file record can be handled by this method$/ },
);
const memoryFile = await new MemoryStorage().handleFile(
  record("m.txt", "memory"),
);
checkEqual(
  "handleFile keeps the bytes",
  [memoryFile.type, memoryFile.buffer.toString(), memoryFile.size],
  ["memory", "memory", 6],
);
const holder = { nested: memoryFile };
await new MemoryStorage().removeFile(holder);
checkEqual(
  "removeFile also finds files inside an object",
  "buffer" in memoryFile,
  false,
);
const keeping = new MemoryStorage({ removeAfter: false });
const keptFile = await keeping.handleFile(record("k.txt", "kept"));
await keeping.removeFile(keptFile);
checkEqual(
  "removeAfter: false — removeFile is a no-op",
  "buffer" in keptFile,
  true,
);
await keeping.removeFile(keptFile, true);
checkEqual("…unless forced", "buffer" in keptFile, false);

/* ------------------------------------------------------------------ */
step("DiskStorage: dest, filename, removeAfter");

const req = await formRequest(() => {});
req.params = { userId: "u1" };

const randomName = (await new DiskStorage({
  dest: join(scratch, "random"),
}).handleFile(record("report.txt", "abc"), req)) as DiskStorageFile;
check(
  "filename unset: 32 hex characters plus the extension",
  /^[0-9a-f]{32}\.txt$/.test(randomName.filename ?? ""),
  randomName.filename,
);
checkEqual(
  "the stored file",
  [
    randomName.type,
    randomName.originalFilename,
    randomName.size,
    randomName.path === join(randomName.dest ?? "", randomName.filename ?? ""),
  ],
  ["disk", "report.txt", 3, true],
);
checkEqual("…is on disk", await Bun.file(randomName.path).text(), "abc");

const destSaw: string[] = [];
const functional = new DiskStorage({
  dest: (file, request) => {
    destSaw.push(`${file.fieldname}:${request.params.userId}`);
    return join(scratch, "users", request.params.userId ?? "", "deep");
  },
  filename: (file) => `renamed-${file.filename}`,
});
const functionalFile = (await functional.handleFile(
  record("cv.txt", "cv"),
  req,
)) as DiskStorageFile;
checkEqual(
  "dest as a function, created recursively",
  functionalFile.dest,
  join(scratch, "users", "u1", "deep"),
);
checkEqual("…called with the record and the request", destSaw, ["doc:u1"]);
checkEqual("filename as a function", functionalFile.filename, "renamed-cv.txt");

const fixed = new DiskStorage({
  dest: join(scratch, "fixed"),
  filename: "latest.txt",
});
await fixed.handleFile(record("a.txt", "first"), req);
const second = (await fixed.handleFile(
  record("b.txt", "second"),
  req,
)) as DiskStorageFile;
checkEqual(
  "filename as a string: the same name every time",
  await Bun.file(second.path).text(),
  "second",
);

await functional.removeFile(functionalFile);
checkEqual(
  "removeAfter unset: removeFile is a no-op",
  await Bun.file(functionalFile.path).exists(),
  true,
);
await functional.removeFile(functionalFile, true);
checkEqual(
  "…unless forced",
  await Bun.file(functionalFile.path).exists(),
  false,
);
const autoRemove = new DiskStorage({
  dest: join(scratch, "auto"),
  removeAfter: true,
});
const autoFile = (await autoRemove.handleFile(
  record("tmp.txt", "tmp"),
  req,
)) as DiskStorageFile;
await autoRemove.removeFile(autoFile);
checkEqual(
  "removeAfter: true — removeFile deletes",
  await Bun.file(autoFile.path).exists(),
  false,
);
await autoRemove.removeFile(autoFile);
check("removing a file already gone is harmless", true);

const nestedA = (await autoRemove.handleFile(
  record("n1.txt", "1"),
  req,
)) as DiskStorageFile;
const nestedB = (await autoRemove.handleFile(
  record("n2.txt", "2"),
  req,
)) as DiskStorageFile;
await autoRemove.removeFile({ group: { list: [nestedA, nestedB] } });
checkEqual(
  "removeFile on an object resolves once every nested file is gone",
  [
    await Bun.file(nestedA.path).exists(),
    await Bun.file(nestedB.path).exists(),
  ],
  [false, false],
);

const defaultDest = (await new DiskStorage().handleFile(
  record("tmp.txt", "x"),
  req,
)) as DiskStorageFile;
checkEqual("dest unset: the OS temp directory", defaultDest.dest, tmpdir());
await new DiskStorage().removeFile(defaultDest, true);

/* ------------------------------------------------------------------ */
step("removeStorageFiles");

const bulkSpy = new SpyStorage();
const a = await bulkSpy.handleFile(record("a.txt", "a"));
const b = await bulkSpy.handleFile(record("b.txt", "b"));
await removeStorageFiles(bulkSpy, [a, undefined, b], true);
checkEqual("each defined file, with force", bulkSpy.removed, [
  { name: "a.txt", force: true },
  { name: "b.txt", force: true },
]);
await removeStorageFiles(bulkSpy, undefined);
checkEqual("no list: nothing", bulkSpy.removed.length, 2);
await removeStorageFiles(bulkSpy, [a]);
checkEqual(
  "force defaults to undefined",
  bulkSpy.removed.at(-1)?.force,
  undefined,
);

/* ------------------------------------------------------------------ */
step("MultiPartOptions: inflate, fieldInflator, fileInflator");

/**
 * Fields a form with nested and repeated names parses to. With
 * `inflate: false` they are the raw strings, as multer reports them.
 */
function fieldsWith(
  multipart: MultiPartOptions & { inflate: false },
): Promise<RawMultiPartFields>;
/**
 * …and otherwise what the (default or custom) inflator produced: client data
 * nothing has validated, hence `unknown` values, as the handler types it.
 */
function fieldsWith(
  multipart: MultiPartOptions,
): Promise<Record<string, unknown>>;
async function fieldsWith(
  multipart: MultiPartOptions,
): Promise<Record<string, unknown>> {
  const request = await formRequest(
    (form) => {
      form.set("address[city]", "London");
      form.append("tags", "a");
      form.append("tags", "b");
    },
    { multipart },
  );
  return (await handleNoFiles(request, memory)).body;
}

checkEqual(
  "inflate (default): brackets nest, repeats become arrays",
  await fieldsWith({}),
  {
    address: { city: "London" },
    tags: ["a", "b"],
  },
);
const flat = await fieldsWith({ inflate: false });
checkEqual("inflate: false — names kept as sent", Object.keys(flat).sort(), [
  "address[city]",
  "tags",
]);
checkEqual("…repeats still gathered into an array", flat.tags, ["a", "b"]);

const inflatorCalls: string[] = [];
checkEqual(
  "fieldInflator replaces the default field parsing",
  await fieldsWith({
    fieldInflator: async (fieldname, value) => {
      inflatorCalls.push(fieldname);
      return { [fieldname.toUpperCase()]: value.toUpperCase() };
    },
  }),
  { "ADDRESS[CITY]": "LONDON", "TAGS[0]": "A", "TAGS[1]": "B" },
);
check(
  "…called per value, repeats with an index",
  inflatorCalls.includes("tags[0]") && inflatorCalls.includes("tags[1]"),
  inflatorCalls,
);

const fileInflatorCalls: string[] = [];
const inflatedFiles = await handleMultipartAnyFiles(
  await formRequest((form) => form.set("docs[passport]", text("p.txt")), {
    multipart: {
      fileInflator: async (fieldname, file) => {
        fileInflatorCalls.push(fieldname);
        return { [fieldname]: file };
      },
    },
  }),
  memory,
);
checkEqual("fileInflator is called per file", fileInflatorCalls, [
  "docs[passport]",
]);
checkEqual(
  "…and the file is still stored under its field name",
  inflatedFiles.files[0]?.fieldname,
  "docs[passport]",
);

/* ------------------------------------------------------------------ */
step("busboy options: limits and preservePath");

/**
 * Files and fields handleMultipartAnyFiles returns for a request built with
 * `multipart`. `body` keeps the handler's `Record<string, unknown>`: inflated
 * client fields nothing has validated.
 */
async function parsedWith(
  multipart: MultiPartOptions,
  build: (form: FormData) => void,
): Promise<{ files: StorageFile[]; body: Record<string, unknown> }> {
  const { files, body } = await handleMultipartAnyFiles(
    await formRequest(build, { multipart }),
    memory,
  );
  return { files, body };
}

/** `files` text files named `1.txt`, `2.txt`, … on field `f`. */
function textFiles(files: number): (form: FormData) => void {
  return (form) => {
    for (let n = 1; n <= files; n++) {
      form.append("f", text(`${n}.txt`));
    }
  };
}

/** The `field` and `status` of an `UploadError`; `undefined` for anything else. */
function uploadErrorDetails(
  error: Error | undefined,
): { field: string | undefined; status: number } | undefined {
  return error instanceof UploadError
    ? { field: error.field, status: error.status }
    : undefined;
}

await checkRejects(
  "limits.files: a file past the limit refuses the upload, 413",
  () => parsedWith({ limits: { files: 2 } }, textFiles(4)),
  { name: "UploadError", code: "LIMIT_FILE_COUNT" },
);
checkEqual(
  "…exactly `files` files are accepted",
  (await parsedWith({ limits: { files: 2 } }, textFiles(2))).files.length,
  2,
);

const sizeRefused = await checkRejects(
  "limits.fileSize: a file reaching it is refused, never cut short",
  () =>
    parsedWith({ limits: { fileSize: 4 } }, (form) => {
      form.set("f", text("long.txt", "0123456789"));
    }),
  { name: "UploadError", code: "LIMIT_FILE_SIZE" },
);
checkEqual(
  "…naming the file's field, with status 413",
  uploadErrorDetails(sizeRefused),
  { field: "f", status: 413 },
);

await checkRejects(
  "limits.fields: a field past the limit refuses the upload",
  () =>
    parsedWith({ limits: { fields: 1 } }, (form) => {
      form.set("one", "1");
      form.set("two", "2");
    }),
  { name: "UploadError", code: "LIMIT_FIELD_COUNT" },
);

await checkRejects(
  "limits.parts: fields and files together, refused on reaching it",
  () =>
    parsedWith({ limits: { parts: 2 } }, (form) => {
      form.set("one", "1");
      form.set("f", text("f.txt"));
      form.set("two", "2");
    }),
  { name: "UploadError", code: "LIMIT_PART_COUNT" },
);

const valueRefused = await checkRejects(
  "limits.fieldSize: a value reaching it is refused, never cut short",
  () =>
    parsedWith({ limits: { fieldSize: 3 } }, (form) => {
      form.set("word", "abcdef");
    }),
  { name: "UploadError", code: "LIMIT_FIELD_VALUE" },
);
checkEqual(
  "…naming the field, with status 413",
  uploadErrorDetails(valueRefused),
  { field: "word", status: 413 },
);

await checkRejects(
  "limits.fieldNameSize: a name over it is refused (checked by hand, as multer)",
  () =>
    parsedWith({ limits: { fieldNameSize: 3 } }, (form) => {
      form.set("toolong", "1");
    }),
  { name: "UploadError", code: "LIMIT_FIELD_KEY" },
);

/** Adds one file whose name carries a directory path. */
function withPath(form: FormData): void {
  form.set("f", new File(["x"], "dir/sub/a.txt"));
}
const plainPath = await parsedWith({}, withPath);
const keptPath = await parsedWith({ preservePath: true }, withPath);
checkEqual(
  "preservePath: false (default) keeps the base name; true keeps the path",
  [plainPath.files[0]?.originalFilename, keptPath.files[0]?.originalFilename],
  ["a.txt", "dir/sub/a.txt"],
);

/* ------------------------------------------------------------------ */
step("maxContentLength: the body is refused before parsing");

const tooBig = await formRequest(
  (form) => form.set("f", text("big.txt", "x".repeat(4096))),
  {
    maxContentLength: "1kb",
  },
);
checkEqual("isPayloadTooLarge", tooBig.isPayloadTooLarge, true);
checkEqual("…with the limit", tooBig.payloadTooLarge?.limit, 1024);
checkEqual(
  "payloadTooLargeResponse is a 413",
  BunRequest.payloadTooLargeResponse(tooBig).status,
  413,
);
const fits = await formRequest((form) => form.set("f", text("small.txt")), {
  maxContentLength: "1kb",
});
checkEqual(
  "a body within the cap parses",
  [
    fits.isPayloadTooLarge,
    (await handleMultipartAnyFiles(fits, memory)).files.length,
  ],
  [false, 1],
);

/* ------------------------------------------------------------------ */
step("busboy options in the upload options (after the body was parsed)");

// The buffered body is re-parsed with these merged over the request's own.
const lateRequest = await formRequest(textFiles(3));
await checkRejects(
  "limits: { files: 1 } in the upload options — three files refused",
  () =>
    handleMultipartAnyFiles(
      lateRequest,
      transformUploadOptions({ storageType: "memory", limits: { files: 1 } }),
    ),
  { name: "UploadError", code: "LIMIT_FILE_COUNT" },
);
checkEqual(
  "…while the same request within the limit is still accepted",
  (
    await handleMultipartAnyFiles(
      lateRequest,
      transformUploadOptions({ storageType: "memory", limits: { files: 3 } }),
    )
  ).files.length,
  3,
);

/* ------------------------------------------------------------------ */
step("Cleaning up");

show(
  "left in the scratch directory",
  (await readdir(scratch, { recursive: true })).length,
);
await rm(scratch, { recursive: true, force: true });

summary();
