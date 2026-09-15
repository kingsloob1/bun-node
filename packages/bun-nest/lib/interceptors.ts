import type {
  PayloadTooLargeError,
  UploadErrorCode,
} from "@kingsleyweb/bun-common";
import type {
  BunMultipartRequest,
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
import type { HttpArgumentsHost } from "@nestjs/common/interfaces";
import type { Observable } from "rxjs";
import {
  isString,
  UPLOAD_ERROR_MESSAGES,
  UploadError,
} from "@kingsleyweb/bun-common";
import { transformUploadOptions } from "@kingsleyweb/bun-common/lib/multipart";
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
  mixin,
  PayloadTooLargeException,
} from "@nestjs/common";
import { tap } from "rxjs";

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
   * field"`, …) is followed by `" - <field>"` when it concerns a field, as
   * platform-express words it — except `LIMIT_FILE_SIZE`, which
   * platform-express answers with the bare message. A more specific message
   * is kept as it is.
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
 * | `UploadError` `LIMIT_PART_COUNT`, `LIMIT_FILE_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_FIELD_COUNT`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME` | `BadRequestException` | 400 |
 * | `UploadError` `FILTER_REJECTED` (bun-common only) | `BadRequestException` | 400 |
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
 * and a message bun-common made more specific is kept. The body is
 * {@link UploadExceptionBody} and the error is kept as `cause`.
 */
export function transformUploadException(
  error: HttpException | UploadError | PayloadTooLargeError,
): HttpException;
export function transformUploadException(error: unknown): unknown;
export function transformUploadException(error: unknown): unknown {
  if (error instanceof HttpException) {
    return error;
  }

  if (error instanceof UploadError) {
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

/** Runs an upload handler, rethrowing its error as {@link transformUploadException} maps it. */
async function readUpload<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw transformUploadException(error);
  }
}

export function AnyFilesInterceptor(
  options?: UploadOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    private readonly options: TransFormedUploadOptions;

    constructor() {
      this.options = transformUploadOptions(options);
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

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

export function FileFieldsInterceptor(
  uploadFields: UploadField[],
  options?: UploadOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    private readonly options: TransFormedUploadOptions;

    private readonly fieldsMap: Map<string, UploadFieldMapEntry>;

    constructor() {
      this.options = transformUploadOptions(options);
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

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

export function FileInterceptor(
  fieldname: string,
  options?: UploadOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    private readonly options: TransFormedUploadOptions;

    constructor() {
      this.options = transformUploadOptions(options);
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

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

export function FilesInterceptor(
  fieldname: string,
  maxCount = 1,
  options?: UploadOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    private readonly options: TransFormedUploadOptions;

    constructor() {
      this.options = transformUploadOptions(options);
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

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}

export function NoFilesInterceptor(
  options?: UploadOptions,
): Type<NestInterceptor> {
  class MixinInterceptor implements NestInterceptor {
    private readonly options: TransFormedUploadOptions;

    constructor() {
      this.options = transformUploadOptions(options);
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

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}
