/**
 * Compile-time assertions for `cors()`, `createServeStaticHandler` and the
 * multipart upload types.
 *
 * - `cors()` has one overload per call form, each answering a `CorsMiddleware`.
 * - `transformUploadOptions` answers the storage the options select, so the
 *   multipart handlers type `file`/`files` by what that storage produces.
 * - A custom `Storage<MyFile>` may type `removeFile(file: MyFile)` and still be
 *   accepted where a plain `Storage` is.
 *
 * Runtime behaviour lives in `cors.test.ts`, `serveStatic.test.ts` and
 * `multipart.test.ts`.
 */
import type { BunRequest } from "../lib/BunRequest";
import type {
  CorsMiddleware,
  CorsOptions,
  CorsOptionsDelegate,
} from "../lib/cors";
import type {
  CustomStorageFile,
  DiskStorageFile,
  MemoryStorageFile,
  Storage,
  StorageFile,
  TransFormedUploadOptions,
  UploadOptions,
} from "../lib/multipart";
import type { DiskStorage, MemoryStorage } from "../lib/multipart/storage";
import type { MultiPartFileRecord, RouterHandler } from "../lib/types/general";
import { cors } from "../lib/cors";
import { transformUploadOptions } from "../lib/multipart";
import {
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  uploadFieldsToMap,
} from "../lib/multipart/handlers";
import { createServeStaticHandler } from "../lib/serveStatic";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;
type Extends<X, Y> = [X] extends [Y] ? true : false;

/* --- cors: every call form answers a CorsMiddleware ------------------ */

const _none = cors();
type _noneIsMiddleware = Expect<Equal<typeof _none, CorsMiddleware>>;

const _fixed = cors({ origin: [/\.example\.com$/, "http://localhost:3000"] });
type _fixedIsMiddleware = Expect<Equal<typeof _fixed, CorsMiddleware>>;

const _delegated = cors((req, callback) => {
  // The delegate form contextually types its parameters.
  type _req = Expect<Equal<typeof req, BunRequest>>;
  callback(null, { origin: req.getHeader("origin") ?? false });
});
type _delegatedIsMiddleware = Expect<Equal<typeof _delegated, CorsMiddleware>>;

declare const either: CorsOptions | CorsOptionsDelegate<BunRequest>;
const _either = cors(either);
type _eitherIsMiddleware = Expect<Equal<typeof _either, CorsMiddleware>>;

// It is an ordinary router handler, and always settles asynchronously.
type _handler = Expect<Extends<CorsMiddleware, RouterHandler>>;
type _async = Expect<Equal<ReturnType<CorsMiddleware>, Promise<unknown>>>;

// @ts-expect-error — an origin is a boolean, string, RegExp or array of them.
cors({ origin: 42 });

cors((_req, callback) => {
  // @ts-expect-error — a delegate answers with CorsOptions.
  callback(null, { origin: 42 });
});

/* --- serve-static ---------------------------------------------------- */

const _static = createServeStaticHandler("./public", { prefix: "/assets" });
type _staticHandler = Expect<
  Equal<typeof _static, { prefix: string; handler: RouterHandler }>
>;

/* --- upload options: the storage follows storageType ----------------- */

/** A file as the bucket storage below stores it. */
interface BucketFile extends CustomStorageFile {
  /** Where the object lives in the bucket. */
  key: string;
}

/** A custom storage that names its own file type everywhere, `removeFile` too. */
class BucketStorage implements Storage<BucketFile> {
  async handleFile(record: MultiPartFileRecord): Promise<BucketFile> {
    return {
      type: "custom",
      key: record.filename,
      file: record.file,
      size: record.file.length,
      mimetype: record.mimeType,
      encoding: record.encoding,
      fieldname: record.fieldname,
      originalFilename: record.filename,
      validatedMimeType: record.validatedMimeType,
    };
  }

  async removeFile(file: BucketFile): Promise<void> {
    void file.key;
  }
}

const memory = transformUploadOptions();
type _memory = Expect<Equal<typeof memory.storage, MemoryStorage>>;

const _explicitMemory = transformUploadOptions({ storageType: "memory" });
type _explicitMemoryStorage = Expect<
  Equal<(typeof _explicitMemory)["storage"], MemoryStorage>
>;

const disk = transformUploadOptions({ storageType: "disk", dest: "/tmp" });
type _disk = Expect<Equal<typeof disk.storage, DiskStorage>>;

const bucket = transformUploadOptions({
  storageType: "custom",
  storage: new BucketStorage(),
});
type _bucket = Expect<Equal<typeof bucket.storage, BucketStorage>>;

// A storage typed on its own file is still a plain `Storage`.
type _covariant = Expect<Extends<BucketStorage, Storage>>;
type _covariantObject = Expect<Extends<Storage<BucketFile>, Storage>>;

declare const unknownKind: UploadOptions;
const wide = transformUploadOptions(unknownKind);
type _wide = Expect<Equal<typeof wide, TransFormedUploadOptions>>;
// `storage` is never `undefined`: an unknown storageType throws instead.
type _wideStorage = Expect<Equal<typeof wide.storage, Storage>>;

// @ts-expect-error — a custom storage type needs its `storage`.
transformUploadOptions({ storageType: "custom" });

/* --- handlers: file types come from the storage ---------------------- */

declare const req: BunRequest;

type DiskFile = Awaited<ReturnType<DiskStorage["handleFile"]>>;
type MemoryFile = Awaited<ReturnType<MemoryStorage["handleFile"]>>;

async function _handlers(): Promise<void> {
  const _anyDisk = await handleMultipartAnyFiles(req, disk);
  type _anyDiskFiles = Expect<Equal<(typeof _anyDisk)["files"], DiskFile[]>>;
  type _diskIsDiskFile = Expect<Extends<DiskFile, DiskStorageFile>>;
  type _body = Expect<
    Equal<(typeof _anyDisk)["body"], Record<string, unknown>>
  >;

  const single = await handleMultipartSingleFile(req, "avatar", memory);
  type _single = Expect<Equal<typeof single.file, MemoryFile | undefined>>;
  type _memoryIsMemoryFile = Expect<Extends<MemoryFile, MemoryStorageFile>>;

  const many = await handleMultipartMultipleFiles(req, "docs", 3, bucket);
  type _many = Expect<Equal<typeof many.files, BucketFile[]>>;

  const _fields = await handleMultipartFileFields(
    req,
    uploadFieldsToMap([{ name: "front" }, { name: "back", maxCount: 2 }]),
    bucket,
  );
  type _fieldsFiles = Expect<
    Equal<(typeof _fields)["files"], Record<string, BucketFile[]>>
  >;

  const _noFiles = await handleNoFiles(req, memory);
  type _noFilesFiles = Expect<Equal<(typeof _noFiles)["files"], MemoryFile[]>>;

  // Options whose kind is only known at runtime fall back to StorageFile.
  const _untyped = await handleMultipartAnyFiles(req, wide);
  type _untypedFiles = Expect<Equal<(typeof _untyped)["files"], StorageFile[]>>;

  // `removeFile` takes what this storage produced.
  await many.removeFile(many.files[0]!);
  const memoryFile = single.file!;
  // @ts-expect-error — a memory file is not what the bucket storage produced.
  await many.removeFile(memoryFile);
}
