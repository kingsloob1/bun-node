import {
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
  mixin,
} from "@nestjs/common";
import {
  type TransFormedUploadOptions,
  type UploadField,
  type UploadFieldMapEntry,
  type UploadOptions,
  getMultipartRequest,
  transformUploadOptions,
} from "@kingsleyweb/bun-common/lib/multipart";
import { type Observable, tap } from "rxjs";
import {
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  uploadFieldsToMap,
} from "@kingsleyweb/bun-common/lib/multipart/handlers";

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
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await handleMultipartAnyFiles(
        req,
        this.options,
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
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await handleMultipartFileFields(
        req,
        this.fieldsMap,
        this.options,
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
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { file, body, removeAll } = await handleMultipartSingleFile(
        req,
        fieldname,
        this.options,
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
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, files, removeAll } = await handleMultipartMultipleFiles(
        req,
        fieldname,
        maxCount,
        this.options,
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
    ): Promise<Observable<any>> {
      const ctx = context.switchToHttp();
      const req = getMultipartRequest(ctx);

      const { body, removeAll } = await handleNoFiles(req, this.options);

      req.body = body;

      return next.handle().pipe(tap(removeAll));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}
