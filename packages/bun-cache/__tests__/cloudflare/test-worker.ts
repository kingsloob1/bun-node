/**
 * The tests' Worker: the shipped one (`lib/cloudflare/worker.ts`) behind a
 * thin front that only the tests deploy, never users. It adds two things
 * workerd does not reproduce and a third for the assertions:
 *
 * - **KV's write rate** (Cloudflare: one write per second per key, else
 *   429), when the binding `BUN_CACHE_TEST_KV_WRITE_RATE` is `"1"`: a `PUT`
 *   of a value, or a bulk write naming a key, written less than a second ago
 *   is answered 429 with `Retry-After` (`BUN_CACHE_TEST_KV_RETRY_AFTER`
 *   seconds, `1` by default) and not passed on. The spike measured that local
 *   KV takes five writes to one key in ~10 ms without complaint.
 * - **A fixed 429** for every request, when `BUN_CACHE_TEST_RATE_LIMIT_ALL`
 *   is `"1"` (with `BUN_CACHE_TEST_KV_RETRY_AFTER` as `Retry-After`): the
 *   REST API's five-minute block, for the client's fail-fast path.
 * - **Counters**: `GET /__bun-cache-test/stats` answers how many requests
 *   reached the front and how many it refused, and `POST …/reset` zeroes
 *   them (no auth: test-only).
 */
import worker from "../../lib/cloudflare/worker";
import type { BunCacheWorkerEnv } from "../../lib/cloudflare/worker";

/** When each KV key (`<binding>\u0000<key>`) was last written, epoch ms. */
const lastWrite = new Map<string, number>();

/** What the front counted. */
const stats = { requests: 0, refused: 0 };

/** The KV keys a request writes, as `<binding>\u0000<key>`; empty for anything else. */
async function writtenKeys(request: Request): Promise<string[]> {
  const parts = new URL(request.url).pathname
    .split("/")
    .filter((part) => part !== "");
  const at = parts.indexOf("namespaces");
  if (at < 0 || parts[at - 1] !== "kv") {
    return [];
  }
  const binding = decodeURIComponent(parts[at + 1] ?? "");
  const rest = parts.slice(at + 2);
  if (request.method === "PUT" && rest[0] === "values" && rest.length === 2) {
    return [`${binding}\u0000${decodeURIComponent(rest[1])}`];
  }
  if (request.method === "PUT" && rest[0] === "bulk" && rest.length === 1) {
    const pairs = (await request.clone().json()) as { key: string }[];
    return pairs.map((pair) => `${binding}\u0000${pair.key}`);
  }
  return [];
}

/** A 429 in the REST API's envelope. */
function tooMany(retryAfter: string): Response {
  return Response.json(
    {
      success: false,
      errors: [
        { code: 10_429, message: "KV PUT failed: 429 Too Many Requests" },
      ],
      messages: [],
      result: null,
    },
    { status: 429, headers: { "retry-after": retryAfter } },
  );
}

export default {
  async fetch(request: Request, env: BunCacheWorkerEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__bun-cache-test/stats") {
      return Response.json(stats);
    }
    if (path === "/__bun-cache-test/reset") {
      stats.requests = 0;
      stats.refused = 0;
      lastWrite.clear();
      return Response.json(stats);
    }
    stats.requests++;
    const retryAfter =
      typeof env.BUN_CACHE_TEST_KV_RETRY_AFTER === "string"
        ? env.BUN_CACHE_TEST_KV_RETRY_AFTER
        : "1";
    if (env.BUN_CACHE_TEST_RATE_LIMIT_ALL === "1") {
      stats.refused++;
      return tooMany(retryAfter);
    }
    if (env.BUN_CACHE_TEST_KV_WRITE_RATE !== "1") {
      return await worker.fetch(request, env);
    }
    const keys = await writtenKeys(request);
    const now = Date.now();
    if (keys.some((key) => now - (lastWrite.get(key) ?? 0) < 1000)) {
      stats.refused++;
      return tooMany(retryAfter);
    }
    const response = await worker.fetch(request, env);
    if (response.ok) {
      for (const key of keys) {
        lastWrite.set(key, Date.now());
      }
    }
    return response;
  },
};
