/**
 * A real dev server for the watcher's tests: a `BunHttpAdapter` on port 0
 * with bun-common's `devTypes()` mounted, writing its token file under a
 * test's own directory (`<dir>/node_modules/.cache/bun-types/<port>.json`,
 * where the CLI looks when run with `cwd: dir`).
 */
import type {
  DevTypesOptions,
  DevTypesRouter,
} from "@kingsleyweb/bun-common/lib/docs";
import {
  BunHttpAdapter,
  createTestLogger,
  validate,
} from "@kingsleyweb/bun-common";
import { devTypes } from "@kingsleyweb/bun-common/lib/docs";
import { join } from "node:path";
import { z } from "zod";

/** A running dev server. */
export interface DevServerFixture {
  /** The app: add routes to it at run time. */
  readonly app: BunHttpAdapter;
  /** The mounted sync. */
  readonly dev: DevTypesRouter;
  /** The port it listens on. */
  readonly port: number;
  /** The documents endpoint. */
  readonly url: string;
  /** Adds `GET <path>` answering `{ ok: true }`, declared, so it changes the documents. */
  readonly addRoute: (path: string) => void;
  /** Stops it: the sync's close (the token file removed, watchers told), then the server. */
  readonly close: () => Promise<void>;
}

/** Where a fixture server in `dir` writes its token file. */
export function tokenFileTemplate(dir: string): string {
  return join(dir, "node_modules", ".cache", "bun-types", "<port>.json");
}

/** A response schema, so every route is typed in the documents. */
const Ok = z.object({ ok: z.boolean() });

/**
 * Starts a dev server.
 *
 * @param options.dir The test's directory: the token file goes under it, unless `tokenFile` says otherwise.
 * @param options.path The endpoint path. Default: a unique one per server, so no two share `devTypes()`'s per-path hub.
 * @param options.token The bearer token. Default: a fresh random one per server (as a restarted process has).
 * @param options.tokenFile The token file template, or `false`. Default: {@link tokenFileTemplate}.
 * @param options.routes Paths of extra `GET` routes. Default: none.
 * @param options.documents Named documents (`devTypes()`'s `documents`). Default: none.
 */
export async function startDevServer(options: {
  readonly dir: string;
  readonly path?: string;
  readonly token?: string;
  readonly tokenFile?: string | false;
  readonly routes?: readonly string[];
  readonly documents?: DevTypesOptions["documents"];
}): Promise<DevServerFixture> {
  const { logger } = createTestLogger();
  const app = new BunHttpAdapter(0, { logger });
  const addRoute = (path: string) => {
    app.get(path, validate({}, { responses: { 200: Ok } }), (_req, res) => {
      res.json({ ok: true });
    });
  };
  app.get(
    "/users/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      { responses: { 200: z.object({ id: z.string(), name: z.string() }) } },
    ),
    (req, res) => {
      res.json({ id: req.params.id, name: "Ada" });
    },
  );
  for (const path of options.routes ?? []) addRoute(path);
  const path = options.path ?? uniquePath();
  const dev = devTypes(app, {
    enabled: true,
    path,
    token: options.token ?? randomToken(),
    tokenFile:
      options.tokenFile === undefined
        ? tokenFileTemplate(options.dir)
        : options.tokenFile,
    openapi: { title: "API", version: "1" },
    asyncapi: { title: "API", version: "1" },
    ...(options.documents === undefined
      ? {}
      : { documents: options.documents }),
  });
  app.use(dev);
  const server = await app.listen(0, "127.0.0.1");
  const port = Number(server.port);
  return {
    app,
    dev,
    port,
    url: `http://127.0.0.1:${port}${path}`,
    addRoute,
    close: async () => {
      dev.close();
      await app.close();
    },
  };
}

/** A fresh token: what a restarted server process generates. */
export function randomToken(): string {
  return `t-${crypto.randomUUID()}`;
}

let pathCounter = 0;
/** A unique endpoint path. */
function uniquePath(): string {
  pathCounter += 1;
  return `/__bun/types${pathCounter}`;
}
