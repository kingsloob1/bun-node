import type {
  BunResponse,
  PayloadTooLargeError,
  StorageFile,
  UploadErrorCode,
} from "@kingsleyweb/bun-common";
import type {
  BunMultipartRequest,
  Storage,
  TransFormedUploadOptions,
  UploadField,
  UploadFieldMapEntry,
  UploadOptions,
} from "@kingsleyweb/bun-common/lib/multipart";
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
  Type,
} from "@nestjs/common";
// A deep path names a file, with its `.js` extension (a directory its
// `index.js`): Nest 11's `@nestjs/*` have no `exports` map (the path is
// resolved as a file), Nest 12's serve it through their `./*.js` entry, and a
// `node16` consumer reads this specifier verbatim in the shipped declaration.
import type { HttpArgumentsHost } from "@nestjs/common/interfaces/index.js";
import type { Observable } from "rxjs";
import type { MulterModuleOptions } from "./MulterModule";
import { createRequire } from "node:module";
import {
  isString,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
} from "@kingsleyweb/bun-common";
import {
  removeStorageFiles,
  transformUploadOptions,
} from "@kingsleyweb/bun-common/lib/multipart";
import {
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  uploadFieldsToMap,
} from "@kingsleyweb/bun-common/lib/multipart/handlers";
import {
  BadRequestException,
  HttpException,
  Inject,
  Logger,
  mixin,
  Optional,
  PayloadTooLargeException,
} from "@nestjs/common";
// A file present on both majors, with its `.js` (see `BunHttpAdapter.ts`).
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { catchError, tap, throwError } from "rxjs";
import { MULTER_MODULE_OPTIONS } from "./MulterModule";

export const getMultipartRequest = (ctx: HttpArgumentsHost) => {
  const req = ctx.getRequest<BunMultipartRequest>();

  const contentType = req.headersObj.get("content-type");
  if (
    !(isString(contentType) && contentType.includes("multipart/form-data;"))
  ) {
    throw new BadRequestException("Not a multipart request");
  }

  return req;
};

/** busboy's missing-boundary message, which platform-express answers `400` as it is. */
const BUSBOY_BOUNDARY_NOT_FOUND = "Multipart: Boundary not found";
/** busboy's malformed-body messages, which platform-express answers `400` prefixed `Multipart: `. */
const BUSBOY_MALFORMED_MESSAGES: ReadonlySet<string> = new Set([
  "Malformed part header",
  "Unexpected end of form",
  "Unexpected end of file",
]);

/**
 * The {@link UploadError} codes platform-express's `transformException`
 * answers `400` (`multer/multer.utils.js`, the `multerExceptions` of
 * `multer/multer.constants.js` but `LIMIT_FILE_SIZE`), plus bun-common's own
 * `FILTER_REJECTED`. `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX` and
 * `INVALID_FIELD_NAME` are multer 2.4's field-name codes (nestjs/nest #17857).
 * Strings, not `UploadErrorCode`s, so the set can name a code before
 * bun-common raises it.
 */
const BAD_REQUEST_UPLOAD_CODES: ReadonlySet<string> = new Set([
  "LIMIT_PART_COUNT",
  "LIMIT_FILE_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
  "LIMIT_FIELD_NESTING",
  "LIMIT_FIELD_ARRAY_INDEX",
  "INVALID_FIELD_NAME",
  "LIMIT_UNEXPECTED_FILE",
  "MISSING_FIELD_NAME",
  "FILTER_REJECTED",
]);

/**
 * The response body of an HTTP exception made from an {@link UploadError}:
 * Nest's usual `{ statusCode, message }` plus the `code` and `field`, so a
 * client can branch on the code rather than the message.
 */
export interface UploadExceptionBody {
  /**
   * The HTTP status: `413` for `LIMIT_FILE_SIZE`, `400` for every other code
   * — platform-express's mapping, which differs from the standalone
   * {@link UploadError.status} (`413` for every size and count limit).
   */
  statusCode: 400 | 413;
  /**
   * The error's message. multer's own message for its code (`"Unexpected
   * file field"`, …) is followed by `" - <field>"` when it concerns a field,
   * as platform-express words it — except `LIMIT_FILE_SIZE`, which
   * platform-express answers with the bare message. A message that is not
   * the code's default (a `filter`'s string) is kept as it is.
   */
  message: string;
  /** Why the upload was refused. */
  code: UploadErrorCode;
  /** The field the failure concerns; `undefined` when it concerns none. */
  field: string | undefined;
}

/**
 * Maps an error thrown while reading an upload to what the interceptors
 * reject with, exactly as `@nestjs/platform-express`'s `transformException`
 * (`multer/multer.utils.js`) does:
 *
 * | Error | Exception | Status |
 * |---|---|---|
 * | an `HttpException` (e.g. from a custom storage) | kept as it is | its own |
 * | `UploadError` `LIMIT_FILE_SIZE` | `PayloadTooLargeException` | 413 |
 * | `UploadError` `LIMIT_PART_COUNT`, `LIMIT_FILE_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_FIELD_COUNT`, `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME` | `BadRequestException` | 400 |
 * | `UploadError` `FILTER_REJECTED` (bun-common only) | `BadRequestException` | 400 |
 * | `UploadError` with any other code | returned unchanged, as platform-express leaves a code it does not list | 500 |
 * | any other error with `statusCode` 413 (bun-common's `PayloadTooLargeError`) | `PayloadTooLargeException` | 413 |
 * | busboy's `Multipart: Boundary not found` | `BadRequestException`, message as it is | 400 |
 * | busboy's `Malformed part header`, `Unexpected end of form`, `Unexpected end of file` | `BadRequestException`, prefixed `Multipart: ` | 400 |
 * | anything else — an error a `filter` or storage throws, a `TypeError` | returned unchanged, so Nest answers it 500 (multer passes such errors on) | 500 |
 *
 * Note the count limits are `400` here: bun-common's standalone
 * {@link UploadError.status} stays `413` for every size and count limit, but
 * inside Nest the platform-express mapping applies, because that is what a
 * Nest application expects.
 *
 * For an `UploadError`, multer's own message for the code gets ` - <field>`
 * appended on a `400`, as platform-express does (the only messages it ever
 * sees); `LIMIT_FILE_SIZE` keeps the bare message, as platform-express does,
 * and a message that is not the code's default (a `filter`'s string) is kept. The body is
 * {@link UploadExceptionBody} and the error is kept as `cause`.
 */
export function transformUploadException(
  exception: HttpException | UploadError | PayloadTooLargeError,
): HttpException;
export function transformUploadException(exception: unknown): unknown;
export function transformUploadException(error: unknown): unknown {
  if (error instanceof HttpException) {
    return error;
  }

  if (error instanceof UploadError) {
    // platform-express maps by `code`, never by status: bun-common's own
    // `status` is 413 for every size and count limit.
    // platform-express: only LIMIT_FILE_SIZE is a 413, with the bare message.
    if (error.code === "LIMIT_FILE_SIZE") {
      const body: UploadExceptionBody = {
        statusCode: 413,
        message: error.message,
        code: error.code,
        field: error.field,
      };
      return new PayloadTooLargeException(body, { cause: error });
    }
    if (!BAD_REQUEST_UPLOAD_CODES.has(error.code)) {
      return error;
    }
    const message =
      error.field && error.message === UPLOAD_ERROR_MESSAGES[error.code]
        ? `${error.message} - ${error.field}`
        : error.message;
    const body: UploadExceptionBody = {
      statusCode: 400,
      message,
      code: error.code,
      field: error.field,
    };
    return new BadRequestException(body, { cause: error });
  }

  if (!(error instanceof Error)) {
    return error;
  }

  if ((error as { statusCode?: unknown }).statusCode === 413) {
    return new PayloadTooLargeException(error.message, { cause: error });
  }

  if (error.message === BUSBOY_BOUNDARY_NOT_FOUND) {
    return new BadRequestException(error.message, { cause: error });
  }
  if (BUSBOY_MALFORMED_MESSAGES.has(error.message)) {
    return new BadRequestException(`Multipart: ${error.message}`, {
      cause: error,
    });
  }

  return error;
}

/**
 * Where a failed removal of an upload's stored files is reported. A Nest
 * `Logger`, so the application's logger receives it.
 */
const uploadLogger = new Logger("BunFileInterceptor");

/**
 * The `tap` callback that removes an upload's stored files once the handler
 * emits. The removal is not awaited, so it never holds the response; a
 * storage whose `removeFile` rejects is logged rather than left as an
 * unhandled rejection, which ends a Bun process.
 */
function removeUploadedFiles(removeAll: () => Promise<void>): () => void {
  return () => {
    removeAll().catch((error: unknown) => {
      uploadLogger.error(
        "Removing an upload's stored files failed",
        error instanceof Error ? error.stack : String(error),
      );
    });
  };
}

/** Runs an upload handler, rethrowing its error as {@link transformUploadException} maps it. */
async function readUpload<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw transformUploadException(error);
  }
}

/** Whether `value` is a plain object, as `@nestjs/common`'s `isPlainObject` decides. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  const ctor: unknown =
    Object.hasOwn(proto as object, "constructor") &&
    (proto as { constructor: unknown }).constructor;
  return (
    typeof ctor === "function" &&
    ctor instanceof ctor &&
    Function.prototype.toString.call(ctor) ===
      Function.prototype.toString.call(Object)
  );
}

/**
 * Whether the installed Nest merges `limits` key by key: Nest 12, read from
 * the capability the adapter gates Nest 12 on
 * (`AbstractHttpAdapter.prototype.mapException`, 12.0.0). platform-express
 * itself merges from 12.0.4 (#17818), so 12.0.0–12.0.3 differ here.
 */
function nestMergesLimits(): boolean {
  return (
    typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
      .mapException === "function"
  );
}

/** `require` from this file, for the one capability probe below. */
const requireFromHere = createRequire(import.meta.url);

/** The installed Nest's `isRejectedByPipes`; `null` once known to be absent. */
let rejectedByPipes: ((request: unknown) => boolean) | null | undefined;

/**
 * The installed Nest's `isRejectedByPipes(request)` (`@nestjs/core/internal`,
 * from 12.2.0, nestjs/nest `acb98de89`), or `undefined` on a Nest without it.
 *
 * It is the capability the 12.2.0 upload behaviours are gated on, as
 * `platform-express` 12.2.0 has them: files removed when a pipe rejects the
 * request, and a route's `dest` replacing the module's storage
 * (`e075cda3c`). The second has no capability of its own (it is in
 * platform-express alone), so the release's core capability stands for it.
 * Read once, synchronously: `@nestjs/core/internal` exists only on 12 (Nest
 * 11 has no such file, 12.0–12.1 no such export), so a failed lookup is the
 * answer, not an error.
 */
export function nestIsRejectedByPipes():
  | ((request: unknown) => boolean)
  | undefined {
  if (rejectedByPipes === undefined) {
    try {
      const internal = requireFromHere("@nestjs/core/internal") as {
        isRejectedByPipes?: unknown;
      };
      rejectedByPipes =
        typeof internal.isRejectedByPipes === "function"
          ? (internal.isRejectedByPipes as (request: unknown) => boolean)
          : null;
    } catch {
      rejectedByPipes = null;
    }
  }
  return rejectedByPipes ?? undefined;
}

/**
 * Merges the module-level upload options ({@link MulterModule}) with an
 * interceptor's own, as `@nestjs/platform-express`'s `mergeMulterOptions`
 * (`multer/multer.utils.js`) does on the installed Nest:
 *
 * - every key of the interceptor's options wins over the module's;
 * - on Nest 12, `limits` is merged key by key when both sides give a plain
 *   object (nestjs/nest #17818), so a route's `fileSize` keeps the module's
 *   `files`. On Nest 11 the route's `limits` replaces the module's whole, as
 *   platform-express 11 spreads the two shallowly;
 * - on Nest 12.2.0 and later (`e075cda3c`), an interceptor's `dest` with no
 *   `storage` (and no `storageType`) of its own replaces the module's
 *   storage: its files go to disk at that `dest`. Before 12.2.0 the module's
 *   storage shadows it, as multer prefers `storage` to `dest`.
 *
 * A `storageType` neither side gives is `"disk"` with a `dest` and
 * `"memory"` otherwise, as multer picks its engine. A `storage` needs an
 * explicit `storageType: "custom"`: a multer storage engine cannot run here,
 * so options that leave a `storage` without one are refused.
 *
 * @throws {TypeError} when the merged options have a `storage` and no
 *   `storageType`. Every interceptor merges in its constructor, so this fails
 *   the application's bootstrap, not a request.
 */
export function mergeUploadOptions(
  moduleOptions: MulterModuleOptions = {},
  localOptions: MulterModuleOptions = {},
): UploadOptions {
  const merged: Record<string, unknown> = { ...moduleOptions, ...localOptions };
  if (
    nestMergesLimits() &&
    isPlainObject(moduleOptions.limits) &&
    isPlainObject(localOptions.limits)
  ) {
    merged.limits = { ...moduleOptions.limits, ...localOptions.limits };
  }
  const local = localOptions as {
    dest?: unknown;
    storage?: unknown;
    storageType?: unknown;
  };
  if (
    local.dest &&
    !local.storage &&
    local.storageType === undefined &&
    nestIsRejectedByPipes() !== undefined
  ) {
    delete merged.storage;
    merged.storageType = "disk";
  }
  if (merged.storageType === undefined) {
    if (merged.storage) {
      throw new TypeError(
        'Upload options with a storage require storageType "custom": set storageType: "custom" beside the storage',
      );
    }
    merged.storageType = merged.dest ? "disk" : "memory";
  }
  // Plain JS can still put anything here; `transformUploadOptions`, which
  // every interceptor runs on the result, rejects a shape it cannot build.
  return merged as unknown as UploadOptions;
}

/**
 * Declares an interceptor's one constructor parameter as the optional
 * module-level options, as platform-express's interceptors do
 * (`@Optional() @Inject(MULTER_MODULE_OPTIONS)`). Applied by call rather
 * than as parameter decorators: Bun drops those when the working directory's
 * tsconfig does not enable them (oven-sh/bun#28605).
 */
function injectModuleOptions(target: Type<NestInterceptor>): void {
  Optional()(target, undefined, 0);
  Inject(MULTER_MODULE_OPTIONS)(target, undefined, 0);
}

/** The files an upload stored on `req`, as platform-express's `storedFiles` reads them. */
function storedFiles(req: BunMultipartRequest): StorageFile[] {
  const files = req.storageFiles;
  if (files === undefined) {
    return [];
  }
  return Array.isArray(files) ? files : Object.values(files).flat();
}

/**
 * Calls `callback` once the response has been sent (or the client left), as
 * `stream.finished(res, …)` does for platform-express; at once, a microtask
 * later, when it already has, or when there is no response to wait for.
 */
function onResponseFinished(res: unknown, callback: () => void): void {
  const response = res as Partial<Pick<BunResponse, "once" | "writableEnded">>;
  if (
    typeof response !== "object" ||
    response === null ||
    typeof response.once !== "function" ||
    response.writableEnded === true
  ) {
    queueMicrotask(callback);
    return;
  }
  let called = false;
  const once = () => {
    if (!called) {
      called = true;
      callback();
    }
  };
  response.once("finish", once);
  response.once("close", once);
}

/**
 * Removes the files an upload stored for `req` when the route's pipes reject
 * the request (`ParseFilePipe`, …), as platform-express 12.2.0's
 * `removeFilesOnPipeRejection` does (nestjs/nest `acb98de89`): the handler
 * never sees them, and nothing else would remove them. They are removed with
 * `force` once the response has been sent, as an exception filter may still
 * use them; a failed removal is ignored (the request has failed already).
 * The error goes on unchanged.
 */
function removeFilesOnPipeRejection(
  isRejectedByPipes: (request: unknown) => boolean,
  storage: Storage,
  req: BunMultipartRequest,
  res: unknown,
) {
  return catchError((error: unknown) => {
    if (isRejectedByPipes(req)) {
      onResponseFinished(res, () => {
        removeStorageFiles(storage, storedFiles(req), true).catch(() => {});
      });
    }
    return throwError(() => error);
  });
}

/**
 * The handler's stream for an interceptor that stored files: they are
 * removed once the handler emits (each storage's own keep-or-remove rule),
 * and on Nest 12.2.0 and later also when a pipe rejects the request.
 */
function handleUpload(
  context: ExecutionContext,
  next: CallHandler,
  req: BunMultipartRequest,
  storage: Storage,
  removeAll: () => Promise<void>,
): Observable<unknown> {
  const handled = next.handle().pipe(tap(removeUploadedFiles(removeAll)));
  const isRejectedByPipes = nestIsRejectedByPipes();
  return isRejectedByPipes
    ? handled.pipe(
        removeFilesOnPipeRejection(
          isRejectedByPipes,
          storage,
          req,
          context.switchToHttp().getResponse(),
        ),
      )
    : handled;
}

/**
 * Accepts any file on any field (multer's `any()`).
 *
 * @param options This route's upload options, merged over the module's
 *   ({@link MulterModule}) by {@link mergeUploadOptions}.
 */
export function AnyFilesInterceptor(
  options?: MulterModuleOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    /** The merged options, their storage built. */
    private readonly options: TransFormedUploadOptions;

    /** @param moduleOptions The module-level options, when a `MulterModule` provides them. */
    constructor(moduleOptions?: MulterModuleOptions) {
      this.options = transformUploadOptions(
        mergeUploadOptions(moduleOptions, options),
      );
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await readUpload(() =>
        handleMultipartAnyFiles(req, this.options),
      );

      req.body = body;
      req.setStorageFiles(files);

      return handleUpload(context, next, req, this.options.storage, removeAll);
    }
  }

  injectModuleOptions(MixinInterceptor);
  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

/**
 * Accepts files only on `uploadFields`, each up to its `maxCount` (multer's
 * `fields()`).
 *
 * @param uploadFields The fields that take files.
 * @param options This route's upload options, merged over the module's
 *   ({@link MulterModule}) by {@link mergeUploadOptions}.
 */
export function FileFieldsInterceptor(
  uploadFields: UploadField[],
  options?: MulterModuleOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    /** The merged options, their storage built. */
    private readonly options: TransFormedUploadOptions;

    /** `uploadFields` by name, with each one's `maxCount`. */
    private readonly fieldsMap: Map<string, UploadFieldMapEntry>;

    /** @param moduleOptions The module-level options, when a `MulterModule` provides them. */
    constructor(moduleOptions?: MulterModuleOptions) {
      this.options = transformUploadOptions(
        mergeUploadOptions(moduleOptions, options),
      );
      this.fieldsMap = uploadFieldsToMap(uploadFields);
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await readUpload(() =>
        handleMultipartFileFields(req, this.fieldsMap, this.options),
      );

      req.body = body;
      req.setStorageFiles(files);

      return handleUpload(context, next, req, this.options.storage, removeAll);
    }
  }

  injectModuleOptions(MixinInterceptor);
  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

/**
 * Accepts at most one file, on `fieldname` (multer's `single()`).
 *
 * @param fieldname The field that takes the file.
 * @param options This route's upload options, merged over the module's
 *   ({@link MulterModule}) by {@link mergeUploadOptions}.
 */
export function FileInterceptor(
  fieldname: string,
  options?: MulterModuleOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    /** The merged options, their storage built. */
    private readonly options: TransFormedUploadOptions;

    /** @param moduleOptions The module-level options, when a `MulterModule` provides them. */
    constructor(moduleOptions?: MulterModuleOptions) {
      this.options = transformUploadOptions(
        mergeUploadOptions(moduleOptions, options),
      );
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { file, body, removeAll } = await readUpload(() =>
        handleMultipartSingleFile(req, fieldname, this.options),
      );

      req.body = body;
      file && req.setStorageFiles([file]);

      return handleUpload(context, next, req, this.options.storage, removeAll);
    }
  }

  injectModuleOptions(MixinInterceptor);
  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

/**
 * Accepts up to `maxCount` files, all on `fieldname` (multer's `array()`).
 *
 * @param fieldname The field that takes the files.
 * @param maxCount How many files it takes. Defaults to `1`.
 * @param options This route's upload options, merged over the module's
 *   ({@link MulterModule}) by {@link mergeUploadOptions}.
 */
export function FilesInterceptor(
  fieldname: string,
  maxCount = 1,
  options?: MulterModuleOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    /** The merged options, their storage built. */
    private readonly options: TransFormedUploadOptions;

    /** @param moduleOptions The module-level options, when a `MulterModule` provides them. */
    constructor(moduleOptions?: MulterModuleOptions) {
      this.options = transformUploadOptions(
        mergeUploadOptions(moduleOptions, options),
      );
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await readUpload(() =>
        handleMultipartMultipleFiles(req, fieldname, maxCount, this.options),
      );

      req.body = body;
      req.setStorageFiles(files);

      return handleUpload(context, next, req, this.options.storage, removeAll);
    }
  }

  injectModuleOptions(MixinInterceptor);
  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

/**
 * Accepts fields only, rejecting any file (multer's `none()`).
 *
 * @param options This route's upload options, merged over the module's
 *   ({@link MulterModule}) by {@link mergeUploadOptions}.
 */
export function NoFilesInterceptor(
  options?: MulterModuleOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    /** The merged options, their storage built. */
    private readonly options: TransFormedUploadOptions;

    /** @param moduleOptions The module-level options, when a `MulterModule` provides them. */
    constructor(moduleOptions?: MulterModuleOptions) {
      this.options = transformUploadOptions(
        mergeUploadOptions(moduleOptions, options),
      );
    }

    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<Observable<unknown>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, removeAll } = await readUpload(() =>
        handleNoFiles(req, this.options),
      );

      req.body = body;

      // No files are stored, so nothing is removed on a pipe rejection
      // (platform-express 12.2.0 adds no removal to `NoFilesInterceptor`).
      return next.handle().pipe(tap(removeUploadedFiles(removeAll)));
    }
  }

  injectModuleOptions(MixinInterceptor);
  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}
