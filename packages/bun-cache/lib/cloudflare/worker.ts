/**
 * The bun-cache Worker (`@kingsleyweb/bun-cache/cloudflare-worker`): the
 * Cloudflare drivers' production transport. Deploy it with your KV namespace
 * and D1 database bound, and point the driver's `endpoint` at it:
 *
 * ```ts
 * // src/index.ts of a Worker project
 * export { default } from "@kingsleyweb/bun-cache/cloudflare-worker";
 * ```
 *
 * ```toml
 * # wrangler.toml
 * name = "bun-cache"
 * main = "src/index.ts"
 * compatibility_date = "2026-07-01"
 * kv_namespaces = [{ binding = "CACHE_KV", id = "<namespace id>" }]
 * d1_databases = [{ binding = "CACHE_DB", database_name = "cache", database_id = "<database id>" }]
 * ```
 *
 * and `wrangler secret put BUN_CACHE_PROXY_TOKEN`. The driver then takes
 * `endpoint: "https://bun-cache.<you>.workers.dev"`, that secret as
 * `apiToken`, and the **binding's name** as `namespaceId` (`"CACHE_KV"`) or
 * `databaseId` (`"CACHE_DB"`).
 *
 * It answers the subset of the Cloudflare REST API's KV and D1 data paths
 * the drivers use, in the same shapes, over the bindings — so the driver's
 * client is one client, and the tests run this very file in workerd
 * (miniflare). Unlike the REST API it is not capped at 1,200 requests per
 * five minutes (plan Status, the Cloudflare spike):
 *
 * - `GET|PUT|DELETE /storage/kv/namespaces/<binding>/values/<key>` (a `PUT`
 *   takes the raw body and `expiration`/`expiration_ttl`; no metadata),
 * - `GET /storage/kv/namespaces/<binding>/keys?prefix&limit&cursor`,
 * - `PUT /storage/kv/namespaces/<binding>/bulk` (`[{ key, value, base64?,
 *   expiration?, expiration_ttl? }]`), `POST …/bulk/get` (`{ keys, type? }`,
 *   text or JSON), `POST …/bulk/delete` (`[key, …]`),
 * - `POST /d1/database/<binding>/query` and `…/raw` (`{ sql, params? }` or
 *   `{ batch: [{ sql, params? }] }`, string parameters only, one statement
 *   each; a batch runs as `DB.batch()`, one transaction).
 *
 * A path may carry the REST API's `/client/v4/accounts/<id>` in front; it is
 * ignored. Every request needs `Authorization: Bearer <BUN_CACHE_PROXY_TOKEN>`;
 * with the secret unset the Worker refuses everything. A binding name must
 * name a KV namespace (or a D1 database) binding: the Worker never answers
 * with any other part of its environment.
 *
 * This file runs on Cloudflare's runtime: it imports nothing, and uses only
 * web-standard APIs, so it bundles as it is.
 */

/** The KV binding methods the Worker calls (Cloudflare's `KVNamespace`, structurally). */
interface KvBinding {
  /** One value as bytes, or several as text (`bulk/get`). */
  get: ((
    key: string,
    options: { type: "arrayBuffer" },
  ) => Promise<ArrayBuffer | null>) &
    ((
      keys: string[],
      options: { type: "text" | "json" },
    ) => Promise<Map<string, unknown>>);
  /** Writes a value. */
  put: (
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { expiration?: number; expirationTtl?: number },
  ) => Promise<void>;
  /** Deletes a key. */
  delete: (key: string) => Promise<void>;
  /** Lists keys. */
  list: (options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }) => Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** A prepared D1 statement (Cloudflare's `D1PreparedStatement`, structurally). */
interface D1PreparedLike {
  /** Binds parameters. */
  bind: (...values: unknown[]) => D1PreparedLike;
}

/** One statement's result from `DB.batch()`. */
interface D1ResultLike {
  /** The rows. */
  results: Record<string, unknown>[];
  /** Whether it succeeded. */
  success: boolean;
  /** D1's statistics. */
  meta: Record<string, unknown>;
}

/** The D1 binding methods the Worker calls (Cloudflare's `D1Database`, structurally). */
interface D1Binding {
  /** Prepares one statement. */
  prepare: (sql: string) => D1PreparedLike;
  /** Runs statements as one transaction. */
  batch: (statements: D1PreparedLike[]) => Promise<D1ResultLike[]>;
}

/** The Worker's environment: the secret, and the bindings by name. */
export interface BunCacheWorkerEnv {
  /** The bearer secret the drivers send as `apiToken` (`wrangler secret put BUN_CACHE_PROXY_TOKEN`). */
  BUN_CACHE_PROXY_TOKEN?: string;
  /** The KV and D1 bindings, by binding name. */
  [binding: string]: unknown;
}

/** The REST API's error envelope. */
function failure(status: number, code: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code, message }], messages: [], result: null },
    {
      status,
      headers: status === 429 ? { "retry-after": "1" } : undefined,
    },
  );
}

/** The REST API's success envelope. */
function success(
  result: unknown,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...extra,
  });
}

/** Compares two strings in time independent of where they differ. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let index = 0; index < b.length; index++) {
    diff |= (a[index] ?? 0) ^ b[index];
  }
  return diff === 0;
}

/** Whether a value is a KV binding. */
function isKv(value: unknown): value is KvBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as KvBinding).get === "function" &&
    typeof (value as KvBinding).put === "function" &&
    typeof (value as KvBinding).list === "function" &&
    // Not a D1 database, and not an R2 bucket (which has get/put/list too).
    typeof (value as D1Binding).prepare !== "function" &&
    typeof (value as { head?: unknown }).head !== "function"
  );
}

/** Whether a value is a D1 binding. */
function isD1(value: unknown): value is D1Binding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as D1Binding).prepare === "function" &&
    typeof (value as D1Binding).batch === "function"
  );
}

/** A binding error as the REST API would answer it: KV's own status (`KV PUT failed: 429 …`) when it names one, else 400. */
function bindingFailure(error: unknown, code: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\b(4\d\d)\b/.exec(message)?.[1];
  return failure(status === undefined ? 400 : Number(status), code, message);
}

/** The REST API's expiry fields as the binding's put options (`expiration_ttl` wins, as documented). */
function expiry(
  expiration: unknown,
  expirationTtl: unknown,
): { expiration?: number; expirationTtl?: number } {
  if (
    expirationTtl !== undefined &&
    expirationTtl !== null &&
    expirationTtl !== ""
  ) {
    return { expirationTtl: Number(expirationTtl) };
  }
  if (expiration !== undefined && expiration !== null && expiration !== "") {
    return { expiration: Number(expiration) };
  }
  return {};
}

/** Base64 to bytes, with web APIs only. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

/** The KV routes, after `/storage/kv/namespaces/<binding>`. */
async function kv(
  request: Request,
  store: KvBinding,
  rest: string[],
  url: URL,
): Promise<Response> {
  const [first, second] = rest;
  if (first === "values" && rest.length === 2 && second !== undefined) {
    const key = decodeURIComponent(second);
    if (request.method === "GET") {
      const value = await store.get(key, { type: "arrayBuffer" });
      return value === null
        ? failure(404, 10009, "get: 'key not found'")
        : new Response(value, {
            headers: { "content-type": "application/octet-stream" },
          });
    }
    if (request.method === "PUT") {
      try {
        await store.put(
          key,
          await request.arrayBuffer(),
          expiry(
            url.searchParams.get("expiration"),
            url.searchParams.get("expiration_ttl"),
          ),
        );
      } catch (error) {
        return bindingFailure(error, 10001);
      }
      return success({});
    }
    if (request.method === "DELETE") {
      await store.delete(key);
      return success({});
    }
  }
  if (first === "keys" && rest.length === 1 && request.method === "GET") {
    const limit = url.searchParams.get("limit");
    try {
      const listed = await store.list({
        prefix: url.searchParams.get("prefix") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: limit === null ? undefined : Number(limit),
      });
      return success(
        listed.keys.map((each) => ({
          name: each.name,
          expiration: each.expiration,
        })),
        {
          result_info: {
            count: listed.keys.length,
            cursor: listed.list_complete ? "" : (listed.cursor ?? ""),
          },
        },
      );
    } catch (error) {
      return bindingFailure(error, 10001);
    }
  }
  if (first === "bulk" && rest.length === 1 && request.method === "PUT") {
    const pairs = (await request.json()) as {
      key: string;
      value: string;
      base64?: boolean;
      expiration?: number;
      expiration_ttl?: number;
    }[];
    if (!Array.isArray(pairs) || pairs.length > 10_000) {
      return failure(
        400,
        10001,
        "bulk write: an array of at most 10,000 pairs",
      );
    }
    const unsuccessful: string[] = [];
    let count = 0;
    for (const pair of pairs) {
      try {
        await store.put(
          pair.key,
          pair.base64 === true ? fromBase64(pair.value) : pair.value,
          expiry(pair.expiration, pair.expiration_ttl),
        );
        count++;
      } catch {
        unsuccessful.push(pair.key);
      }
    }
    return success({
      successful_key_count: count,
      unsuccessful_keys: unsuccessful,
    });
  }
  if (
    first === "bulk" &&
    second === "get" &&
    rest.length === 2 &&
    request.method === "POST"
  ) {
    const body = (await request.json()) as { keys?: unknown; type?: unknown };
    if (
      !Array.isArray(body.keys) ||
      !body.keys.every((key) => typeof key === "string")
    ) {
      return failure(400, 10001, "bulk get: keys must be an array of strings");
    }
    try {
      const got = await store.get(body.keys, {
        type: body.type === "json" ? "json" : "text",
      });
      const values: Record<string, unknown> = {};
      for (const key of body.keys) {
        values[key] = got.get(key) ?? null;
      }
      return success({ values });
    } catch (error) {
      return bindingFailure(error, 10001);
    }
  }
  if (
    first === "bulk" &&
    second === "delete" &&
    rest.length === 2 &&
    request.method === "POST"
  ) {
    const keys: unknown = await request.json();
    if (
      !Array.isArray(keys) ||
      keys.length > 10_000 ||
      !keys.every((key) => typeof key === "string")
    ) {
      return failure(
        400,
        10001,
        "bulk delete: an array of at most 10,000 keys",
      );
    }
    for (const key of keys) {
      await store.delete(key);
    }
    return success({
      successful_key_count: keys.length,
      unsuccessful_keys: [],
    });
  }
  return failure(404, 10000, `no such KV route: ${request.method}`);
}

/** The D1 routes, after `/d1/database/<binding>`. */
async function d1(
  request: Request,
  db: D1Binding,
  rest: string[],
): Promise<Response> {
  const [route] = rest;
  if (
    rest.length !== 1 ||
    (route !== "query" && route !== "raw") ||
    request.method !== "POST"
  ) {
    return failure(404, 7500, `no such D1 route: ${request.method}`);
  }
  const body = (await request.json()) as {
    sql?: unknown;
    params?: unknown;
    batch?: unknown;
  };
  const queries = (Array.isArray(body.batch) ? body.batch : [body]) as {
    sql?: unknown;
    params?: unknown;
  }[];
  for (const query of queries) {
    if (typeof query.sql !== "string") {
      return failure(400, 7400, "each query needs sql, a string");
    }
    if (
      query.params !== undefined &&
      !(
        Array.isArray(query.params) &&
        query.params.every((param) => typeof param === "string")
      )
    ) {
      return failure(400, 7400, "params must be an array of strings");
    }
  }
  let results: D1ResultLike[];
  try {
    results = await db.batch(
      queries.map((query) => {
        const statement = db.prepare(query.sql as string);
        const params = (query.params ?? []) as string[];
        return params.length > 0 ? statement.bind(...params) : statement;
      }),
    );
  } catch (error) {
    return failure(
      400,
      7500,
      error instanceof Error ? error.message : String(error),
    );
  }
  return success(
    results.map((result) => {
      if (route === "query") {
        return {
          results: result.results,
          success: result.success,
          meta: result.meta,
        };
      }
      const columns =
        result.results.length > 0 ? Object.keys(result.results[0]) : [];
      return {
        results: {
          columns,
          rows: result.results.map((row) =>
            columns.map((column) => row[column]),
          ),
        },
        success: result.success,
        meta: result.meta,
      };
    }),
  );
}

/** Routes one request. */
async function handle(
  request: Request,
  env: BunCacheWorkerEnv,
): Promise<Response> {
  const secret = env.BUN_CACHE_PROXY_TOKEN;
  if (typeof secret !== "string" || secret === "") {
    return failure(
      500,
      10000,
      "the bun-cache Worker has no BUN_CACHE_PROXY_TOKEN secret, so it refuses every request",
    );
  }
  const given = /^Bearer (.+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (given === undefined || !sameSecret(given, secret)) {
    return failure(401, 10000, "Authentication error");
  }
  const url = new URL(request.url);
  let parts = url.pathname.split("/").filter((part) => part !== "");
  // The REST API's prefix, when a client sends it: /client/v4/accounts/<id>
  // (or /accounts/<id>). Only at the front: a key may be named "accounts".
  if (parts[0] === "client" && parts[1] === "v4" && parts[2] === "accounts") {
    parts = parts.slice(4);
  } else if (parts[0] === "accounts") {
    parts = parts.slice(2);
  }
  if (
    parts[0] === "storage" &&
    parts[1] === "kv" &&
    parts[2] === "namespaces"
  ) {
    const name = decodeURIComponent(parts[3] ?? "");
    const store = env[name];
    if (name === "" || !isKv(store)) {
      return failure(
        404,
        10013,
        `no KV namespace bound as ${JSON.stringify(name)}`,
      );
    }
    return await kv(request, store, parts.slice(4), url);
  }
  if (parts[0] === "d1" && parts[1] === "database") {
    const name = decodeURIComponent(parts[2] ?? "");
    const db = env[name];
    if (name === "" || !isD1(db)) {
      return failure(
        404,
        7404,
        `no D1 database bound as ${JSON.stringify(name)}`,
      );
    }
    return await d1(request, db, parts.slice(3));
  }
  return failure(404, 10000, "no such route");
}

/** The Worker: `export { default } from "@kingsleyweb/bun-cache/cloudflare-worker"`. */
const worker = {
  /** Answers one request (see the module header). */
  async fetch(request: Request, env: BunCacheWorkerEnv): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      return failure(
        400,
        10001,
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

export default worker;
