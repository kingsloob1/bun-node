/**
 * The upload groups of the differential: one application per side, built
 * from that side's interceptors and `MulterModule` (platform-express's on
 * Express, bun-nest's on Bun), sent the same multipart requests.
 *
 * Errors are compared by status and message: both sides answer through
 * {@link UploadErrorShape}, because bun-nest's upload error body adds
 * `code` and `field` and has no `error` by design (`UploadExceptionBody`,
 * `lib/interceptors.ts`); what is compared is what Nest decided.
 */
import type {
  ArgumentsHost,
  ExceptionFilter,
  NestInterceptor,
  Type,
} from "@nestjs/common";
import type { Side } from "./app";
import type { KnownDifference, ProbeGroup } from "./probes";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLOAD_ERROR_MESSAGES } from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  HttpException,
  MaxFileSizeValidator,
  Module,
  ParseFilePipe,
  Post,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import * as expressUploads from "@nestjs/platform-express";
import * as bunUploads from "../../lib";

const requireHere = createRequire(import.meta.url);

/** The installed platform-express's multer utilities and constants, read by name. */
const expressMulter = {
  utils: requireHere(
    "@nestjs/platform-express/multer/multer/multer.utils.js",
  ) as { mergeMulterOptions?: unknown },
  constants: requireHere(
    "@nestjs/platform-express/multer/multer/multer.constants.js",
  ) as {
    multerExceptions: Record<string, string>;
    DEFAULT_FIELD_NAME_LIMITS?: unknown;
  },
};

/** Whether the installed Express merges `limits` key by key (12.0.4+, #17818). */
const EXPRESS_MERGES_LIMITS =
  typeof expressMulter.utils.mergeMulterOptions === "function";

/** Whether bun-nest does (Nest 12, by the `mapException` capability). */
const BUN_MERGES_LIMITS =
  typeof (
    requireHere("@nestjs/core/adapters/http-adapter.js") as {
      AbstractHttpAdapter: { prototype: { mapException?: unknown } };
    }
  ).AbstractHttpAdapter.prototype.mapException === "function";

/** Whether the installed Express answers `LIMIT_FIELD_ARRAY_INDEX` 400 (else it is a 500). */
const EXPRESS_MAPS_ARRAY_INDEX = Object.hasOwn(
  expressMulter.constants.multerExceptions,
  "LIMIT_FIELD_ARRAY_INDEX",
);

/** Whether the installed Express sets default field-name limits (12.2.0's `applyDefaultLimits`). */
const EXPRESS_DEFAULT_FIELD_LIMITS =
  expressMulter.constants.DEFAULT_FIELD_NAME_LIMITS !== undefined;

/**
 * Whether bun-common raises multer 2.4's field-name codes (PR-7 of the Nest
 * 12 parity plan); the group that needs them is skipped until it does.
 */
const HAS_FIELD_NAME_CODES = "LIMIT_FIELD_NESTING" in UPLOAD_ERROR_MESSAGES;

/** The interceptor factories and `MulterModule` both packages export, typed alike. */
interface UploadLib {
  FileInterceptor: (field: string, options?: object) => Type<NestInterceptor>;
  FilesInterceptor: (
    field: string,
    maxCount?: number,
    options?: object,
  ) => Type<NestInterceptor>;
  AnyFilesInterceptor: (options?: object) => Type<NestInterceptor>;
  MulterModule: { register: (options?: object) => object };
}

/** Each side's upload library. */
const LIBS: Record<Side, UploadLib> = {
  express: expressUploads,
  bun: bunUploads,
};

/** Each side's module-level memory storage: multer's engine, or bun-common's `storageType`. */
const MEMORY_STORAGE: Record<Side, () => object> = {
  express: () => ({
    storage: (
      requireHere("multer") as { memoryStorage: () => unknown }
    ).memoryStorage(),
  }),
  bun: () => ({ storageType: "memory" }),
};

/** Renders every `HttpException` as `{ statusCode, message }`, on both sides. */
@Catch(HttpException)
class UploadErrorShape implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const response = exception.getResponse();
    host
      .switchToHttp()
      .getResponse<{
        status: (code: number) => { json: (body: unknown) => void };
      }>()
      .status(exception.getStatus())
      .json({
        statusCode: exception.getStatus(),
        message:
          typeof response === "object"
            ? (response as { message?: unknown }).message
            : response,
      });
  }
}

/** One group's upload directories: a fresh root, and its cleanup. */
function uploadDirs() {
  let root: string | undefined;
  return {
    /** A fresh directory for one side's uploads to one route. */
    dir: (side: Side, route: string): string => {
      root ??= mkdtempSync(join(tmpdir(), "bun-nest-compat-uploads-"));
      const dir = join(root, side, route);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** Removes every directory this group made. */
    cleanup: (): void => {
      if (root !== undefined) {
        rmSync(root, { recursive: true, force: true });
        root = undefined;
      }
    },
  };
}

/** The pipe group's directories. */
const PIPE_DIRS = uploadDirs();
/** The dest group's directories. */
const DEST_DIRS = uploadDirs();

/** Waits up to `ms` for `dir` to hold no entry; answers how many it holds then. */
async function settledCount(dir: string, ms = 500): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const entries = readdirSync(dir).length;
    if (entries === 0 || Date.now() >= deadline) {
      return entries;
    }
    await Bun.sleep(10);
  }
}

/** Module limits `files: 1` under each route's own limits. */
function moduleLimitsModule(side: Side): new () => object {
  const { FilesInterceptor, MulterModule } = LIBS[side];

  @Controller("up")
  @UseFilters(UploadErrorShape)
  class ModuleLimitsController {
    @Post("merged")
    @UseInterceptors(FilesInterceptor("f", 5, { limits: { fileSize: 1000 } }))
    merged(@UploadedFiles() files: unknown[]) {
      return { count: files.length };
    }

    @Post("small")
    @UseInterceptors(FilesInterceptor("f", 5, { limits: { fileSize: 5 } }))
    small(@UploadedFiles() files: unknown[]) {
      return { count: files.length };
    }
  }

  @Module({
    imports: [MulterModule.register({ limits: { files: 1 } }) as never],
    controllers: [ModuleLimitsController],
  })
  class ModuleLimitsModule {}
  return ModuleLimitsModule;
}

/** Routes with multer 2.4's field-name limits, given and defaulted. */
function fieldNamesModule(side: Side): new () => object {
  const { AnyFilesInterceptor } = LIBS[side];

  @Controller("up")
  @UseFilters(UploadErrorShape)
  class FieldNamesController {
    @Post("limited")
    @UseInterceptors(
      AnyFilesInterceptor({
        limits: { fieldNestingDepth: 1, fieldArrayIndexLimit: 2 },
      }),
    )
    limited(@Body() body: object) {
      // The keys only: bun-common inflates values ("1" → 1), multer does not.
      return { keys: Object.keys(body) };
    }

    @Post("defaults")
    @UseInterceptors(AnyFilesInterceptor())
    defaults(@Body() body: object) {
      return { keys: Object.keys(body) };
    }
  }

  @Module({ controllers: [FieldNamesController] })
  class FieldNamesModule {}
  return FieldNamesModule;
}

/** Disk routes whose request a pipe, or the handler, rejects; and what each left on disk. */
function pipeModule(side: Side): new () => object {
  const { FileInterceptor } = LIBS[side];
  const pipeDir = PIPE_DIRS.dir(side, "pipe");
  const handlerDir = PIPE_DIRS.dir(side, "handler");

  @Controller("up")
  @UseFilters(UploadErrorShape)
  class PipeController {
    @Post("pipe")
    @UseInterceptors(FileInterceptor("file", { dest: pipeDir }))
    pipe(
      @UploadedFile(
        new ParseFilePipe({
          validators: [new MaxFileSizeValidator({ maxSize: 1 })],
        }),
      )
      _file: unknown,
    ) {
      return { reached: true };
    }

    @Get("pipe-stored")
    async pipeStored() {
      return { count: await settledCount(pipeDir) };
    }

    @Post("handler")
    @UseInterceptors(FileInterceptor("file", { dest: handlerDir }))
    handler(): never {
      throw new BadRequestException("the handler refused");
    }

    @Get("handler-stored")
    async handlerStored() {
      return { count: await settledCount(handlerDir, 100) };
    }
  }

  @Module({ controllers: [PipeController] })
  class PipeModule {}
  return PipeModule;
}

/** A route's `dest` under a module-level memory storage. */
function destModule(side: Side): new () => object {
  const { FileInterceptor, MulterModule } = LIBS[side];
  const dest = DEST_DIRS.dir(side, "dest");

  @Controller("up")
  @UseFilters(UploadErrorShape)
  class DestController {
    @Post("dest")
    @UseInterceptors(FileInterceptor("file", { dest }))
    up(@UploadedFile() file: { path?: unknown; buffer?: unknown }) {
      return {
        disk: file.path !== undefined,
        memory: file.buffer !== undefined,
      };
    }

    @Get("dest-stored")
    stored() {
      return { count: readdirSync(dest).length };
    }
  }

  @Module({
    imports: [MulterModule.register(MEMORY_STORAGE[side]()) as never],
    controllers: [DestController],
  })
  class DestModule {}
  return DestModule;
}

/** One module per side, built once. */
function perSide(
  build: (side: Side) => new () => object,
): Record<Side, new () => object> {
  return { express: build("express"), bun: build("bun") };
}

/** A multipart POST of `parts`: `[field, content, filename]` for a file, `[field, value]` for a field. */
function multipart(...parts: [string, string, string?][]): RequestInit {
  const body = new FormData();
  for (const [name, value, filename] of parts) {
    if (filename === undefined) {
      body.append(name, value);
    } else {
      body.append(name, new Blob([value], { type: "text/plain" }), filename);
    }
  }
  return { method: "POST", body };
}

export const UPLOAD_GROUPS: ProbeGroup[] = [
  {
    name: "uploads-module-limits",
    module: perSide(moduleLimitsModule),
    probes: [
      {
        name: "module files:1 + route fileSize, two files",
        path: "/up/merged",
        init: multipart(["f", "a", "a.txt"], ["f", "b", "b.txt"]),
      },
      {
        name: "module files:1 + route fileSize, one file",
        path: "/up/merged",
        init: multipart(["f", "a", "a.txt"]),
      },
      {
        name: "route fileSize, too large",
        path: "/up/small",
        init: multipart(["f", "hello world", "h.txt"]),
      },
    ],
  },
  {
    name: "uploads-field-names",
    module: perSide(fieldNamesModule),
    skip: HAS_FIELD_NAME_CODES
      ? undefined
      : "bun-common does not raise the field-name codes yet (PR-7)",
    probes: [
      {
        name: "nesting deeper than fieldNestingDepth",
        path: "/up/limited",
        init: multipart(["a[b][c]", "1"]),
      },
      {
        name: "array index over fieldArrayIndexLimit",
        path: "/up/limited",
        init: multipart(["arr[5]", "x"]),
      },
      {
        name: "within both limits",
        path: "/up/limited",
        init: multipart(["a[b]", "1"], ["arr[1]", "x"]),
      },
      {
        name: "array index 1001, no limits given",
        path: "/up/defaults",
        init: multipart(["arr[1001]", "x"]),
      },
    ],
  },
  {
    name: "uploads-pipe",
    module: perSide(pipeModule),
    cleanup: PIPE_DIRS.cleanup,
    probes: [
      {
        name: "a pipe rejects the file",
        path: "/up/pipe",
        init: multipart(["file", "hello", "h.txt"]),
      },
      {
        name: "what the pipe's rejection left on disk",
        path: "/up/pipe-stored",
      },
      {
        name: "the handler rejects the request",
        path: "/up/handler",
        init: multipart(["file", "hello", "h.txt"]),
      },
      {
        name: "what the handler's rejection left on disk",
        path: "/up/handler-stored",
      },
    ],
  },
  {
    name: "uploads-dest-storage",
    module: perSide(destModule),
    cleanup: DEST_DIRS.cleanup,
    probes: [
      {
        name: "route dest under a module memory storage",
        path: "/up/dest",
        init: multipart(["file", "hello", "h.txt"]),
      },
      { name: "what the route stored on disk", path: "/up/dest-stored" },
    ],
  },
];

/**
 * The upload differences, each only where the installed Nest has it:
 * capabilities read from platform-express on one side and from Nest on the
 * other, so a column where both agree carries no entry.
 */
export const UPLOAD_KNOWN: Record<string, KnownDifference> = {
  ...(EXPRESS_MERGES_LIMITS === BUN_MERGES_LIMITS
    ? {}
    : {
        "uploads-module-limits/module files:1 + route fileSize, two files": {
          fields: ["status", "body", "content-length", "etag"],
          reason:
            "platform-express merges `limits` key by key from 12.0.4; bun-nest from 12.0.0 (its Nest 12 capability)",
        },
      }),
  ...(EXPRESS_MAPS_ARRAY_INDEX
    ? {}
    : {
        "uploads-field-names/array index over fieldArrayIndexLimit": {
          fields: ["status", "body", "content-length", "etag"],
          reason:
            "platform-express before 12 does not list LIMIT_FIELD_ARRAY_INDEX, so it answers 500; bun-nest answers 400 on every Nest",
        },
      }),
  ...(EXPRESS_DEFAULT_FIELD_LIMITS
    ? {}
    : {
        "uploads-field-names/array index 1001, no limits given": {
          fields: ["status", "body", "content-length", "etag"],
          reason:
            "bun-common defaults fieldArrayIndexLimit to 1000 on every Nest; platform-express only from 12.2.0",
        },
      }),
};
