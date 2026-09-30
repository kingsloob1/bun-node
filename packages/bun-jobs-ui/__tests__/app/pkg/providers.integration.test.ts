import type { FetchLike } from "../../../app/api/client";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import {
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "@kingsleyweb/bun-jobs/provider";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * The Providers screen against a REAL `createJobsApi` and real compute
 * providers configured in this process: what `GET /providers` lists, what
 * `POST /providers/:id/validate` answers, and what the screen then shows.
 *
 * Two providers: one whose preflight passes, and one whose preflight throws
 * a `ProviderError` of kind `auth`, which must read as the credentials'
 * problem, not the platform's.
 *
 * The provider registry is per process and `bun test` runs every file in
 * one, so each provider is named uniquely and looked up by its id.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * a dynamic import the compiler does not follow, and the interfaces below
 * restate the little this file uses of it.
 */

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** What this file uses of `../providers/realApiProviders`. */
interface ProvidersModule {
  /** Renders `/providers` over `fetch` and returns a driver. */
  mountProviders: (
    fetch: FetchLike,
    csrfHeader: string,
  ) => Promise<{
    card: (
      id: string,
    ) => Promise<{ readiness: string; testable: boolean; text: string }>;
    test: (id: string) => Promise<{ text: string; ok: string | undefined }>;
    unmount: () => void;
  }>;
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";
/** Unique per process, so another file's providers never collide. */
const STAMP = Date.now().toString(36);

/**
 * The configured providers, held for the file's life: the registry holds
 * them weakly, so one nothing references is collected and drops out of
 * `GET /providers`.
 */
const configured: unknown[] = [];

/** A provider named uniquely, whose preflight answers `preflight`. */
function provider(label: string, preflight: () => Promise<unknown>) {
  const make = defineComputeProvider({
    name: `bun-jobs-ui-test-${label}-${STAMP}`,
    version: "1.0.0",
    kind: label,
    displayName: `Test ${label}`,
    apiVersion: { core: "0.1", summon: "0.1" },
    config: toStandardSchema<{ region: string }>((input) => ({
      value: input as { region: string },
    })),
    describe: (config) => ({ region: config.region }),
    validate: async () => (await preflight()) as never,
    summon: () => ({
      capabilities: {
        style: "launch",
        dedupe: { kind: "none" },
        passes: "argv",
        bootBudgetMs: 20_000,
        shutdown: { signal: "SIGTERM", graceMs: 10_000 },
        maxLifetimeMs: null,
        enforcesLifetime: false,
      },
      summon: async () => ({ status: "started", handles: [] }),
    }),
  });
  configured.push(make({ region: "eu-west-1" }));
  return `${make.definition.name}@1.0.0#1`;
}

let jobs: BunJobs;
let fetchApi: FetchLike;
let healthy: string;
let refused: string;

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** A `fetch` for the app over `router`, which mounts an API at {@link BASE}. */
function fetchOver(router: BunRouter): FetchLike {
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  return async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, "http://localhost");
      const response = await router.fetch(new native.Request(url.href, init));
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
}

beforeAll(async () => {
  healthy = provider("healthy", async () => [
    { id: "credentials", status: "pass" },
    { id: "cluster", status: "pass" },
  ]);
  refused = provider("refused", async () => {
    throw new ProviderError("the platform refused the credentials", "auth", {
      platformCode: "AccessDeniedException",
    });
  });
  jobs = new BunJobs({
    namespace: "ui-providers-integration",
    driver: new MemoryDriver(),
    logger: noopLogger,
  });
  const api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
    // Every action, the opt-in provider actions included.
    actions: [...JOBS_API_ACTIONS],
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  fetchApi = fetchOver(root);
});

afterAll(async () => {
  await jobs.close();
});

/** The DOM side. */
function ui(): Promise<ProvidersModule> {
  return load<ProvidersModule>(
    ["..", "providers", "realApiProviders"].join("/"),
  );
}

describe("the Providers screen against a real API", () => {
  it("lists the configured providers as ready, with their facts, and offers Test connection", async () => {
    const response = await fetchApi(`${BASE}/providers`, { method: "GET" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providers: { id: string; readiness: string; preflight: boolean }[];
    };
    expect(body.providers.find((item) => item.id === healthy)).toMatchObject({
      readiness: "ready",
      preflight: true,
    });

    const screen = await (await ui()).mountProviders(fetchApi, CSRF);
    const card = await screen.card(healthy);
    expect(card.readiness).toBe("Ready");
    expect(card.testable).toBe(true);
    expect(card.text).toContain("eu-west-1");
    screen.unmount();
  }, 30_000);

  it("runs a passing preflight and lists its checks", async () => {
    const screen = await (await ui()).mountProviders(fetchApi, CSRF);
    const result = await screen.test(healthy);
    expect(result.ok).toBe("true");
    expect(result.text).toContain("Connected: all 2 checks passed.");
    expect(result.text).toContain("credentials");
    screen.unmount();
  }, 30_000);

  it("reads an auth failure as the credentials' problem, with the platform's code", async () => {
    const answered = await fetchApi(
      `${BASE}/providers/${encodeURIComponent(refused)}/validate`,
      {
        method: "POST",
        headers: { [CSRF]: "1", "content-type": "application/json" },
        body: "{}",
      },
    );
    const body = (await answered.json()) as {
      ok: boolean;
      error?: { kind: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe("auth");

    const screen = await (await ui()).mountProviders(fetchApi, CSRF);
    const result = await screen.test(refused);
    expect(result.ok).toBe("false");
    expect(result.text).toBe(
      "Credentials problem: the platform refused them. (AccessDeniedException)",
    );
    screen.unmount();
  }, 30_000);
});
