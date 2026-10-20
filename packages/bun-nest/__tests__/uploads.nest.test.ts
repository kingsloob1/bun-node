/**
 * bun-nest's upload interceptors inside a Nest application, against what
 * `@nestjs/platform-express` does on the installed Nest:
 *
 * - module-level options (`MulterModule.register`/`registerAsync`, bun-nest's
 *   or platform-express's own, one token) merged under each interceptor's,
 *   `limits` key by key on Nest 12 (#17818);
 * - Nest 12.2.0's two upload changes, each gated on the capability the
 *   interceptors read (`isRejectedByPipes`): files removed when a pipe
 *   rejects the request (`acb98de89`), and a route's `dest` replacing the
 *   module's storage (`e075cda3c`).
 *
 * Requests go through `adapter.fetch()`, the production path without a
 * socket. The differential against Express is `expressCompat`'s `uploads`
 * groups.
 */
import type {
  DynamicModule,
  INestApplication,
  PipeTransform,
} from "@nestjs/common";
import type { MulterOptionsFactory } from "../lib/MulterModule";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@kingsleyweb/bun-common";
import {
  BadRequestException,
  Controller,
  Injectable,
  MaxFileSizeValidator,
  Module,
  ParseFilePipe,
  Post,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { MulterModule as ExpressMulterModule } from "@nestjs/platform-express";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  FileInterceptor,
  FilesInterceptor,
  nestIsRejectedByPipes,
} from "../lib/interceptors";
import { MulterModule } from "../lib/MulterModule";
import "reflect-metadata";

/** Nest 12 or later, by the capability the interceptors read (`mapException`). */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/** Nest 12.2.0 or later, by the capability the interceptors read. */
const NEST_12_2 = nestIsRejectedByPipes() !== undefined;

/** Every temporary directory a test made, removed after the file. */
const tempDirs: string[] = [];

/** A fresh, empty directory for one test's uploads. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-nest-uploads-"));
  tempDirs.push(dir);
  return dir;
}

/** A multipart body: `[field, content, filename]` for a file, `[field, value]` for a field. */
function form(...parts: [string, string, string?][]): FormData {
  const fd = new FormData();
  for (const [name, value, filename] of parts) {
    if (filename === undefined) {
      fd.append(name, value);
    } else {
      fd.append(name, new Blob([value], { type: "text/plain" }), filename);
    }
  }
  return fd;
}

/** Waits up to `ms` for `dir` to hold `count` entries; answers how many it holds. */
async function settledCount(
  dir: string,
  count: number,
  ms = 1000,
): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const entries = readdirSync(dir).length;
    if (entries === count || Date.now() >= deadline) {
      return entries;
    }
    await Bun.sleep(10);
  }
}

let app: INestApplication | undefined;
let adapter: BunHttpAdapter | undefined;

/** Boots `module` on a fresh adapter, without a socket. */
async function boot(
  module: new () => object,
  moduleIdGeneratorAlgorithm?: "deep-hash" | "reference",
): Promise<BunHttpAdapter> {
  adapter = new BunHttpAdapter();
  app = await NestFactory.create(module, adapter, {
    logger: false,
    abortOnError: false,
    moduleIdGeneratorAlgorithm,
  });
  await app.init();
  return adapter;
}

/** POSTs `body` to `path`; answers the status and the JSON body. */
async function post(path: string, body: FormData) {
  const res = await adapter!.fetch(path, { method: "POST", body });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null,
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  adapter = undefined;
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `files` uploaded on `f`, at most 5, with a route-level `fileSize`. */
@Controller("u")
class MergeController {
  @Post("merged")
  @UseInterceptors(FilesInterceptor("f", 5, { limits: { fileSize: 1000 } }))
  merged(@UploadedFiles() files: unknown[]) {
    return { count: files.length };
  }
}

/** The module's `limits.files: 1` under the route's `fileSize`, from one of the two `MulterModule`s. */
function mergeModule(multer: DynamicModule): new () => object {
  @Module({ imports: [multer], controllers: [MergeController] })
  class M {}
  return M;
}

/** What two files answer under `files: 1` from the module and `fileSize` from the route. */
const TWO_FILES = NEST_12
  ? { status: 400, message: "Too many files" }
  : { status: 201, count: 2 };

/** The status, and the message or count, of an answer. */
function outcome(answer: Awaited<ReturnType<typeof post>>) {
  return answer.status === 201
    ? { status: answer.status, count: answer.body?.count }
    : { status: answer.status, message: answer.body?.message };
}

describe("module-level upload options", () => {
  const twoFiles = () => form(["f", "a", "a.txt"], ["f", "b", "b.txt"]);

  it("bun-nest's MulterModule.register reaches the interceptor; limits merge key by key on Nest 12, replace on 11", async () => {
    await boot(mergeModule(MulterModule.register({ limits: { files: 1 } })));
    expect(outcome(await post("/u/merged", twoFiles()))).toEqual(TWO_FILES);
    // One file passes the merged limits.
    expect(outcome(await post("/u/merged", form(["f", "a", "a.txt"])))).toEqual(
      { status: 201, count: 1 },
    );
  });

  it("platform-express's own MulterModule.register reaches it too (one token)", async () => {
    await boot(
      mergeModule(ExpressMulterModule.register({ limits: { files: 1 } })),
    );
    expect(outcome(await post("/u/merged", twoFiles()))).toEqual(TWO_FILES);
  });

  it("registerAsync with useFactory and inject", async () => {
    const LIMITS = "LIMITS";
    @Module({
      providers: [{ provide: LIMITS, useValue: { files: 1 } }],
      exports: [LIMITS],
    })
    class LimitsModule {}
    await boot(
      mergeModule(
        MulterModule.registerAsync({
          imports: [LimitsModule],
          useFactory: (limits: { files: number }) => ({ limits }),
          inject: [LIMITS],
        }),
      ),
    );
    expect(outcome(await post("/u/merged", twoFiles()))).toEqual(TWO_FILES);
  });

  it("registerAsync with useClass, and with useExisting", async () => {
    @Injectable()
    class UploadConfig implements MulterOptionsFactory {
      createMulterOptions() {
        return { limits: { files: 1 } };
      }
    }
    await boot(
      mergeModule(MulterModule.registerAsync({ useClass: UploadConfig })),
    );
    expect(outcome(await post("/u/merged", twoFiles()))).toEqual(TWO_FILES);
    await app!.close();

    @Module({ providers: [UploadConfig], exports: [UploadConfig] })
    class ConfigModule {}
    await boot(
      mergeModule(
        MulterModule.registerAsync({
          imports: [ConfigModule],
          useExisting: UploadConfig,
        }),
      ),
    );
    expect(outcome(await post("/u/merged", twoFiles()))).toEqual(TWO_FILES);
  });

  it.each(["reference", "deep-hash"] as const)(
    "keeps two registrations apart: each feature module gets its own options (module ids by %s)",
    async (moduleIdGeneratorAlgorithm) => {
      @Controller("one")
      class OneController {
        @Post()
        @UseInterceptors(FilesInterceptor("f", 5))
        up(@UploadedFiles() files: unknown[]) {
          return { count: files.length };
        }
      }
      @Controller("three")
      class ThreeController {
        @Post()
        @UseInterceptors(FilesInterceptor("f", 5))
        up(@UploadedFiles() files: unknown[]) {
          return { count: files.length };
        }
      }
      @Module({
        imports: [MulterModule.register({ limits: { files: 1 } })],
        controllers: [OneController],
      })
      class OneModule {}
      @Module({
        imports: [MulterModule.register({ limits: { files: 3 } })],
        controllers: [ThreeController],
      })
      class ThreeModule {}
      @Module({ imports: [OneModule, ThreeModule] })
      class Root {}

      // Under "deep-hash" two registrations differing only in the options
      // their factory closes over hash alike, but for the random id each
      // provides (MULTER_MODULE_ID, as platform-express).
      await boot(Root, moduleIdGeneratorAlgorithm);
      expect((await post("/one", twoFiles())).status).toBe(400);
      expect(outcome(await post("/three", twoFiles()))).toEqual({
        status: 201,
        count: 2,
      });
    },
  );
});

describe("a storage without storageType is refused at bootstrap", () => {
  /** A module whose one route uploads with `route` options, under `multer`'s module options. */
  function storageModule(
    route: object,
    multer?: DynamicModule,
  ): new () => object {
    @Controller("st")
    class StorageController {
      @Post()
      @UseInterceptors(FileInterceptor("file", route))
      up(@UploadedFile() file: { type: string }) {
        return { type: file.type };
      }
    }
    @Module({
      imports: multer ? [multer] : [],
      controllers: [StorageController],
    })
    class M {}
    return M;
  }

  /** What booting `module` does: `"booted"`, or the error it was refused with. */
  async function bootOutcome(module: new () => object) {
    try {
      await boot(module);
      return "booted";
    } catch (error) {
      return error;
    }
  }

  it('throws a TypeError naming storageType "custom" for a route\'s storage, before any request', async () => {
    const error = await bootOutcome(
      storageModule({ storage: new MemoryStorage() }),
    );
    expect(error).toBeInstanceOf(TypeError);
    // Key words only: the wording may be aligned with bun-common's later.
    expect((error as TypeError).message).toMatch(
      /storage\b.+storageType.*"custom"/,
    );
  });

  it("throws for a module's storage that the route's options leave without a storageType", async () => {
    const error = await bootOutcome(
      storageModule(
        { limits: { fileSize: 10 } },
        MulterModule.register({ storage: new MemoryStorage() }),
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
  });

  it(`${NEST_12_2 ? "boots" : "throws"} when a route's dest meets a module's storage without storageType (12.2.0's dest rule)`, async () => {
    const outcome = await bootOutcome(
      storageModule(
        { dest: tempDir() },
        MulterModule.register({ storage: new MemoryStorage() }),
      ),
    );
    if (NEST_12_2) {
      expect(outcome).toBe("booted");
      expect((await post("/st", form(["file", "x", "x.txt"]))).body).toEqual({
        type: "disk",
      });
    } else {
      expect(outcome).toBeInstanceOf(TypeError);
    }
  });

  it("boots with an explicit storageType custom", async () => {
    expect(
      await bootOutcome(
        storageModule({ storageType: "custom", storage: new MemoryStorage() }),
      ),
    ).toBe("booted");
    expect((await post("/st", form(["file", "x", "x.txt"]))).body).toEqual({
      type: "memory",
    });
  });
});

describe("Nest 12.2.0's upload changes, gated on the installed Nest", () => {
  /** A pipe that rejects every request. */
  class Reject implements PipeTransform {
    transform(): never {
      throw new BadRequestException("rejected by the pipe");
    }
  }

  /** Routes storing on disk at `dest`, each failing a different way. */
  function diskModule(dest: string): new () => object {
    @Controller("d")
    class DiskController {
      @Post("pipe")
      @UseInterceptors(FileInterceptor("file", { dest }))
      pipe(
        @UploadedFile(
          new ParseFilePipe({
            validators: [new MaxFileSizeValidator({ maxSize: 1 })],
          }),
        )
        file: unknown,
      ) {
        return { file: Boolean(file) };
      }

      @Post("custom-pipe")
      @UseInterceptors(FilesInterceptor("file", 2, { dest }))
      customPipe(@UploadedFiles(new Reject()) files: unknown) {
        return { files };
      }

      @Post("handler")
      @UseInterceptors(FileInterceptor("file", { dest }))
      handler(): never {
        throw new BadRequestException("rejected by the handler");
      }

      @Post("ok")
      @UseInterceptors(FileInterceptor("file", { dest }))
      ok() {
        return { ok: true };
      }
    }
    @Module({ controllers: [DiskController] })
    class M {}
    return M;
  }

  it(`${NEST_12_2 ? "removes" : "keeps (before 12.2.0)"} the stored files when a pipe rejects the request`, async () => {
    const dest = tempDir();
    await boot(diskModule(dest));

    const answer = await post("/d/pipe", form(["file", "hello", "h.txt"]));
    expect(answer.status).toBe(400);
    expect(await settledCount(dest, NEST_12_2 ? 0 : 1)).toBe(NEST_12_2 ? 0 : 1);

    // Every file of a multi-file upload, by any pipe.
    const dest2 = tempDir();
    await app!.close();
    await boot(diskModule(dest2));
    const many = await post(
      "/d/custom-pipe",
      form(["file", "a", "a.txt"], ["file", "b", "b.txt"]),
    );
    expect(many).toEqual({
      status: 400,
      body: expect.objectContaining({ message: "rejected by the pipe" }),
    });
    expect(await settledCount(dest2, NEST_12_2 ? 0 : 2)).toBe(
      NEST_12_2 ? 0 : 2,
    );
  });

  it("keeps the stored files when the handler fails, or succeeds, on every Nest", async () => {
    const dest = tempDir();
    await boot(diskModule(dest));

    expect(
      (await post("/d/handler", form(["file", "x", "x.txt"]))).status,
    ).toBe(400);
    expect((await post("/d/ok", form(["file", "y", "y.txt"]))).status).toBe(
      201,
    );
    // Give a (wrong) removal the time the pipe case is given.
    await Bun.sleep(100);
    expect(readdirSync(dest).length).toBe(2);
  });

  it(`${NEST_12_2 ? "lets a route's dest replace" : "keeps (before 12.2.0)"} the module's storage`, async () => {
    const dest = tempDir();
    @Controller("s")
    class StorageController {
      @Post()
      @UseInterceptors(FileInterceptor("file", { dest }))
      up(@UploadedFile() file: { type: string }) {
        return { type: file.type };
      }
    }
    @Module({
      imports: [MulterModule.register({ storageType: "memory" })],
      controllers: [StorageController],
    })
    class M {}
    await boot(M);

    const answer = await post("/s", form(["file", "hello", "h.txt"]));
    expect(answer).toEqual({
      status: 201,
      body: { type: NEST_12_2 ? "disk" : "memory" },
    });
    expect(readdirSync(dest).length).toBe(NEST_12_2 ? 1 : 0);
  });
});
