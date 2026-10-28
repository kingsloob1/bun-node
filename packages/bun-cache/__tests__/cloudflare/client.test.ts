/**
 * The Cloudflare drivers' shared client (`lib/cloudflare/client.ts`): how it
 * picks the transport and its token, KV's 60 s floor, its pacing under a
 * request budget, and its 429 handling — against the local Worker
 * (`harness.ts`), whose test-only front answers the 429s.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  CLOUDFLARE_API_BASE,
  CloudflareClient,
  kvExpirationTtl,
  MAX_ATTEMPTS,
  REST_API_BUDGET,
} from "../../lib/cloudflare/client";
import { KV_BINDING, startLocalCloudflare } from "./harness";

// A generous per-test timeout: under `bun test --parallel`, any test that
// times out makes Bun SIGTERM the file's workerd (started at the top level by
// miniflare), and every later test then fails with ECONNREFUSED
// (oven-sh/bun#46373; measured on a machine at load 38, where the 1,050-key
// `clear` test passed 5 s). Remove once Bun stops killing processes the
// timed-out test did not start.
setDefaultTimeout(30_000);

const local = await startLocalCloudflare();
const writeRate = await startLocalCloudflare({ kvWriteRate: true });
const blocked = await startLocalCloudflare({
  rateLimitAll: true,
  retryAfter: "300",
});
const shortBlock = await startLocalCloudflare({
  rateLimitAll: true,
  retryAfter: "0",
});
afterAll(async () => {
  await Promise.all(
    [local, writeRate, blocked, shortBlock].map(async (each) => {
      await each.stop();
    }),
  );
});

/** Runs `body` with some environment variables set (or removed, for `undefined`), restoring them after. */
function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => T,
): T {
  const saved = Object.fromEntries(
    Object.keys(vars).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** A client on a local Worker. */
function client(
  server = local,
  budget?: { requests: number; windowMs: number },
): CloudflareClient {
  return new CloudflareClient({
    endpoint: server.endpoint,
    apiToken: server.token,
    caller: "test",
    budget,
  });
}

describe("the transport and the token", () => {
  test("the REST API takes accountId and apiToken, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN", () => {
    const given = withEnv(
      { CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined },
      () =>
        new CloudflareClient({
          accountId: "acc/1",
          apiToken: "tok",
          caller: "test",
        }),
    );
    expect(given.transport).toBe("rest");
    expect(given.base).toBe(`${CLOUDFLARE_API_BASE}/accounts/acc%2F1`);
    const fromEnv = withEnv(
      { CLOUDFLARE_ACCOUNT_ID: "env-acc", CLOUDFLARE_API_TOKEN: "env-tok" },
      () => new CloudflareClient({ caller: "test" }),
    );
    expect(fromEnv.base).toBe(`${CLOUDFLARE_API_BASE}/accounts/env-acc`);
  });

  test("the REST API without an account or a token is refused, naming both ways", () => {
    withEnv(
      { CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined },
      () => {
        expect(
          () => new CloudflareClient({ apiToken: "t", caller: "x" }),
        ).toThrow(/accountId and apiToken \(or CLOUDFLARE_ACCOUNT_ID/);
        expect(
          () => new CloudflareClient({ accountId: "a", caller: "x" }),
        ).toThrow(/an endpoint and apiToken/);
      },
    );
  });

  test("an endpoint needs its own apiToken: CLOUDFLARE_API_TOKEN is never sent to a Worker", () => {
    withEnv({ CLOUDFLARE_API_TOKEN: "real-api-token" }, () => {
      expect(
        () =>
          new CloudflareClient({
            endpoint: "https://cache.example.workers.dev",
            caller: "x",
          }),
      ).toThrow(/BUN_CACHE_PROXY_TOKEN/);
    });
    const worker = new CloudflareClient({
      endpoint: "https://cache.example.workers.dev/",
      apiToken: "secret",
      accountId: "ignored",
      caller: "x",
    });
    expect(worker.transport).toBe("worker");
    expect(worker.base).toBe("https://cache.example.workers.dev");
  });

  test("an endpoint is https:, or http: to a loopback host only", () => {
    for (const endpoint of [
      "http://cache.example.com",
      "http://10.0.0.1:8787",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(
        () => new CloudflareClient({ endpoint, apiToken: "t", caller: "x" }),
      ).toThrow(/endpoint/);
    }
    for (const endpoint of [
      "http://127.0.0.1:8787",
      "http://localhost:1",
      "http://[::1]:2",
    ]) {
      expect(
        new CloudflareClient({ endpoint, apiToken: "t", caller: "x" })
          .transport,
      ).toBe("worker");
    }
  });

  test("the token goes as a bearer header and never into an error", async () => {
    const wrong = new CloudflareClient({
      endpoint: local.endpoint,
      apiToken: "s3cr3t-value",
      caller: "test",
    });
    const error = await wrong
      .kvGet(KV_BINDING, "k")
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("401");
    expect(String(error)).not.toContain("s3cr3t-value");
  });
});

describe("KV's 60 s floor", () => {
  test("kvExpirationTtl: seconds left, rounded up, never under 60; none for null", () => {
    const now = 1_000_000;
    expect(kvExpirationTtl(null, now)).toBeUndefined();
    expect(kvExpirationTtl(now + 1, now)).toBe(60);
    expect(kvExpirationTtl(now - 5_000, now)).toBe(60);
    expect(kvExpirationTtl(now + 60_000, now)).toBe(60);
    expect(kvExpirationTtl(now + 60_001, now)).toBe(61);
    expect(kvExpirationTtl(now + 86_400_000, now)).toBe(86_400);
  });

  test("a value whose expiry is under a minute away is accepted by KV (which refuses an expiration_ttl under 60)", async () => {
    const c = client();
    await c.kvPut(KV_BINDING, "floor", "x", Date.now() + 1_000, Date.now());
    expect(new TextDecoder().decode(await c.kvGet(KV_BINDING, "floor"))).toBe(
      "x",
    );
    const raw = await c.request(
      "PUT",
      `/storage/kv/namespaces/${KV_BINDING}/values/raw?expiration_ttl=59`,
      {
        body: "x",
      },
    );
    expect(raw.status).toBe(400);
    expect(await raw.text()).toContain("at least 60");
  });
});

describe("pacing", () => {
  test("the REST API's documented budget is the default there; a Worker has none", () => {
    expect(REST_API_BUDGET).toEqual({ requests: 1_200, windowMs: 300_000 });
  });

  test("a budget of 3 per 400 ms holds the fourth request until the first ages out", async () => {
    const c = client(local, { requests: 3, windowMs: 400 });
    const started = Date.now();
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        await c.kvGet(KV_BINDING, "paced");
        times.push(Date.now() - started);
      }),
    );
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(300);
    expect(times[3]).toBeGreaterThanOrEqual(390);
  });
});

describe("429s", () => {
  test("a 429 with Retry-After is retried after it, and the request lands", async () => {
    await writeRate.reset();
    const c = client(writeRate);
    await c.kvPut(KV_BINDING, "hot", "1", null, Date.now());
    const started = Date.now();
    await c.kvPut(KV_BINDING, "hot", "2", null, Date.now());
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(new TextDecoder().decode(await c.kvGet(KV_BINDING, "hot"))).toBe(
      "2",
    );
    expect(c.rateLimited).toBe(1);
    expect(await writeRate.stats()).toEqual({ requests: 4, refused: 1 });
  });

  test(`gives up after ${MAX_ATTEMPTS} attempts`, async () => {
    await shortBlock.reset();
    const c = client(shortBlock);
    await expect(c.kvGet(KV_BINDING, "k")).rejects.toThrow(
      `still rate limited (429) after ${MAX_ATTEMPTS} attempts`,
    );
    expect(c.requests).toBe(MAX_ATTEMPTS);
  });

  test("a Retry-After past 10 s (the REST API's five-minute block) fails at once, and the next requests fail without being sent", async () => {
    await blocked.reset();
    const c = client(blocked);
    const started = Date.now();
    await expect(c.kvGet(KV_BINDING, "k")).rejects.toThrow(
      /rate limited by Cloudflare \(429\), retry after 300 s/,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(c.kvGet(KV_BINDING, "k")).rejects.toThrow(/not sent/);
    expect(c.requests).toBe(1);
    expect((await blocked.stats()).requests).toBe(1);
  });
});

describe("KV calls", () => {
  test("a missing key is a miss; other 404s throw", async () => {
    const c = client();
    expect(await c.kvGet(KV_BINDING, "never")).toBeUndefined();
    expect(await c.kvExists(KV_BINDING, "never")).toBe(false);
    await expect(c.kvGet("NOT_BOUND", "k")).rejects.toThrow(/404: 10013/);
  });

  test("bytes round-trip, by PUT and by bulk write (base64)", async () => {
    const c = client();
    const bytes = new Uint8Array(256).map((_, index) => index);
    await c.kvPut(KV_BINDING, "bin", bytes, null, Date.now());
    expect(await c.kvGet(KV_BINDING, "bin")).toEqual(bytes);
    await c.kvBulkPut(
      KV_BINDING,
      [{ key: "bulk-bin", value: bytes, expiresAt: Date.now() + 120_000 }],
      Date.now(),
    );
    expect(await c.kvGet(KV_BINDING, "bulk-bin")).toEqual(bytes);
  });

  test("bulk reads page by 100, listings by cursor, bulk deletes take any number", async () => {
    const c = client();
    const keys = Array.from(
      { length: 1_234 },
      (_, index) => `page/${String(index).padStart(4, "0")}`,
    );
    await c.kvBulkPut(
      KV_BINDING,
      keys.map((key) => ({ key, value: key, expiresAt: null })),
      Date.now(),
    );
    const before = c.requests;
    const values = await c.kvBulkGetText(KV_BINDING, [
      ...keys.slice(0, 250),
      "page/none",
    ]);
    expect(c.requests - before).toBe(3);
    expect(values.slice(0, 250)).toEqual(keys.slice(0, 250));
    expect(values[250]).toBeUndefined();
    const first = await c.kvList(KV_BINDING, "page/");
    expect(first.keys.length).toBe(1_000);
    expect(first.cursor).toBeDefined();
    const second = await c.kvList(KV_BINDING, "page/", {
      cursor: first.cursor,
    });
    expect(second.keys.length).toBe(234);
    expect(second.cursor).toBeUndefined();
    await c.kvBulkDelete(KV_BINDING, keys);
    expect((await c.kvList(KV_BINDING, "page/")).keys).toEqual([]);
  });
});
