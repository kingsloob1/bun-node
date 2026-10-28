/**
 * The bun-cache Worker (`@kingsleyweb/bun-cache/cloudflare-worker`, the
 * Cloudflare drivers' production transport) in workerd, through the client:
 * its auth, which bindings it answers for, its routes, and D1 — the smoke
 * test PR-C11's driver builds on (the spike's findings: string parameters,
 * `unhex`/`hex` for bytes, `BEGIN` refused, a batch one transaction).
 */
import { Buffer } from "node:buffer";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import worker from "../../lib/cloudflare/worker";
import { CloudflareClient } from "../../lib/cloudflare/client";
import {
  D1_BINDING,
  KV_BINDING,
  R2_BINDING,
  startLocalCloudflare,
} from "./harness";

// A generous per-test timeout: under `bun test --parallel`, any test that
// times out makes Bun SIGTERM the file's workerd (started at the top level by
// miniflare), and every later test then fails with ECONNREFUSED
// (oven-sh/bun#46373; measured on a machine at load 38, where the 1,050-key
// `clear` test passed 5 s). Remove once Bun stops killing processes the
// timed-out test did not start.
setDefaultTimeout(30_000);

const local = await startLocalCloudflare();
const noSecret = await startLocalCloudflare({ token: "" });
afterAll(async () => {
  await local.stop();
  await noSecret.stop();
});

const c = new CloudflareClient({
  endpoint: local.endpoint,
  apiToken: local.token,
  caller: "test",
});

/** A raw request to the local Worker, with the right token unless told otherwise. */
async function raw(
  path: string,
  init: RequestInit & { token?: string } = {},
  server = local,
): Promise<Response> {
  const { token = server.token, ...rest } = init;
  return await fetch(`${server.endpoint}${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${token}`, ...rest.headers },
  });
}

describe("auth", () => {
  test("no token, a wrong one, or a different scheme: 401 in the REST API's envelope", async () => {
    for (const authorization of [
      "",
      "Bearer wrong",
      `Basic ${local.token}`,
      `Bearer ${local.token}x`,
    ]) {
      const response = await fetch(
        `${local.endpoint}/storage/kv/namespaces/${KV_BINDING}/keys`,
        {
          headers: authorization === "" ? {} : { authorization },
        },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
        messages: [],
        result: null,
      });
    }
  });

  test("with no BUN_CACHE_PROXY_TOKEN secret, it refuses every request", async () => {
    for (const token of ["", "anything"]) {
      const response = await raw(
        `/storage/kv/namespaces/${KV_BINDING}/keys`,
        { token },
        noSecret,
      );
      expect(response.status).toBe(500);
      expect(await response.text()).toContain(
        "no BUN_CACHE_PROXY_TOKEN secret",
      );
    }
  });
});

describe("bindings", () => {
  test("answers only for a KV binding as a namespace, and a D1 binding as a database", async () => {
    for (const name of [
      "BUN_CACHE_PROXY_TOKEN",
      R2_BINDING,
      D1_BINDING,
      "NOPE",
    ]) {
      const response = await raw(
        `/storage/kv/namespaces/${encodeURIComponent(name)}/keys`,
      );
      expect(response.status).toBe(404);
      expect(
        ((await response.json()) as { errors: { code: number }[] }).errors[0]
          .code,
      ).toBe(10013);
    }
    for (const name of [
      "BUN_CACHE_PROXY_TOKEN",
      R2_BINDING,
      KV_BINDING,
      "NOPE",
    ]) {
      const response = await raw(`/d1/database/${name}/query`, {
        method: "POST",
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      expect(response.status).toBe(404);
      expect(
        ((await response.json()) as { errors: { code: number }[] }).errors[0]
          .code,
      ).toBe(7404);
    }
  });

  test("never echoes the secret", async () => {
    const response = await raw(
      `/storage/kv/namespaces/BUN_CACHE_PROXY_TOKEN/values/x`,
    );
    expect(await response.text()).not.toContain(local.token);
  });
});

describe("KV routes", () => {
  test("the REST API's /client/v4/accounts/<id> prefix is accepted, and a key may be named accounts", async () => {
    const put = await raw(
      `/client/v4/accounts/abc/storage/kv/namespaces/${KV_BINDING}/values/accounts`,
      {
        method: "PUT",
        body: "v",
      },
    );
    expect(put.status).toBe(200);
    const get = await raw(
      `/accounts/abc/storage/kv/namespaces/${KV_BINDING}/values/accounts`,
    );
    expect(await get.text()).toBe("v");
    expect(
      new TextDecoder().decode(await c.kvGet(KV_BINDING, "accounts")),
    ).toBe("v");
  });

  test("keys with /, %, spaces and non-ASCII round-trip", async () => {
    for (const key of ["a/b/c", "100%", "two words", "ключ", "?#&"]) {
      await c.kvPut(KV_BINDING, key, key, null, Date.now());
      expect(new TextDecoder().decode(await c.kvGet(KV_BINDING, key))).toBe(
        key,
      );
    }
  });

  test("expiration (absolute) and expiration_ttl (which wins) reach the binding", async () => {
    const now = Math.floor(Date.now() / 1000);
    await raw(
      `/storage/kv/namespaces/${KV_BINDING}/values/abs?expiration=${now + 3600}`,
      { method: "PUT", body: "x" },
    );
    await raw(
      `/storage/kv/namespaces/${KV_BINDING}/values/both?expiration=${now + 3600}&expiration_ttl=120`,
      {
        method: "PUT",
        body: "x",
      },
    );
    const listed = (await (
      await raw(`/storage/kv/namespaces/${KV_BINDING}/keys?prefix=`)
    ).json()) as {
      result: { name: string; expiration?: number }[];
    };
    const exp = (name: string) =>
      listed.result.find((each) => each.name === name)?.expiration ?? 0;
    expect(exp("abs")).toBe(now + 3600);
    expect(Math.abs(exp("both") - (now + 120))).toBeLessThanOrEqual(1);
  });

  test("a binding's refusal keeps KV's status: a key over 512 bytes is 414", async () => {
    const response = await raw(
      `/storage/kv/namespaces/${KV_BINDING}/values/${"k".repeat(513)}`,
      {
        method: "PUT",
        body: "x",
      },
    );
    expect(response.status).toBe(414);
  });

  test("DELETE a value, and a wrong method or route is a 404", async () => {
    await c.kvPut(KV_BINDING, "gone", "x", null, Date.now());
    expect(
      (
        await raw(`/storage/kv/namespaces/${KV_BINDING}/values/gone`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect(await c.kvGet(KV_BINDING, "gone")).toBeUndefined();
    expect(
      (
        await raw(`/storage/kv/namespaces/${KV_BINDING}/values/x`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      (await raw(`/storage/kv/namespaces/${KV_BINDING}/metadata/x`)).status,
    ).toBe(404);
    expect((await raw(`/nowhere`)).status).toBe(404);
  });

  test("bulk routes refuse malformed bodies", async () => {
    const bulkGet = await raw(`/storage/kv/namespaces/${KV_BINDING}/bulk/get`, {
      method: "POST",
      body: JSON.stringify({ keys: [1] }),
    });
    expect(bulkGet.status).toBe(400);
    const bulkDelete = await raw(
      `/storage/kv/namespaces/${KV_BINDING}/bulk/delete`,
      {
        method: "POST",
        body: JSON.stringify("k"),
      },
    );
    expect(bulkDelete.status).toBe(400);
    const bulkPut = await raw(`/storage/kv/namespaces/${KV_BINDING}/bulk`, {
      method: "PUT",
      body: "not json",
    });
    expect(bulkPut.status).toBe(400);
  });

  test("a bulk write reports the pairs the binding refused as unsuccessful", async () => {
    const response = await raw(`/storage/kv/namespaces/${KV_BINDING}/bulk`, {
      method: "PUT",
      body: JSON.stringify([
        { key: "fine", value: "x" },
        { key: "short", value: "x", expiration_ttl: 30 },
      ]),
    });
    expect(((await response.json()) as { result: unknown }).result).toEqual({
      successful_key_count: 1,
      unsuccessful_keys: ["short"],
    });
  });
});

describe("D1 (the smoke test PR-C11 builds on)", () => {
  test("a schema, bytes through unhex/hex, string parameters, RETURNING", async () => {
    await c.d1Query(D1_BINDING, [
      {
        sql: "CREATE TABLE IF NOT EXISTS smoke (k TEXT PRIMARY KEY, v BLOB, n INTEGER, exp INTEGER)",
      },
    ]);
    const bytes = Buffer.from(new Uint8Array(256).map((_, index) => index));
    const [inserted] = await c.d1Query(D1_BINDING, [
      {
        sql: "INSERT INTO smoke (k, v, n, exp) VALUES (?1, unhex(?2), ?3, NULLIF(?4, '')) RETURNING k, typeof(n) AS t, exp IS NULL AS noexp",
        params: ["a", bytes.toString("hex"), "41", ""],
      },
    ]);
    expect(inserted.results).toEqual([{ k: "a", t: "integer", noexp: 1 }]);
    const [read] = await c.d1Query(D1_BINDING, [
      {
        sql: "SELECT hex(v) AS v, n + ?2 AS m FROM smoke WHERE k = ?1",
        params: ["a", "-1"],
      },
    ]);
    expect(Buffer.from(read.results[0].v as string, "hex").equals(bytes)).toBe(
      true,
    );
    expect(read.results[0].m).toBe(40);
  });

  test("/raw answers columns and rows", async () => {
    const [result] = await c.d1Raw(D1_BINDING, [
      { sql: "SELECT 1 AS one, 'x' AS two" },
    ]);
    expect(result.results).toEqual({
      columns: ["one", "two"],
      rows: [[1, "x"]],
    });
  });

  test("a batch is one transaction: a failing statement rolls back the ones before it", async () => {
    await c.d1Query(D1_BINDING, [
      { sql: "CREATE TABLE IF NOT EXISTS atom (id INTEGER PRIMARY KEY)" },
    ]);
    await expect(
      c.d1Query(D1_BINDING, [
        { sql: "INSERT INTO atom VALUES (1)" },
        { sql: "INSERT INTO atom VALUES (1)" },
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const [count] = await c.d1Query(D1_BINDING, [
      { sql: "SELECT count(*) AS c FROM atom" },
    ]);
    expect(count.results).toEqual([{ c: 0 }]);
  });

  test("BEGIN is refused (D1 is SQLite in a Durable Object)", async () => {
    await expect(
      c.d1Query(D1_BINDING, [{ sql: "BEGIN TRANSACTION" }]),
    ).rejects.toThrow(/transaction/i);
  });

  test("parameters must be strings, and each query needs sql", async () => {
    const numbers = await raw(`/d1/database/${D1_BINDING}/query`, {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT ?1", params: [1] }),
    });
    expect(numbers.status).toBe(400);
    expect(await numbers.text()).toContain(
      "params must be an array of strings",
    );
    const noSql = await raw(`/d1/database/${D1_BINDING}/query`, {
      method: "POST",
      body: JSON.stringify({ batch: [{ sql: "SELECT 1" }, {}] }),
    });
    expect(noSql.status).toBe(400);
    expect(
      (
        await raw(`/d1/database/${D1_BINDING}/other`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
});

describe("the module", () => {
  test("imports nothing, and its default export is a fetch handler", async () => {
    const source = await Bun.file(
      new URL("../../lib/cloudflare/worker.ts", import.meta.url),
    ).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(typeof worker.fetch).toBe("function");
  });
});
