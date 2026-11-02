/**
 * The typed-client section of the playground (`/playground/client`, the page
 * in `typed-client-page.ts`): `@kingsleyweb/bun-client` against a small API
 * (`typed-client-api.ts`) mounted on the playground's adapter, with its
 * generated route map (`typed-client-api.gen.ts`) and zod schemas
 * (`typed-client-api.zod.gen.ts`) committed beside it.
 *
 * - **The generated module**: the API's OpenAPI document beside the module
 *   `bun-client generate` wrote from it, its `typesHash` and its warnings.
 *   `POST /playground/client/regenerate` runs `runCli` in process (the step
 *   `bun-client watch` runs) against the section's dev endpoint and answers
 *   the diff against the committed file, and `--module … --check` (the CI
 *   form) beside it.
 * - **Live typed calls** (`POST /playground/client/run/:scenario`): the
 *   client runs here, on the server, with `createClient<Routes>({ manifest,
 *   schemas })` over the adapter's socket-free `fetch()`. Each scenario's
 *   code is shown in the page as it is written below, between its
 *   `// #region` markers, type assertions included: `bun scripts/typecheck.ts`
 *   checks those, so the types the page claims are the types the code has.
 *   Each answer carries what the client sent (every attempt, at the
 *   client's `fetch`), what the API saw, and the client's warnings.
 * - **The dev endpoint**: bun-common's `devTypes()` at
 *   `/playground/client/__bun/types`, documenting this API only, on in
 *   development (`NODE_ENV` not `production`), loopback peers only, behind
 *   a random bearer token written to its token file (never answered by any
 *   route here). `POST /playground/client/drift` mounts one more route at run
 *   time, so the endpoint's hash moves and a running `bun-client watch`
 *   rewrites its file. The page shows the command.
 */
import type { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { DevTypesRouter } from "@kingsleyweb/bun-common/lib/docs";
import type { ClientMiddleware } from "@kingsleyweb/bun-client";
import type { ServerHit } from "./typed-client-api";
import type { Routes } from "./typed-client-api.gen";
import { join } from "node:path";
import process from "node:process";
import {
  devTypes,
  generateAsyncApi,
  generateOpenApi,
} from "@kingsleyweb/bun-common/lib/docs";
import {
  createClient,
  HttpError,
  TimeoutError,
  UnexpectedStatusError,
  ValidationError,
} from "@kingsleyweb/bun-client";
import { runCli } from "@kingsleyweb/bun-client/codegen";
import {
  invalidateTags,
  observe,
  queries,
  tagsOfQuery,
} from "@kingsleyweb/bun-client/query";
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { z } from "zod/mini";
import { createApi } from "./typed-client-api";
import { manifest } from "./typed-client-api.gen";
import { typedClientPage } from "./typed-client-page";

// The generated zod module is `zod/mini`, whose messages read "Invalid input"
// until a locale is loaded; English, so the page's issues say what failed.
// (Classic zod, which the rest of the playground uses, loads it anyway.)
z.config(z.locales.en());

/** The section's mount point. */
export const CLIENT_BASE = "/playground/client";

/** Where the dev endpoint is served (bun-common's `devTypes({ path })`). */
export const DEV_TYPES_PATH = `${CLIENT_BASE}/__bun/types`;

/** The options the API is documented with, by the CLI's `--module` and by the dev endpoint alike. */
const DOCUMENT_INFO = { title: "API", version: "1" } as const;

/** The playground directory. */
const HERE = import.meta.dir;

/** The API module, the generated module and the generated zod module, relative to {@link HERE}. */
export const FILES = {
  api: "typed-client-api.ts",
  gen: "typed-client-api.gen.ts",
  zod: "typed-client-api.zod.gen.ts",
} as const;

/** The commands that write and check the generated files, run in `playground/`. */
export const GENERATE_ARGS = [
  "generate",
  "--module",
  FILES.api,
  "--out",
  FILES.gen,
  "--zod",
  FILES.zod,
] as const;

/** One request the client sent, as its `fetch` saw it. */
export interface SentRequest {
  /** Milliseconds since the scenario started. */
  at: number;
  /** The method. */
  method: string;
  /** The URL's path and query. */
  url: string;
  /** The request headers this page cares about, when sent. */
  headers: Record<string, string>;
  /** The status, or the error the fetch failed with. */
  status: number | string;
  /** The response headers this page cares about, when present. */
  response: Record<string, string>;
}

/** What one scenario run answers. */
export interface ScenarioRun {
  /** The scenario's name. */
  name: ScenarioName;
  /** Whether it ran to the end. */
  ok: boolean;
  /** What it returned, or the error it threw. */
  outcome: unknown;
  /** What the client's `fetch` sent, in order. */
  sent: SentRequest[];
  /** What the API saw while it ran (`typed-client-api.ts`'s request log). */
  server: Omit<ServerHit, "seq">[];
  /** What the client logged through `logger.warn` (validation warnings). */
  warnings: string[];
  /** How long it took, in ms. */
  ms: number;
}

/** The request headers the sent-request log keeps. */
const REQUEST_HEADERS = ["x-request-id", "if-none-match"];
/** The response headers the sent-request log keeps. */
const RESPONSE_HEADERS = ["retry-after", "etag", "x-cache", "cache-tag"];

/** `true` when `X` and `Y` are the same type (for the scenarios' compile-time assertions). */
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

/** The scenarios' names. */
export type ScenarioName =
  | "ok"
  | "not-found"
  | "op"
  | "throw-on-error"
  | "undeclared"
  | "retry-after"
  | "timeout"
  | "middleware"
  | "request-invalid"
  | "response-invalid"
  | "query-key"
  | "etag-304"
  | "invalidates"
  | "cache-tag";

/** One scenario, as the page lists it. */
export interface ScenarioInfo {
  /** Its name (the run route's `:scenario`). */
  name: ScenarioName;
  /** The page section it belongs in. */
  section: "calls" | "validation" | "query";
  /** A short title. */
  title: string;
  /** What to look for. */
  about: string;
}

/** Every scenario, in the page's order. */
export const SCENARIOS: readonly ScenarioInfo[] = [
  {
    name: "ok",
    section: "calls",
    title: "A 200",
    about:
      "a result discriminated by status: r.ok, then r.data typed from the generated User",
  },
  {
    name: "not-found",
    section: "calls",
    title: "A 404, its code narrowed",
    about:
      'r.error.code is "NOT_FOUND" | "GONE", the route\'s x-bun-errors, not string',
  },
  {
    name: "op",
    section: "calls",
    title: "api.op",
    about:
      'calls by operationId, which the manifest maps to the route; a 409 narrowed to "CONFLICT"',
  },
  {
    name: "throw-on-error",
    section: "calls",
    title: "throwOnError",
    about: "the data itself on a 2xx; a declared error status throws HttpError",
  },
  {
    name: "undeclared",
    section: "calls",
    title: "An undeclared status",
    about:
      "a 418 the manifest does not list throws UnexpectedStatusError, its body unread",
  },
  {
    name: "retry-after",
    section: "calls",
    title: "A retry honouring Retry-After",
    about:
      "a 503 with Retry-After: 1, then the retry about a second later (see the sent timeline)",
  },
  {
    name: "timeout",
    section: "calls",
    title: "A timeout",
    about: "a 2 s answer against a 250 ms timeout: TimeoutError",
  },
  {
    name: "middleware",
    section: "calls",
    title: "Middleware",
    about:
      "one middleware sets x-request-id (the server saw it) and logs; another answers a route itself, so nothing is sent",
  },
  {
    name: "request-invalid",
    section: "validation",
    title: "A request that fails validation",
    about:
      "the generated zod schema refuses the email before anything is sent: ValidationError, and the server saw nothing",
  },
  {
    name: "response-invalid",
    section: "validation",
    title: "A response that fails validation",
    about:
      "the handler drifted from its schema: the client warns through its logger and delivers the body as it arrived",
  },
  {
    name: "query-key",
    section: "query",
    title: "A query keyed by its route",
    about:
      "q.query() gives [routeKey, { params, query }] and the manifest's tags, filled from the params",
  },
  {
    name: "etag-304",
    section: "query",
    title: "ETag and 304",
    about:
      "the refetch sends If-None-Match; the 304 keeps the cached object (the same one), its dataUpdatedAt moved",
  },
  {
    name: "invalidates",
    section: "query",
    title: "A mutation's invalidates",
    about:
      'POST /api/users invalidates "users": the active list query is refetched before the mutation settles',
  },
  {
    name: "cache-tag",
    section: "query",
    title: "Tags from Cache-Tag",
    about:
      'bun-cache\'s cacheResponse({ surrogateKeys: "Cache-Tag" }) sends team:blue from the data; invalidating it refetches org 7, not org 8',
  },
];

/** What the section owns, for the playground's shutdown and the banner. */
export interface TypedClientDemo {
  /** The dev endpoint; its `tokenFile` is known once the adapter listens. */
  readonly dev: DevTypesRouter;
  /** Closes the API's cache and the dev endpoint (removing its token file). */
  stop: () => Promise<void>;
}

/**
 * Mounts the section on the adapter: the API at `/playground/client/api`,
 * the page and its routes, and the dev endpoint.
 */
export async function mountTypedClientDemo(
  app: BunHttpAdapter,
): Promise<TypedClientDemo> {
  const api = createApi();
  let drifted = false;
  /** The router the dev endpoint documents: the API, and the extra route once it is mounted. */
  const documented = () => (drifted ? api.withExtra() : api.router);

  const dev = devTypes(app, {
    enabled: process.env.NODE_ENV !== "production",
    path: DEV_TYPES_PATH,
    // The repository's own `node_modules/.cache/bun-types/`, wherever the
    // playground was started from: `bun-client watch` run anywhere in the
    // repository finds it there (it reads the nearest such directory up
    // from its working directory), and no `playground/node_modules/` appears.
    tokenFile: join(
      HERE,
      "..",
      "node_modules",
      ".cache",
      "bun-types",
      "<port>.json",
    ),
    openapi: () => generateOpenApi(documented(), DOCUMENT_INFO).document,
    asyncapi: () => generateAsyncApi(documented(), DOCUMENT_INFO).document,
  });
  app.use(dev);
  app.use(CLIENT_BASE, api.router);

  const snippets = await readSnippets();

  /**
   * A fresh client, query layer and query client for one run, whose `fetch`
   * records every request it sends and whose `logger` keeps the warnings.
   */
  function makeKit(started: number) {
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const client = createClient<Routes>({
      baseUrl: `http://playground.local${CLIENT_BASE}`,
      // In process, through the adapter's real pipeline: no socket.
      fetch: async (request) => {
        const url = new URL(request.url);
        const entry: SentRequest = {
          at: Math.round(performance.now() - started),
          method: request.method,
          url: `${url.pathname.slice(CLIENT_BASE.length)}${url.search}`,
          headers: pick(request.headers, REQUEST_HEADERS),
          status: "pending",
          response: {},
        };
        sent.push(entry);
        try {
          const response = await app.fetch(request);
          entry.status = response.status;
          entry.response = pick(response.headers, RESPONSE_HEADERS);
          return response;
        } catch (error) {
          entry.status = (error as Error).name;
          throw error;
        }
      },
      manifest,
      // The generated zod module, loaded on the first call that validates.
      schemas: () => import("./typed-client-api.zod.gen"),
      // Validation on whatever NODE_ENV says, so the section always shows it.
      mode: "development",
      // Retries only where a scenario asks for them.
      retry: false,
      logger: {
        warn: (...args: unknown[]) =>
          void warnings.push(args.map(text).join(" ")),
        error: (...args: unknown[]) =>
          void warnings.push(args.map(text).join(" ")),
        debug: () => {},
      },
    });
    const q = queries(client, { manifest });
    // Fresh until invalidated, so a subscription after a fetch does not
    // fetch again; a scenario asks for a refetch with `staleTime: 0`.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    return { api: client, q, queryClient, sent, warnings };
  }

  /** One kit, as the scenarios receive it. */
  type Kit = ReturnType<typeof makeKit>;

  /** The scenarios, by name. Each body between `// #region` markers is what the page shows. */
  const scenarios: Record<ScenarioName, (kit: Kit) => Promise<unknown>> = {
    ok: async ({ api }) => {
      // #region ok
      const r = await api.get("/api/users/:id", { params: { id: "42" } });
      if (!r.ok) throw new Error(`expected a 200, got ${r.status}`);
      // r.data is the generated User, read through Jsonify
      const _role: Equal<typeof r.data.role, "admin" | "member"> = true;
      return { status: r.status, data: r.data };
      // #endregion
    },

    "not-found": async ({ api }) => {
      // #region not-found
      const r = await api.get("/api/users/:id", { params: { id: "7" } });
      if (r.ok) throw new Error("expected a 404");
      // narrowed by the route's x-bun-errors
      const _code: Equal<typeof r.error.code, "NOT_FOUND" | "GONE"> = true;
      return { status: r.status, code: r.error.code, error: r.error };
      // #endregion
    },

    op: async ({ api }) => {
      // #region op
      const grace = await api.op.getUser({ params: { id: "43" } });
      const taken = await api.op.createUser({
        body: { name: "Ada again", email: "ada@example.com" },
      });
      if (taken.ok) throw new Error("expected a 409");
      const _conflict: Equal<typeof taken.error.code, "CONFLICT"> = true;
      return {
        getUser: { status: grace.status, data: grace.data },
        createUser: { status: taken.status, code: taken.error.code },
      };
      // #endregion
    },

    "throw-on-error": async ({ api }) => {
      // #region throw-on-error
      // The data itself, no result to unwrap
      const user = await api.get("/api/users/:id", {
        params: { id: "42" },
        throwOnError: true,
      });
      const _email: Equal<typeof user.email, string> = true;
      // A declared error status throws an HttpError
      const error = await api
        .get("/api/users/:id", { params: { id: "7" }, throwOnError: true })
        .catch((e: unknown) => e);
      if (!(error instanceof HttpError)) throw new Error("expected HttpError");
      return {
        user: user.name,
        thrown: { name: error.name, status: error.status, error: error.error },
      };
      // #endregion
    },

    undeclared: async ({ api }) => {
      // #region undeclared
      // The manifest lists 200 for GET /api/brew; it answers 418
      const error = await api.get("/api/brew").catch((e: unknown) => e);
      if (!(error instanceof UnexpectedStatusError))
        throw new Error("expected UnexpectedStatusError");
      return {
        name: error.name,
        status: error.status,
        declared: error.declared,
        message: error.message,
      };
      // #endregion
    },

    "retry-after": async ({ api, sent }) => {
      // #region retry-after
      // A ticket's first request is a 503 with Retry-After: 1
      const ticket = crypto.randomUUID().slice(0, 8);
      const r = await api.get("/api/flaky/:ticket", {
        params: { ticket },
        retry: { attempts: 2, respectRetryAfter: true },
      });
      // #endregion
      const gap = sent.length >= 2 ? sent[1].at - sent[0].at : undefined;
      return { status: r.status, data: r.data, waitedMs: gap };
    },

    timeout: async ({ api }) => {
      // #region timeout
      const error = await api
        .get("/api/slow", { query: { ms: 2000 }, timeout: 250 })
        .catch((e: unknown) => e);
      if (!(error instanceof TimeoutError))
        throw new Error("expected TimeoutError");
      return {
        name: error.name,
        timeout: error.timeout,
        message: error.message,
      };
      // #endregion
    },

    middleware: async ({ api }) => {
      // #region middleware
      const log: string[] = [];
      const tracing: ClientMiddleware = async (ctx, next) => {
        ctx.request.headers.set(
          "x-request-id",
          `pg-${ctx.attempt}-${ctx.path}`,
        );
        const response = await next();
        log.push(`${ctx.key} → ${response.status}`);
        return response;
      };
      // Answers one route itself, without calling next(): nothing is sent
      const mock: ClientMiddleware = async (ctx, next) =>
        (ctx.options.params as { id?: string } | undefined)?.id === "mock"
          ? Response.json({
              id: "mock",
              name: "Mocked",
              email: "mock@example.com",
              role: "member",
              createdAt: "2026-01-01T00:00:00.000Z",
            })
          : next();
      const real = await api.get("/api/users/:id", {
        params: { id: "42" },
        middleware: [tracing, mock],
      });
      const mocked = await api.get("/api/users/:id", {
        params: { id: "mock" },
        middleware: [tracing, mock],
      });
      return { log, real: real.data, mocked: mocked.data };
      // #endregion
    },

    "request-invalid": async ({ api }) => {
      // #region request-invalid
      // The types allow any string; the generated zod schema checks the format
      const error = await api
        .post("/api/users", { body: { name: "Lin", email: "not-an-email" } })
        .catch((e: unknown) => e);
      if (!(error instanceof ValidationError))
        throw new Error("expected ValidationError");
      return {
        name: error.name,
        direction: error.direction,
        issues: error.issues,
      };
      // #endregion
    },

    "response-invalid": async ({ api, warnings }) => {
      // #region response-invalid
      // The handler answers role "owner", which the User schema refuses
      const r = await api.get("/api/drifted/:id", { params: { id: "9" } });
      if (!r.ok) throw new Error(`expected a 200, got ${r.status}`);
      return { status: r.status, delivered: r.data, warned: warnings.length };
      // #endregion
    },

    "query-key": async ({ q, queryClient }) => {
      // #region query-key
      const user = q.query("/api/users/:id", { params: { id: "42" } });
      const data = await queryClient.fetchQuery(user);
      const cached = queryClient.getQueryData(user.queryKey);
      return {
        queryKey: user.queryKey,
        meta: user.meta,
        name: data.name,
        sameObject: cached === data,
      };
      // #endregion
    },

    "etag-304": async ({ q, queryClient }) => {
      // #region etag-304
      const user = {
        ...q.query("/api/users/:id", { params: { id: "43" } }),
        // Off, so identity is the 304's doing and not structural sharing's
        structuralSharing: false,
      };
      const first = await queryClient.fetchQuery(user);
      const before = queryClient.getQueryState(user.queryKey)!.dataUpdatedAt;
      await Bun.sleep(5);
      // Refetch: sends If-None-Match, the server answers 304
      const again = await queryClient.fetchQuery({ ...user, staleTime: 0 });
      const after = queryClient.getQueryState(user.queryKey)!.dataUpdatedAt;
      return {
        sameObject: again === first,
        dataUpdatedAtMoved: after > before,
      };
      // #endregion
    },

    invalidates: async ({ api, q, queryClient }) => {
      // #region invalidates
      const listOptions = q.query("/api/users");
      await queryClient.fetchQuery(listOptions);
      const list = observe(queryClient, listOptions);
      const stop = list.subscribe(() => {});
      const before = list.getSnapshot().data?.length;
      // POST /api/users declares invalidates: ["users"]; the list is tagged "users"
      const create = new MutationObserver(
        queryClient,
        q.mutation("POST /api/users"),
      );
      const created = await create.mutate({
        body: { name: "Lin", email: `lin-${Date.now()}@example.com` },
      });
      // The mutation settled after the list's refetch
      const after = list.getSnapshot().data?.length;
      stop();
      // #endregion
      // Tidy up, so the API keeps its seed users.
      await api.delete("/api/users/:id", { params: { id: created.id } });
      return { listTags: listOptions.meta.tags, before, after, created };
    },

    "cache-tag": async ({ q, queryClient }) => {
      // #region cache-tag
      const seven = q.query("/api/orgs/:id", { params: { id: "7" } });
      const eight = q.query("/api/orgs/:id", { params: { id: "8" } });
      await queryClient.fetchQuery(seven);
      await queryClient.fetchQuery(eight);
      const stops = [seven, eight].map((o) =>
        observe(queryClient, o).subscribe(() => {}),
      );
      const tagsOf = (o: typeof seven) =>
        tagsOfQuery(
          queryClient,
          queryClient.getQueryCache().find({ queryKey: o.queryKey })!,
        );
      // team:blue came from org 7's Cache-Tag header (addCacheTags on the server)
      const tags = { seven: tagsOf(seven), eight: tagsOf(eight) };
      await invalidateTags(queryClient, ["team:blue"]);
      for (const stop of stops) stop();
      return tags;
      // #endregion
    },
  };

  /** Runs one scenario. */
  async function run(name: ScenarioName): Promise<ScenarioRun> {
    const startedAt = Date.now();
    const started = performance.now();
    // The API's log from here on: hits numbered after the last one now.
    const seen = api.state.seq;
    const kit = makeKit(started);
    let ok = true;
    let outcome: unknown;
    try {
      outcome = await scenarios[name](kit);
    } catch (error) {
      ok = false;
      outcome = {
        thrown: (error as Error).name,
        message: (error as Error).message,
      };
    }
    return {
      name,
      ok,
      outcome,
      sent: kit.sent,
      server: api.state.hits
        .filter((hit) => hit.seq > seen)
        .map(({ seq: _seq, ...hit }) => ({
          ...hit,
          at: hit.at - startedAt,
          url: hit.url.slice(CLIENT_BASE.length),
        })),
      warnings: kit.warnings,
      ms: Math.round(performance.now() - started),
    };
  }

  /** The dev endpoint's URL, from its token file (`undefined` while disabled or not yet listening). */
  async function devUrl(): Promise<string | undefined> {
    if (dev.tokenFile === undefined) return undefined;
    const file = (await Bun.file(dev.tokenFile).json()) as { url?: string };
    return file.url;
  }

  /** `bun-client` in process: its exit status, and what it wrote to each stream. */
  async function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runCli(argv, {
      stdout: (t) => void out.push(t),
      stderr: (t) => void err.push(t),
      cwd: HERE,
    });
    return { argv, exit, stdout: out.join(""), stderr: err.join("") };
  }

  app.get(CLIENT_BASE, (_req, res) => {
    res.type("html").send(typedClientPage(CLIENT_BASE));
  });

  app.get(`${CLIENT_BASE}/state`, async (_req, res) => {
    const gen = await Bun.file(join(HERE, FILES.gen)).text();
    const zod = await Bun.file(join(HERE, FILES.zod)).text();
    const documentedNow = generateOpenApi(documented(), DOCUMENT_INFO);
    const url = await devUrl();
    res.json({
      files: FILES,
      commands: {
        generate: `cd playground && bun run gen:client   # bun-client ${GENERATE_ARGS.join(" ")}`,
        check: `cd playground && bun run check:client  # the same with --check: exit 1 when stale`,
        watch:
          url === undefined || dev.tokenFile === undefined
            ? undefined
            : `bunx bun-client watch --url ${url} --token-file ${dev.tokenFile} --out /tmp/playground-api.gen.ts`,
      },
      generated: {
        hash: headerHash(gen),
        warnings: headerWarnings(gen),
        code: gen,
        zod,
      },
      openapi: {
        document: documentedNow.document,
        warnings: documentedNow.warnings,
      },
      dev: {
        enabled: dev.token !== undefined,
        endpoint: url,
        tokenFile: dev.tokenFile,
        drifted,
      },
      scenarios: SCENARIOS.map((each) => ({
        ...each,
        snippet: snippets.get(each.name) ?? "",
      })),
    });
  });

  app.post(`${CLIENT_BASE}/run/:scenario`, async (req, res) => {
    const name = req.params.scenario as ScenarioName;
    if (!SCENARIOS.some((each) => each.name === name)) {
      res.status(404).json({ error: `no scenario "${name}"` });
      return;
    }
    res.json(await run(name));
  });

  app.post(`${CLIENT_BASE}/regenerate`, async (_req, res) => {
    const committed = await Bun.file(join(HERE, FILES.gen)).text();
    const url = await devUrl();
    // The step `bun-client watch` runs: the dev endpoint's documents, its
    // token read from the token file. Without the endpoint (NODE_ENV is
    // production), the module itself.
    const generated =
      url !== undefined && dev.tokenFile !== undefined
        ? await cli(["generate", "--url", url, "--token-file", dev.tokenFile])
        : await cli(["generate", "--module", FILES.api]);
    const check = await cli([...GENERATE_ARGS, "--check"]);
    res.json({
      source: url === undefined ? "module" : "dev endpoint",
      generate: {
        argv: generated.argv,
        exit: generated.exit,
        stderr: generated.stderr,
        hash: headerHash(generated.stdout),
      },
      committedHash: headerHash(committed),
      same: generated.stdout === committed,
      diff: lineDiff(committed, generated.stdout),
      check: { argv: check.argv, exit: check.exit, stderr: check.stderr },
      drifted,
    });
  });

  app.post(`${CLIENT_BASE}/drift`, (_req, res) => {
    if (!drifted) {
      // Served from now on; and the adapter's route set moved, so the dev
      // endpoint rebuilds its documents (from `documented()`, now with the
      // extra route) and announces the new hash to every watcher.
      app.use(CLIENT_BASE, api.extraRouter);
      drifted = true;
    }
    res.json({ drifted, route: "GET /api/users/:id/badge" });
  });

  return {
    dev,
    stop: async () => {
      dev.close();
      await api.cache.close();
    },
  };
}

/** The scenario bodies between `// #region <name>` and `// #endregion` in this file, dedented. */
async function readSnippets(): Promise<Map<string, string>> {
  const source = await Bun.file(import.meta.path).text();
  const snippets = new Map<string, string>();
  for (const match of source.matchAll(
    /^[ \t]*\/\/ #region (\S+)\n([\s\S]*?)\n[ \t]*\/\/ #endregion/gm,
  )) {
    const lines = match[2].split("\n");
    const indent = Math.min(
      ...lines
        .filter((line) => line.trim() !== "")
        .map((line) => /^ */.exec(line)![0].length),
    );
    snippets.set(match[1], lines.map((line) => line.slice(indent)).join("\n"));
  }
  return snippets;
}

/** The `typesHash` a generated module's header records. */
export function headerHash(code: string): string | undefined {
  return /typesHash: ([0-9a-f]+)/.exec(code)?.[1];
}

/** The warnings a generated module's header lists. */
export function headerWarnings(code: string): string[] {
  const header = /^\/\*\*[\s\S]*?\*\//.exec(code)?.[0] ?? "";
  const at = header.indexOf(" * Warnings:");
  if (at === -1) return [];
  return header
    .slice(at)
    .split("\n")
    .filter((line) => line.startsWith(" * - "))
    .map((line) => line.slice(5));
}

/** One line of a {@link lineDiff}. */
export interface DiffLine {
  /** `" "` unchanged, `"-"` only before, `"+"` only after, `"…"` unchanged lines left out. */
  op: " " | "-" | "+" | "…";
  /** The line (for `"…"`, how many were left out). */
  text: string;
}

/**
 * A line diff of `before` and `after` (a longest common subsequence), with
 * `context` unchanged lines kept around each change. Empty when they are
 * equal. The files here are a few hundred lines, so the quadratic table is
 * small.
 */
export function lineDiff(
  before: string,
  after: string,
  context = 3,
): DiffLine[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])
    ) {
      // A removed line before the line that replaced it, as `diff -u` prints.
      all.push({ op: "-", text: a[i] });
      i++;
    } else {
      all.push({ op: "+", text: b[j] });
      j++;
    }
  }
  const near = all.map((line, index) =>
    all
      .slice(Math.max(0, index - context), index + context + 1)
      .some((each) => each.op !== " "),
  );
  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, index) => {
    if (near[index]) {
      if (skipped > 0) out.push({ op: "…", text: String(skipped) });
      skipped = 0;
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ op: "…", text: String(skipped) });
  return out;
}

/** The `names` present in `headers`. */
function pick(
  headers: Headers,
  names: readonly string[],
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

/** A logged argument as text: an Error by its message, an object as JSON. */
function text(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
