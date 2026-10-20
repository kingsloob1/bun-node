/**
 * Where uploads go — `MemoryStorage`, `DiskStorage` with every option, a
 * custom `Storage`, and `removeStorageFiles`.
 *
 * ```bash
 * bun 08-multipart/storage.ts
 * ```
 *
 * The upload options pick a storage:
 *
 * - `{ storageType: "memory" }` — a `MemoryStorage`; each file keeps its bytes
 *   in `buffer`. The default.
 * - `{ storageType: "disk", dest, filename, removeAfter }` — a `DiskStorage`
 *   writing into `dest` (the OS temp directory when omitted) under `filename`
 *   (a random hex name when omitted). `dest` and `filename` may be strings or
 *   functions of the file and request.
 * - `{ storageType: "custom", storage }` — any object implementing `Storage`:
 *   `handleFile(record, req)` and `removeFile(file, force?)`.
 *
 * A few things worth knowing before reading it:
 *
 * - `DiskStorage.removeFile(file)` does nothing unless `removeAfter` is set or
 *   `force` is passed — so `removeAll()` on a plain disk upload keeps the files.
 *   A rejected upload, or a file the filter leaves out, is always removed with
 *   `force`. `MemoryStorage` takes `removeAfter` too, defaulting to `true`.
 * - A file part sent with no `filename` (busboy counts an
 *   `application/octet-stream` part as a file regardless) has
 *   `originalFilename: ""`, and `DiskStorage` gives it a random name with no
 *   extension. Its record's own `filename`, busboy's, is `undefined`: a custom
 *   storage reads `originalFilename`, which is always a string.
 * - Everything is written under a fresh directory in `os.tmpdir()`, removed at
 *   the end.
 */
import type {
  BunRequest,
  CustomStorageFile,
  DiskStorageFile,
  MultiPartFileRecord,
  RouterHandler,
  Storage,
  StorageFile,
} from "@kingsleyweb/bun-common";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import {
  BunRouter,
  handleMultipartAnyFiles,
  handleMultipartMultipleFiles,
  MemoryStorage,
  removeStorageFiles,
  transformUploadOptions,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Upload storage");

const root = await mkdtemp(join(tmpdir(), "bun-common-uploads-"));
const router = new BunRouter();

/** Files each route stored, for inspecting after the response. */
let stored: StorageFile[] = [];

/** POSTs `files` as the `docs` field and answers with the status. */
async function send(path: string, files: File[]): Promise<number> {
  const form = new FormData();
  for (const file of files) {
    form.append("docs", file);
  }
  return (await router.fetch(path, { method: "POST", body: form })).status;
}

/** Every file under `dir`, relative to the upload root. */
async function listed(dir: string = root): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

/* ------------------------------------------------------------------ */
step("MemoryStorage: bytes on the file object");

const memory = transformUploadOptions({ storageType: "memory" });
show("storage", memory.storage.constructor.name);

router.post("/memory", (async (req, res) => {
  const upload = await handleMultipartAnyFiles(req, memory);
  stored = upload.files;
  res.json({ count: upload.files.length });
}) satisfies RouterHandler);

await send("/memory", [new File(["in memory"], "note.txt")]);
const inMemory = stored[0] as StorageFile & { buffer?: Uint8Array };
show("file", {
  type: (inMemory as { type?: string }).type,
  size: inMemory.size,
  text: new TextDecoder().decode(inMemory.buffer),
});
await new MemoryStorage().removeFile(inMemory);
show("after removeFile, the buffer is gone", !("buffer" in inMemory));

/* ------------------------------------------------------------------ */
step("DiskStorage via storageType 'disk': dest, random names, kept by default");

const plainDisk = transformUploadOptions({
  storageType: "disk",
  dest: join(root, "plain"),
});

router.post("/disk", (async (req, res) => {
  const upload = await handleMultipartAnyFiles(req, plainDisk);
  stored = upload.files;
  // Without removeAfter, removeAll() is a no-op for disk files.
  await upload.removeAll();
  res.json({ count: upload.files.length });
}) satisfies RouterHandler);

await send("/disk", [new File(["on disk"], "report.txt")]);
const onDisk = stored[0] as DiskStorageFile;
show("file", {
  type: onDisk.type,
  dest: relative(root, onDisk.dest ?? ""),
  filename: onDisk.filename,
  originalFilename: onDisk.originalFilename,
  size: onDisk.size,
});
show(
  "still on disk after removeAll() — removeAfter is not set",
  await Bun.file(onDisk.path).exists(),
);
await plainDisk.storage.removeFile(onDisk, true);
show("removeFile(file, true) forces it", await Bun.file(onDisk.path).exists());

/* ------------------------------------------------------------------ */
step(
  "DiskStorage with every option: dest and filename as functions, removeAfter",
);

let sequence = 0;
const perUserOptions = transformUploadOptions({
  storageType: "disk",
  // Called per file with the raw record and the request.
  // An untyped `req.params` value is a `string`, or a `string[]` for a
  // wildcard; this route's `:userId` is a string.
  dest: (file, req) => {
    const { userId } = req.params;
    return join(
      root,
      "users",
      typeof userId === "string" ? userId : "anon",
      file.fieldname,
    );
  },
  // `file` is the raw part, whose `filename` is undefined when the client
  // sent none — the `?? ""` keeps such a file extensionless.
  filename: (file) =>
    `${String(++sequence).padStart(3, "0")}${extname(file.filename ?? "")}`,
  // removeFile — and so removeAll() — deletes without needing force.
  removeAfter: true,
});

/** Paths on disk right after the upload, before the handler cleaned up. */
let beforeCleanup: string[] = [];

router.post("/users/:userId/docs", (async (req, res) => {
  const upload = await handleMultipartAnyFiles(req, perUserOptions);
  beforeCleanup = await listed(join(root, "users"));
  await upload.removeAll(); // processed — nothing to keep
  res.json({ count: upload.files.length });
}) satisfies RouterHandler);

await send("/users/u-42/docs", [
  new File(["a"], "passport.pdf"),
  new File(["b"], "utility-bill.png"),
]);
show("written", beforeCleanup);
show(
  "after removeAll() with removeAfter: true",
  await listed(join(root, "users")),
);

/* ------------------------------------------------------------------ */
step("DiskStorage with dest and filename as strings: one fixed path");

const fixedName = transformUploadOptions({
  storageType: "disk",
  dest: join(root, "latest"),
  filename: "export.csv",
});
router.post("/latest", (async (req, res) => {
  const upload = await handleMultipartAnyFiles(req, fixedName);
  res.json({ count: upload.files.length });
}) satisfies RouterHandler);

await send("/latest", [new File(["id\n1\n"], "monday.csv")]);
await send("/latest", [new File(["id\n2\n"], "tuesday.csv")]);
show("every upload lands on the same name", await listed(join(root, "latest")));
show(
  "…so the last one wins",
  await Bun.file(join(root, "latest", "export.csv")).text(),
);

/* ------------------------------------------------------------------ */
step('A file part with no filename: originalFilename is ""');

// busboy counts an `application/octet-stream` part as a file even when its
// Content-Disposition names no `filename`, and reports `filename: undefined`.
// FormData always names a file part, so this body is written by hand.
const BOUNDARY = "no-filename-boundary";

/** POSTs `bytes` as an octet-stream part named `blob`, with no `filename`. */
async function sendWithoutFilename(
  path: string,
  bytes: string,
): Promise<number> {
  const body = [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="blob"',
    "Content-Type: application/octet-stream",
    "",
    bytes,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
  const response = await router.fetch(path, {
    method: "POST",
    body,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  });
  return response.status;
}

/** A `MemoryStorage` that also keeps each record it is handed. */
class PeekingMemoryStorage extends MemoryStorage {
  /** The records `handleFile` received, as busboy and bun-common built them. */
  readonly records: MultiPartFileRecord[] = [];

  override async handleFile(record: MultiPartFileRecord) {
    this.records.push(record);
    return super.handleFile(record);
  }
}

const peeking = new PeekingMemoryStorage();
const peekingOptions = transformUploadOptions({
  storageType: "custom",
  storage: peeking,
});

router.post("/no-filename/memory", (async (req, res) => {
  const upload = await handleMultipartAnyFiles(req, peekingOptions);
  stored = upload.files;
  res.json({ count: upload.files.length });
}) satisfies RouterHandler);

stored = [];
checkEqual(
  "memory: the upload is answered 200",
  await sendWithoutFilename("/no-filename/memory", "nameless bytes"),
  200,
);
const nameless = peeking.records[0];
show("the record a storage receives", {
  filename: nameless?.filename,
  originalFilename: nameless?.originalFilename,
  mimeType: nameless?.mimeType,
});
checkEqual(
  "memory: the record's filename (busboy's) is undefined",
  nameless?.filename,
  undefined,
);
checkEqual(
  'memory: the record\'s originalFilename is ""',
  nameless?.originalFilename,
  "",
);
const namelessInMemory = stored[0] as
  (StorageFile & { buffer?: Uint8Array }) | undefined;
checkEqual(
  'memory: the stored file\'s originalFilename is ""',
  namelessInMemory?.originalFilename,
  "",
);
checkEqual(
  "memory: the bytes arrive",
  namelessInMemory?.buffer && new TextDecoder().decode(namelessInMemory.buffer),
  "nameless bytes",
);

const namelessDisk = transformUploadOptions({
  storageType: "disk",
  dest: join(root, "nameless"),
});

router.post("/no-filename/disk", (async (req, res) => {
  try {
    const upload = await handleMultipartAnyFiles(req, namelessDisk);
    stored = upload.files;
    res.json({ count: upload.files.length });
  } catch (error) {
    // Answered rather than rethrown, so a failure here is reported by the
    // checks below instead of ending the example.
    show("the disk upload failed", {
      code: (error as Error & { code?: unknown }).code,
      message: (error as Error).message,
    });
    res.status(500).json({ error: (error as Error).message });
  }
}) satisfies RouterHandler);

stored = [];
checkEqual(
  "disk: the upload is answered 200",
  await sendWithoutFilename("/no-filename/disk", "nameless on disk"),
  200,
);
const namelessOnDisk = stored[0] as DiskStorageFile | undefined;
show("file", {
  filename: namelessOnDisk?.filename,
  originalFilename: namelessOnDisk?.originalFilename,
});
checkEqual(
  'disk: originalFilename is ""',
  namelessOnDisk?.originalFilename,
  "",
);
// DiskStorage's random name: 16 random bytes in hex, then the extension of
// the client's name, which here is none.
check(
  "disk: named 32 random hex characters, with no extension",
  /^[0-9a-f]{32}$/.test(namelessOnDisk?.filename ?? ""),
  { filename: namelessOnDisk?.filename },
);
checkEqual(
  "disk: the file exists, holding the bytes",
  namelessOnDisk && (await Bun.file(namelessOnDisk.path).exists())
    ? await Bun.file(namelessOnDisk.path).text()
    : undefined,
  "nameless on disk",
);
if (namelessOnDisk) {
  await namelessDisk.storage.removeFile(namelessOnDisk, true);
}
checkEqual(
  "disk: removeFile(file, true) deletes it",
  namelessOnDisk && (await Bun.file(namelessOnDisk.path).exists()),
  false,
);

/* ------------------------------------------------------------------ */
step("A custom Storage: an in-process object store");

/** Options this storage is constructed with. */
interface BucketOptions {
  /** Name of the bucket, prefixed to every key. */
  bucket: string;
}

/** A file as the bucket stores it. */
interface BucketFile extends CustomStorageFile {
  /** Where the object lives in the bucket. */
  key: string;
}

/** Keeps each upload in a `Map`, as an S3-style client would keep it remotely. */
class BucketStorage implements Storage<BucketFile, BucketOptions> {
  /** The stored objects, by key. */
  readonly objects = new Map<string, Uint8Array>();

  /** Keys removed so far, to show cleanup happened. */
  readonly removed: string[] = [];

  constructor(
    /** The bucket name and anything else the storage needs. */
    readonly options: BucketOptions,
  ) {}

  async handleFile(
    record: MultiPartFileRecord,
    req: BunRequest,
  ): Promise<BucketFile> {
    const key = `${this.options.bucket}/${req.path.slice(1)}/${crypto.randomUUID()}${extname(record.originalFilename)}`;
    this.objects.set(key, record.file);
    return {
      type: "custom",
      key,
      file: record.file,
      size: record.file.length,
      mimetype: record.mimeType,
      encoding: record.encoding,
      fieldname: record.fieldname,
      originalFilename: record.originalFilename,
      validatedMimeType: record.validatedMimeType,
    };
  }

  async removeFile(file: BucketFile): Promise<void> {
    if (this.objects.delete(file.key)) {
      this.removed.push(file.key);
    }
  }
}

const bucket = new BucketStorage({ bucket: "tenant-1" });
const bucketOptions = transformUploadOptions({
  storageType: "custom",
  storage: bucket,
});

router.post("/bucket", (async (req, res) => {
  try {
    const upload = await handleMultipartMultipleFiles(
      req,
      "docs",
      2,
      bucketOptions,
    );
    stored = upload.files;
    res.json({ keys: upload.files.map((file) => file.key) });
  } catch (error) {
    // The handler rejected the upload, after removing what it had stored.
    res.status(400).json({ error: (error as Error).message });
  }
}) satisfies RouterHandler);

show(
  "two files",
  await send("/bucket", [new File(["1"], "a.txt"), new File(["2"], "b.txt")]),
);
show("…stored under", [...bucket.objects.keys()]);
const kept = bucket.objects.size;
show(
  "three files — over maxCount, so the upload is rejected",
  await send("/bucket", [
    new File(["3"], "c.txt"),
    new File(["4"], "d.txt"),
    new File(["5"], "e.txt"),
  ]),
);
show("…and what it had stored was removed again", {
  objectsBefore: kept,
  objectsAfter: bucket.objects.size,
  removed: bucket.removed.length,
});

/* ------------------------------------------------------------------ */
step("removeStorageFiles(storage, files, force)");

// The two files from the first /bucket upload, plus a hole: undefined entries
// are skipped, which suits a list built from optional single-file uploads.
await removeStorageFiles(bucket, [...stored, undefined], true);
show("bucket after removeStorageFiles", [...bucket.objects.keys()]);

/* ------------------------------------------------------------------ */
step("Cleaning up");

await rm(root, { recursive: true, force: true });
show("removed", root);

summary();
