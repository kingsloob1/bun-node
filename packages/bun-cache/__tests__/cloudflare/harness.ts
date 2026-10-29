/**
 * The Cloudflare drivers' local server: the shipped Worker
 * (`lib/cloudflare/worker.ts`, behind the tests' front, `test-worker.ts`)
 * bundled with `Bun.build` and run by miniflare in workerd, on port 0, in
 * memory, with real KV and D1 bindings. One per test file: start it at the
 * top level and stop it in `afterAll`. No account, no environment variable:
 * the drivers' tests always run (the spike,
 * `docs/plans/bun-cache/evidence/cloudflare-spike.md`).
 *
 * **A test that times out kills it** under `bun test --parallel`: Bun SIGTERMs
 * the file's workerd, though no test started it (oven-sh/bun#46373), and the
 * rest of the file fails with ECONNREFUSED. The Cloudflare test files set a
 * 30 s default timeout for that reason.
 *
 * What it cannot show, measured in the spike: KV's eventual consistency
 * (local KV is one store) and the REST API's frontend (its cap, its exact
 * errors); the front emulates KV's per-key write rate on request.
 */
import { Miniflare } from "miniflare";

/** The KV binding the local Worker has (the README's name). */
export const KV_BINDING = "CACHE_KV";

/** The D1 binding the local Worker has (the README's name). */
export const D1_BINDING = "CACHE_DB";

/** An R2 binding, which the Worker must refuse to treat as KV. */
export const R2_BINDING = "FILES";

/** A started local Worker. */
export interface LocalCloudflare {
  /** The Worker's URL, for a driver's `endpoint`. */
  endpoint: string;
  /** The Worker's `BUN_CACHE_PROXY_TOKEN`, for a driver's `apiToken`. */
  token: string;
  /** The front's counters: requests that reached it, and 429s it answered. */
  stats: () => Promise<{ requests: number; refused: number }>;
  /** Zeroes the counters and forgets the write times. */
  reset: () => Promise<void>;
  /** Disposes of workerd. */
  stop: () => Promise<void>;
  /** Every KV key under `prefix`, read from the binding around the Worker: its name, metadata, expiry and value bytes (the kit's `rawDump`). */
  rawKv: (prefix: string) => Promise<(string | Uint8Array)[]>;
  /** Every row of the named D1 tables, read from the binding around the Worker: each column's bytes or text (the kit's `rawDump`). A missing table contributes nothing. */
  rawD1: (tables: readonly string[]) => Promise<(string | Uint8Array)[]>;
}

/** What `rawKv` uses of miniflare's KV binding (its declared type does not resolve here without `@cloudflare/workers-types`). */
interface RawKvNamespace {
  /** One page of keys under a prefix. */
  list: (options: { prefix: string; cursor?: string }) => Promise<{
    keys: { name: string; expiration?: number; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
  /** A value's bytes; `null` when absent. */
  get: (key: string, type: "arrayBuffer") => Promise<ArrayBuffer | null>;
}

/** A D1 or KV value as dump chunks: a blob's bytes (D1 answers an `ArrayBuffer` or an array of byte values), text as text, the rest as JSON. */
function chunk(value: unknown): string | Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value instanceof Uint8Array || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) {
    return new Uint8Array(value);
  }
  return JSON.stringify(value) ?? "";
}

/** {@link startLocalCloudflare}'s options. */
export interface LocalCloudflareOptions {
  /** Emulate KV's one-write-per-second-per-key 429. Off by default. */
  kvWriteRate?: boolean;
  /** Answer every request 429 (the REST API's five-minute block). Off by default. */
  rateLimitAll?: boolean;
  /** The `Retry-After` the front's 429s carry, in seconds; `"1"` by default. */
  retryAfter?: string;
  /** The secret; a random one by default. `""` starts the Worker without one. */
  token?: string;
}

/** The bundled Worker, built once per process. */
let bundled: Promise<string> | undefined;

/** Bundles the tests' front and the shipped Worker into one ES module, as wrangler would. */
async function bundle(): Promise<string> {
  bundled ??= (async () => {
    const result = await Bun.build({
      entrypoints: [new URL("./test-worker.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
    });
    if (!result.success) {
      throw new AggregateError(result.logs, "bundling the Worker failed");
    }
    return await result.outputs[0].text();
  })();
  return await bundled;
}

/** Starts the local Worker. */
export async function startLocalCloudflare(
  options: LocalCloudflareOptions = {},
): Promise<LocalCloudflare> {
  const token = options.token ?? crypto.randomUUID();
  const bindings: Record<string, string> = {
    BUN_CACHE_TEST_KV_WRITE_RATE: options.kvWriteRate === true ? "1" : "0",
    BUN_CACHE_TEST_RATE_LIMIT_ALL: options.rateLimitAll === true ? "1" : "0",
    BUN_CACHE_TEST_KV_RETRY_AFTER: options.retryAfter ?? "1",
  };
  if (token !== "") {
    bindings.BUN_CACHE_PROXY_TOKEN = token;
  }
  const mf = new Miniflare({
    modules: true,
    script: await bundle(),
    compatibilityDate: "2026-07-01",
    kvNamespaces: { [KV_BINDING]: "cache-kv" },
    d1Databases: { [D1_BINDING]: "cache-db" },
    r2Buckets: { [R2_BINDING]: "files" },
    bindings,
    // miniflare's placeholder `request.cf`: without it, outside `bun test`,
    // miniflare fetches workers.cloudflare.com/cf.json and caches it under
    // ./.wrangler in the working directory.
    cf: false,
    port: 0,
  });
  const url = await mf.ready;
  const endpoint = url.href.replace(/\/+$/, "");
  return {
    endpoint,
    token,
    stats: async () =>
      (await (await fetch(`${endpoint}/__bun-cache-test/stats`)).json()) as {
        requests: number;
        refused: number;
      },
    reset: async () => {
      await (await fetch(`${endpoint}/__bun-cache-test/reset`)).text();
    },
    stop: async () => {
      await mf.dispose();
    },
    rawKv: async (prefix) => {
      const kv = (await mf.getKVNamespace(
        KV_BINDING,
      )) as unknown as RawKvNamespace;
      const out: (string | Uint8Array)[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await kv.list({ prefix, cursor });
        for (const key of page.keys) {
          out.push(key.name, JSON.stringify([key.metadata, key.expiration]));
          const value = await kv.get(key.name, "arrayBuffer");
          if (value !== null) {
            out.push(new Uint8Array(value));
          }
        }
        if (page.list_complete) {
          return out;
        }
        cursor = page.cursor;
      }
    },
    rawD1: async (tables) => {
      const db = await mf.getD1Database(D1_BINDING);
      const out: (string | Uint8Array)[] = [];
      for (const table of tables) {
        let rows: Record<string, unknown>[];
        try {
          rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
        } catch {
          continue; // not created (yet)
        }
        for (const row of rows) {
          for (const [column, value] of Object.entries(row)) {
            out.push(column, chunk(value));
          }
        }
      }
      return out;
    },
  };
}
