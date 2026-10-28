// A Worker that answers the Cloudflare REST API's KV and D1 data paths over
// real bindings: the shapes documented at
// developers.cloudflare.com/api/resources/kv/... and .../d1/... (2026-10-28).
// Served by workerd (through miniflare) it is the spike's local test server;
// deployed, it is the "binding proxy" transport. Auth: `Authorization: Bearer
// <env.TOKEN>`. Every KV namespace id maps to env.KV, every database id to
// env.DB (a real proxy would map ids to bindings; one of each is enough here).

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const ok = (result, extra = {}) =>
  json({ success: true, errors: [], messages: [], result, ...extra });
const fail = (status, code, message) =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

/** The REST API's expiry query/body fields → the binding's put options. */
function expiryOptions(expiration, expirationTtl) {
  const options = {};
  if (expirationTtl !== undefined && expirationTtl !== null && expirationTtl !== "") {
    options.expirationTtl = Number(expirationTtl); // takes precedence (documented)
  } else if (expiration !== undefined && expiration !== null && expiration !== "") {
    options.expiration = Number(expiration);
  }
  return options;
}

async function kv(request, env, rest) {
  const store = env.KV;
  const url = new URL(request.url);
  // values/:key
  if (rest[0] === "values" && rest.length === 2) {
    const key = decodeURIComponent(rest[1]);
    if (request.method === "GET") {
      const { value, metadata } = await store.getWithMetadata(key, { type: "arrayBuffer" });
      if (value === null) return fail(404, 10009, "get: 'key not found'");
      // The binding does not expose a key's expiration on get; list() does.
      const listed = await store.list({ prefix: key, limit: 1 });
      const hit = listed.keys.find((k) => k.name === key);
      const headers = {};
      if (hit?.expiration !== undefined) headers.expiration = String(hit.expiration);
      void metadata;
      return new Response(value, { headers });
    }
    if (request.method === "PUT") {
      const options = expiryOptions(url.searchParams.get("expiration"), url.searchParams.get("expiration_ttl"));
      const type = request.headers.get("content-type") ?? "";
      let value;
      if (type.includes("multipart/form-data")) {
        const form = await request.formData();
        const v = form.get("value");
        value = typeof v === "string" ? v : await v.arrayBuffer();
        const m = form.get("metadata");
        if (m !== null) options.metadata = JSON.parse(typeof m === "string" ? m : await m.text());
      } else {
        value = await request.arrayBuffer();
      }
      try {
        await store.put(key, value, options);
      } catch (error) {
        return fail(400, 10001, String(error?.message ?? error));
      }
      return ok({});
    }
    if (request.method === "DELETE") {
      await store.delete(key);
      return ok({});
    }
  }
  // metadata/:key
  if (rest[0] === "metadata" && rest.length === 2 && request.method === "GET") {
    const { value, metadata } = await store.getWithMetadata(decodeURIComponent(rest[1]), { type: "stream" });
    if (value === null) return fail(404, 10009, "metadata: 'key not found'");
    await value.cancel();
    return ok(metadata);
  }
  // keys?prefix&limit&cursor
  if (rest[0] === "keys" && request.method === "GET") {
    const limit = url.searchParams.get("limit");
    const listed = await store.list({
      prefix: url.searchParams.get("prefix") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: limit === null ? undefined : Number(limit),
    });
    return ok(
      listed.keys.map((k) => ({ name: k.name, expiration: k.expiration, metadata: k.metadata })),
      { result_info: { count: listed.keys.length, cursor: listed.list_complete ? "" : listed.cursor } },
    );
  }
  // bulk/get: { keys (<= 100), type?: "text" | "json", withMetadata? }
  if (rest[0] === "bulk" && rest[1] === "get" && request.method === "POST") {
    const body = await request.json();
    if (!Array.isArray(body.keys) || body.keys.length > 100) return fail(400, 10001, "keys: at most 100");
    const type = body.type === "json" ? "json" : "text";
    const values = {};
    if (body.withMetadata) {
      const got = await store.getWithMetadata(body.keys, { type });
      for (const key of body.keys) {
        const entry = got.get(key);
        values[key] = entry === undefined || entry === null || entry.value === null
          ? null : { value: entry.value, metadata: entry.metadata };
      }
    } else {
      const got = await store.get(body.keys, { type });
      for (const key of body.keys) values[key] = got.get(key) ?? null;
    }
    return ok({ values });
  }
  // bulk (PUT, write) — [{ key, value, base64?, expiration?, expiration_ttl?, metadata? }] (<= 10,000)
  if (rest[0] === "bulk" && rest.length === 1 && request.method === "PUT") {
    const pairs = await request.json();
    if (!Array.isArray(pairs) || pairs.length > 10_000) return fail(400, 10001, "at most 10,000 pairs");
    const unsuccessful = [];
    let count = 0;
    for (const p of pairs) {
      const options = expiryOptions(p.expiration, p.expiration_ttl);
      if (p.metadata !== undefined) options.metadata = p.metadata;
      const value = p.base64 ? Uint8Array.from(atob(p.value), (c) => c.charCodeAt(0)) : p.value;
      try {
        await store.put(p.key, value, options);
        count++;
      } catch {
        unsuccessful.push(p.key);
      }
    }
    return ok({ successful_key_count: count, unsuccessful_keys: unsuccessful });
  }
  // bulk/delete (POST) — ["key", ...] (<= 10,000)
  if (rest[0] === "bulk" && rest[1] === "delete" && request.method === "POST") {
    const keys = await request.json();
    for (const key of keys) await store.delete(key);
    return ok({ successful_key_count: keys.length, unsuccessful_keys: [] });
  }
  return fail(404, 10000, "no such KV route");
}

async function d1(request, env, rest) {
  const raw = rest[0] === "raw";
  if (!(rest[0] === "query" || raw) || request.method !== "POST") return fail(404, 7500, "no such D1 route");
  const body = await request.json();
  const queries = Array.isArray(body.batch) ? body.batch : [body];
  for (const q of queries) {
    // The documented schema: params is an array of strings.
    if (q.params !== undefined && !(Array.isArray(q.params) && q.params.every((p) => typeof p === "string"))) {
      return fail(400, 7400, "params must be an array of strings");
    }
  }
  const statements = queries.map((q) => {
    const s = env.DB.prepare(q.sql);
    return q.params?.length ? s.bind(...q.params) : s;
  });
  try {
    // The binding's batch(): "Batched statements are SQL transactions."
    const results = env.MODE_SEQUENTIAL === "1"
      ? await (async () => { const out = []; for (const s of statements) out.push(await s.all()); return out; })()
      : await env.DB.batch(statements);
    return ok(results.map((r) => {
      if (!raw) return { results: r.results, success: r.success, meta: r.meta };
      const columns = r.results.length > 0 ? Object.keys(r.results[0]) : [];
      return { results: { columns, rows: r.results.map((row) => columns.map((c) => row[c])) }, success: r.success, meta: r.meta };
    }));
  } catch (error) {
    return fail(400, 7500, String(error?.message ?? error));
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.TOKEN}`) {
      return fail(401, 10000, "Authentication error");
    }
    const parts = new URL(request.url).pathname.split("/").filter(Boolean);
    // /client/v4/accounts/:account/storage/kv/namespaces/:ns/...
    // /client/v4/accounts/:account/d1/database/:db/(query|raw)
    const at = parts.indexOf("accounts");
    if (at < 0) return fail(404, 10000, "no such route");
    const rest = parts.slice(at + 2);
    if (rest[0] === "storage" && rest[1] === "kv" && rest[2] === "namespaces") return kv(request, env, rest.slice(4));
    if (rest[0] === "d1" && rest[1] === "database") return d1(request, env, rest.slice(3));
    return fail(404, 10000, "no such route");
  },
};
