/**
 * Module-level upload options: `MulterModule.register()` and
 * `registerAsync()` from `@kingsleyweb/bun-nest`, and
 * `@nestjs/platform-express`'s own `MulterModule`, feeding bun-nest's
 * interceptors — asserted.
 *
 * ```bash
 * bun 03-file-uploads/module-options.ts
 * ```
 *
 * Worth knowing:
 *
 * - `MulterModule.register(options)` gives every upload interceptor of the
 *   importing module default options, as platform-express's does.
 *   `registerAsync()` takes `{ useFactory, inject, imports }`, `{ useClass }`
 *   or `{ useExisting }`.
 * - It provides platform-express's `MULTER_MODULE_OPTIONS` token, the same
 *   string, so an application importing platform-express's `MulterModule`
 *   keeps working when it moves to these interceptors.
 * - Options are multer-style: `storageType` may be left out. `{ dest }` alone
 *   is disk storage at `dest`; anything else is memory. A `storage` needs
 *   `storageType: "custom"` beside it.
 * - Each interceptor merges the module's options under its own
 *   (`mergeUploadOptions`, platform-express's `mergeMulterOptions`): the
 *   route's keys win. How `limits` merge (key by key on Nest 12, replaced on
 *   11) is in `10-options/interceptor-options.ts`, because a limit applies
 *   only where the interceptor parses the body.
 * - From Nest 12.2.0 a route's `dest`, given without a `storage` or
 *   `storageType`, replaces the module's storage: the route's files go to
 *   disk at that `dest`. Before 12.2.0 the module's storage wins, as multer
 *   prefers `storage` to `dest`. This example reads the capability the
 *   adapter gates it on, `isRejectedByPipes` in `@nestjs/core/internal`
 *   (12.2.0), never a version string, and says on a line starting
 *   `skipped:`, naming the installed version, which check sat out.
 * - Every file here goes to a temporary directory, removed at the end.
 */
import type {
  DiskStorageFile,
  MemoryStorageFile,
  StorageFile,
} from "@kingsleyweb/bun-common";
import type {
  MulterModuleOptions,
  MulterOptionsFactory,
} from "@kingsleyweb/bun-nest";
import type { DynamicModule } from "@nestjs/common";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorage } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  FileInterceptor,
  MULTER_MODULE_OPTIONS,
  MulterModule,
  UploadedFile,
} from "@kingsleyweb/bun-nest";
import {
  Controller,
  HttpCode,
  Injectable,
  Module,
  Post,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MulterModule as ExpressMulterModule } from "@nestjs/platform-express";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { coreHasIsRejectedByPipes, nestCoreVersion } from "../shared/nest";
import "reflect-metadata";

/** The installed `@nestjs/core`'s version. */
const NEST_VERSION = await nestCoreVersion();

/** Whether a route's `dest` replaces the module's storage (12.2.0). */
const ROUTE_DEST_WINS = await coreHasIsRejectedByPipes();

/** Where every upload of this run is written; removed at the end. */
const scratch = await mkdtemp(join(tmpdir(), "bun-nest-module-options-"));

/** One directory per source of options, so a file's `dest` names its source. */
const dirs = {
  register: join(scratch, "register"),
  route: join(scratch, "route"),
  factory: join(scratch, "factory"),
  useClass: join(scratch, "use-class"),
  useExisting: join(scratch, "use-existing"),
  express: join(scratch, "express"),
  moduleStorage: join(scratch, "module-storage"),
  routeOverStorage: join(scratch, "route-over-storage"),
};

/** What a handler reports about the one file it got. */
function where(file: StorageFile | undefined) {
  if (!file) return { storage: null, dest: null };
  const stored = file as DiskStorageFile | MemoryStorageFile;
  return {
    storage: stored.type,
    dest: stored.type === "disk" ? (stored.dest ?? null) : null,
  };
}

/**
 * A controller at `path` with two upload routes: `POST /<path>` takes the
 * module's options alone, `POST /<path>/<extra>` adds a route's own.
 */
function uploadsController(
  path: string,
  routeOptions: Parameters<typeof FileInterceptor>[1] = {},
) {
  @Controller(path)
  class UploadsController {
    @Post()
    @HttpCode(200)
    @UseInterceptors(FileInterceptor("f"))
    moduleOnly(@UploadedFile() file: StorageFile | undefined) {
      return where(file);
    }

    @Post("route")
    @HttpCode(200)
    @UseInterceptors(FileInterceptor("f", routeOptions))
    withRoute(@UploadedFile() file: StorageFile | undefined) {
      return where(file);
    }
  }
  return UploadsController;
}

/** A feature module at `path`, importing `multer` (a `MulterModule` registration). */
function feature(
  path: string,
  multer: DynamicModule,
  routeOptions?: Parameters<typeof FileInterceptor>[1],
) {
  @Module({
    imports: [multer],
    controllers: [uploadsController(path, routeOptions)],
  })
  class FeatureModule {}
  return FeatureModule;
}

/* ------------------------------------------------------------------ */
/** The token `registerAsync`'s `useFactory` reads its directory from. */
const UPLOAD_DIR = "UPLOAD_DIR";

/** Provides {@link UPLOAD_DIR}, as a config module would. */
@Module({
  providers: [{ provide: UPLOAD_DIR, useValue: dirs.factory }],
  exports: [UPLOAD_DIR],
})
class ConfigModule {}

/** A `MulterOptionsFactory`, for `registerAsync({ useClass })`. */
@Injectable()
class UseClassOptions implements MulterOptionsFactory {
  createMulterOptions() {
    return { dest: dirs.useClass };
  }
}

/** A `MulterOptionsFactory` another module provides, for `useExisting`. */
@Injectable()
class SharedOptions implements MulterOptionsFactory {
  createMulterOptions(): Promise<MulterModuleOptions> {
    return Promise.resolve({ dest: dirs.useExisting });
  }
}

/** Provides {@link SharedOptions} for `useExisting` to reuse. */
@Module({ providers: [SharedOptions], exports: [SharedOptions] })
class SharedOptionsModule {}

@Module({
  imports: [
    // `register`: the module's `dest`; its "route" route adds `storageType: "memory"`.
    feature("register", MulterModule.register({ dest: dirs.register }), {
      storageType: "memory",
    }),
    // The route's own `dest` beside the module's: the route's key wins.
    feature("register-dest", MulterModule.register({ dest: dirs.register }), {
      dest: dirs.route,
    }),
    feature(
      "factory",
      MulterModule.registerAsync({
        imports: [ConfigModule],
        useFactory: (dir: string) => ({ dest: dir }),
        inject: [UPLOAD_DIR],
      }),
    ),
    feature(
      "use-class",
      MulterModule.registerAsync({ useClass: UseClassOptions }),
    ),
    feature(
      "use-existing",
      MulterModule.registerAsync({
        imports: [SharedOptionsModule],
        useExisting: SharedOptions,
      }),
    ),
    // platform-express's own module, feeding bun-nest's interceptors.
    feature("express", ExpressMulterModule.register({ dest: dirs.express })),
    // A module storage, and a route `dest` with no storage of its own.
    feature(
      "module-storage",
      MulterModule.register({
        storageType: "custom",
        storage: new DiskStorage({
          dest: dirs.moduleStorage,
          removeAfter: false,
        }),
      }),
      { dest: dirs.routeOverStorage },
    ),
  ],
})
class AppModule {}

/* ------------------------------------------------------------------ */
title("MulterModule: module-level upload options");
show("@nestjs/core", NEST_VERSION);

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
});
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Posts one small file as field `f` to `path`; answers the status and where it went. */
async function upload(path: string) {
  const body = new FormData();
  body.append("f", new File(["hello"], "hello.txt", { type: "text/plain" }));
  const response = await fetch(`${url}${path}`, { method: "POST", body });
  const stored = (await response.json()) as {
    /** The storage's type, or `null` when no file arrived. */
    storage: string | null;
    /** A disk file's directory, else `null`. */
    dest: string | null;
  };
  return { status: response.status, ...stored };
}

/** How many files are in `dir` now; `0` when it was never created. */
async function filesIn(dir: string): Promise<number> {
  return (await readdir(dir).catch(() => [])).length;
}

/* ------------------------------------------------------------------ */
step("MulterModule.register(options)");

const registered = await upload("/register");
show("POST /register", registered);
checkEqual(
  "the module's { dest } reaches the interceptor: disk storage at that dest, no storageType needed",
  registered,
  { status: 200, storage: "disk", dest: dirs.register },
);
checkEqual(
  "the route's options win: storageType: \"memory\" on the route over the module's dest",
  await upload("/register/route"),
  { status: 200, storage: "memory", dest: null },
);
checkEqual(
  "…and the route's own dest over the module's",
  await upload("/register-dest/route"),
  { status: 200, storage: "disk", dest: dirs.route },
);

/* ------------------------------------------------------------------ */
step("MulterModule.registerAsync({ useFactory | useClass | useExisting })");

checkEqual(
  "useFactory, its inject token from an imported module",
  await upload("/factory"),
  { status: 200, storage: "disk", dest: dirs.factory },
);
checkEqual(
  "useClass: the module instantiates a MulterOptionsFactory",
  await upload("/use-class"),
  { status: 200, storage: "disk", dest: dirs.useClass },
);
checkEqual(
  "useExisting: a provider another module exports, its createMulterOptions() answering a promise",
  await upload("/use-existing"),
  { status: 200, storage: "disk", dest: dirs.useExisting },
);

/* ------------------------------------------------------------------ */
step("@nestjs/platform-express's MulterModule");

const expressProviders = ExpressMulterModule.register({}).providers ?? [];
check(
  "it provides the same token, MULTER_MODULE_OPTIONS",
  expressProviders.some(
    (provider) =>
      typeof provider === "object" &&
      provider.provide === MULTER_MODULE_OPTIONS,
  ),
  expressProviders,
);
checkEqual(
  "…so bun-nest's interceptors read its options",
  await upload("/express"),
  { status: 200, storage: "disk", dest: dirs.express },
);

/* ------------------------------------------------------------------ */
step("A module storage, and a route's dest");

checkEqual(
  'the module\'s storageType: "custom" storage, where the route gives nothing',
  await upload("/module-storage"),
  { status: 200, storage: "disk", dest: dirs.moduleStorage },
);

const overStorage = await upload("/module-storage/route");
show("POST /module-storage/route", overStorage);
if (ROUTE_DEST_WINS) {
  checkEqual(
    "12.2.0: a route's dest with no storage of its own replaces the module's storage",
    [overStorage, await filesIn(dirs.routeOverStorage)],
    [{ status: 200, storage: "disk", dest: dirs.routeOverStorage }, 1],
  );
} else {
  checkEqual(
    "before 12.2.0: the module's storage wins over a route's dest, as multer prefers storage",
    [overStorage, await filesIn(dirs.routeOverStorage)],
    [{ status: 200, storage: "disk", dest: dirs.moduleStorage }, 0],
  );
  show(
    `skipped: a route's dest replaces the module's storage from Nest 12.2.0 (isRejectedByPipes); 1 check skipped on Nest ${NEST_VERSION}`,
  );
}
checkEqual(
  "isRejectedByPipes, the capability read, arrives with Nest 12.2.0",
  ROUTE_DEST_WINS,
  Bun.semver.satisfies(NEST_VERSION, ">=12.2.0"),
);

/* ------------------------------------------------------------------ */
step("A storage without storageType");

await checkRejects(
  'a module storage without storageType: "custom" fails the bootstrap',
  async () => {
    const bad = await NestFactory.create(
      feature(
        "bad",
        MulterModule.register({
          storage: new DiskStorage({ dest: scratch }),
        }),
      ),
      new BunHttpAdapter(),
      { logger: false, abortOnError: false },
    );
    await bad.close();
  },
  { name: "TypeError", message: /storageType "custom"/ },
);

await app.close();
await rm(scratch, { recursive: true, force: true });
show("closed, temporary files removed");
summary();
