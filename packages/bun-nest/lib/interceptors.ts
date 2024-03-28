import {
  mixin,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type Type,
} from '@nestjs/common';
import {
  transformUploadOptions,
  type TransFormedUploadOptions,
  type UploadOptions,
  getMultipartRequest,
  type UploadField,
  type UploadFieldMapEntry,
} from '@kingsleyweb/bun-common/lib/multipart';
import { tap, type Observable } from 'rxjs';
import {
  handleMultipartAnyFiles,
  handleMultipartFileFields,
  handleMultipartMultipleFiles,
  handleMultipartSingleFile,
  handleNoFiles,
  uploadFieldsToMap,
} from '@kingsleyweb/bun-common/lib/multipart/handlers';

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

      const { body, files, expandedFiles, remove } =
        await handleMultipartAnyFiles(req, this.options);

      req.body = body;
      if (options?.inflate && expandedFiles) {
        req.setStorageFiles(expandedFiles);
      } else if (files) {
        req.setStorageFiles(files);
      }

      return next.handle().pipe(tap(remove));
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

      const { body, files, expandedFiles, remove } =
        await handleMultipartFileFields(req, this.fieldsMap, this.options);

      req.body = body;
      if (options?.inflate && expandedFiles) {
        req.setStorageFiles(expandedFiles);
      } else if (files) {
        req.setStorageFiles(files);
      }

      return next.handle().pipe(tap(remove));
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

      const { file, expandedFile, body, remove } =
        await handleMultipartSingleFile(req, fieldname, this.options);

      req.body = body;
      if (options?.inflate && expandedFile) {
        req.setStorageFiles(expandedFile);
      } else if (!options?.inflate && file) {
        req.setStorageFiles([file]);
      }

      return next.handle().pipe(tap(remove));
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

      const { body, files, expandedFiles, remove } =
        await handleMultipartMultipleFiles(
          req,
          fieldname,
          maxCount,
          this.options,
        );

      req.body = body;
      if (options?.inflate && expandedFiles) {
        req.setStorageFiles(expandedFiles);
      } else if (!options?.inflate && files) {
        req.setStorageFiles(files);
      }

      return next.handle().pipe(tap(remove));
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

      const { body, files, expandedFiles, remove } = await handleNoFiles(
        req,
        this.options,
      );
      req.body = body;
      if (options?.inflate && expandedFiles) {
        req.setStorageFiles(expandedFiles);
      } else if (!options?.inflate && files) {
        req.setStorageFiles(files);
      }

      return next.handle().pipe(tap(remove));
    }
  }

  const Interceptor = mixin(MixinInterceptor);

  return Interceptor;
}
