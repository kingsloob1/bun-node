/**
 * The request builder (plan §6.1) and the result (§4.3, §4.4), against a real
 * bun-common router through `router.fetch()`: verbs, `request`, `url`, named
 * operations, params, bodies, headers at three levels (§6.2), results by
 * status, `throwOnError`, and undeclared statuses.
 */
import type { RouteManifest } from "../lib/index";
import { BunRouter } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  ClientError,
  createClient,
  HttpError,
  UnexpectedStatusError,
} from "../lib/index";

interface User {
  id: string;
  name: string;
  createdAt: Date;
}

interface Problem<C extends string = string> {
  type: string;
  title: string;
  code: C;
}

interface Routes {
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    query: { expand?: string[] };
    body: undefined;
    responses: { 200: User; 404: Problem<"NOT_FOUND"> };
  };
  "POST /users": {
    operationId: "createUser";
    params: Record<never, never>;
    query: Record<never, never>;
    body: { name: string };
    responses: { 201: User; 409: Problem<"CONFLICT"> };
  };
  "PATCH /users/:id": {
    params: { id: string };
    body: { name?: string };
    responses: { 200: User };
  };
  "DELETE /users/:id": {
    operationId: "deleteUser";
    params: { id: string };
    responses: { 204: undefined };
  };
  "GET /files/*path": {
    params: { path: string[] };
    responses: { 200: { path: string[] } };
  };
  "GET /echo": {
    headers: { "x-version"?: "1" | "2" };
    responses: { 200: Record<string, unknown> };
  };
  "POST /raw": {
    body: unknown;
    responses: { 200: { type: string | null } };
  };
  "GET /teapot": {
    responses: { 200: string };
  };
}

const manifest = {
  "GET /users/:id": { operationId: "getUser", statuses: [200, 404] },
  "POST /users": { operationId: "createUser", statuses: [201, 409] },
  "DELETE /users/:id": { operationId: "deleteUser", statuses: [204] },
  "GET /teapot": { statuses: [200] },
} as const satisfies RouteManifest<Routes>;

const users = new Map([
  ["42", { id: "42", name: "Ada", createdAt: new Date(Date.UTC(2026, 0, 1)) }],
]);
const router = new BunRouter();
router.get("/users/:id", (req, res) => {
  const user = users.get(req.params.id);
  if (!user)
    return res
      .status(404)
      .type("application/problem+json")
      .send(
        JSON.stringify({
          type: "about:blank",
          title: "Not Found",
          code: "NOT_FOUND",
          query: req.query,
        }),
      );
  res.json({ ...user, query: req.query });
});
router.post("/users", (req, res) => {
  const body = req.body as { name: string };
  if (body.name === "taken")
    return res
      .status(409)
      .json({ type: "about:blank", title: "Conflict", code: "CONFLICT" });
  res.status(201).json({ id: "43", name: body.name, createdAt: new Date(0) });
});
router.patch("/users/:id", (req, res) =>
  res.json({ id: req.params.id, ...(req.body as object) }),
);
router.delete("/users/:id", (_req, res) => res.status(204).end());
router.get("/files/*path", (req, res) => res.json({ path: req.params.path }));
router.get("/echo", (req, res) => res.json({ ...req.headers }));
router.post("/raw", (req, res) =>
  res.json({ type: req.get("content-type") ?? null }),
);
router.get("/teapot", (_req, res) => res.status(418).send("short and stout"));

const fetchRouter = (request: Request) => router.fetch(request);
const api = createClient<Routes>({ fetch: fetchRouter, manifest });

describe("verbs, request and url", () => {
  it("GETs a path literal with params and query, and returns the declared 200", async () => {
    const result = await api.get("/users/:id", {
      params: { id: "42" },
      query: { expand: ["org", "team"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.data.name).toBe("Ada");
    // A Date crossed as JSON: a string, as Jsonify types it.
    expect(result.data.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.response).toBeInstanceOf(Response);
    expect((result.data as unknown as { query: unknown }).query).toEqual({
      expand: ["org", "team"],
    });
  });

  it("returns a declared error status as a result, narrowed by status", async () => {
    const result = await api.get("/users/:id", { params: { id: "nobody" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    if (result.status === 404) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("POSTs a JSON body with its content type", async () => {
    const result = await api.post("/users", { body: { name: "Grace" } });
    expect(result.status).toBe(201);
    if (result.status === 201) expect(result.data.name).toBe("Grace");
  });

  it("calls by route key, for a method chosen at run time", async () => {
    const result = await api.request("PATCH /users/:id", {
      params: { id: "9" },
      body: { name: "Lin" },
    });
    expect(result.ok && result.data).toEqual({ id: "9", name: "Lin" } as never);
  });

  it("reads a 204 as no body", async () => {
    const result = await api.delete("/users/:id", { params: { id: "42" } });
    expect(result).toMatchObject({ ok: true, status: 204, data: undefined });
  });

  it("encodes params, and writes a wildcard's segments one by one", async () => {
    expect(api.url("/users/:id", { params: { id: "a b/c?" } })).toBe(
      "/users/a%20b%2Fc%3F",
    );
    const result = await api.get("/files/*path", {
      params: { path: ["docs", "a b", "c"] },
    });
    expect(result.ok && result.data).toEqual({ path: ["docs", "a b", "c"] });
  });

  it("builds a URL with the base and the query, sending nothing", () => {
    const based = createClient<Routes>({ baseUrl: "https://api.example/v1" });
    expect(
      based.url("/users/:id", {
        params: { id: "1" },
        query: { expand: ["x", "y"] },
      }),
    ).toBe("https://api.example/v1/users/1?expand=x&expand=y");
  });

  it("throws a ClientError for a missing param (the untyped caller's error)", async () => {
    const untyped = api as unknown as {
      get: (path: string, options?: object) => Promise<unknown>;
    };
    await expect(untyped.get("/users/:id")).rejects.toBeInstanceOf(ClientError);
    await expect(untyped.get("/users/:id")).rejects.toThrow(
      'Missing path param "id"',
    );
  });

  it("refuses a relative URL with no page and no custom fetch", async () => {
    const bare = createClient<Routes>();
    await expect(
      bare.get("/users/:id", { params: { id: "1" } }),
    ).rejects.toThrow("is relative");
  });
});

describe("named operations (api.op)", () => {
  it("calls the route its operationId names", async () => {
    const result = await api.op.getUser({ params: { id: "42" } });
    expect(result.ok && result.data.name).toBe("Ada");
    const created = await api.op.createUser({ body: { name: "Mia" } });
    expect(created.status).toBe(201);
  });

  it("rejects an operation the manifest does not name", async () => {
    const noManifest = createClient<Routes>({ fetch: fetchRouter });
    await expect(
      noManifest.op.getUser({ params: { id: "42" } }),
    ).rejects.toThrow('No operation "getUser"');
  });
});

describe("bodies", () => {
  it("passes FormData, URLSearchParams and Blob through with their own types", async () => {
    const form = new FormData();
    form.set("a", "1");
    const formResult = await api.post("/raw", { body: form });
    expect(formResult.ok && formResult.data.type).toStartWith(
      "multipart/form-data",
    );

    const search = await api.post("/raw", {
      body: new URLSearchParams({ a: "1" }),
    });
    expect(search.ok && search.data.type).toStartWith(
      "application/x-www-form-urlencoded",
    );

    const blob = await api.post("/raw", {
      body: new Blob(["hi"], { type: "text/plain" }),
    });
    expect(blob.ok && blob.data.type).toStartWith("text/plain");

    const sent: string[] = [];
    const capture = createClient<Routes>({
      fetch: async (request) => {
        sent.push(await request.text());
        return Response.json({});
      },
    });
    await capture.post("/raw", { body: new Blob(["blob"]) });
    await capture.post("/raw", { body: new TextEncoder().encode("bytes") });
    expect(sent).toEqual(["blob", "bytes"]);
  });

  it("sends a string body as JSON, since the body is the wire JSON", async () => {
    const result = await api.post("/raw", { body: "hi" });
    expect(result.ok && result.data.type).toBe("application/json");
  });

  it("reads a text body as a string", async () => {
    const result = await api.get("/teapot", { undeclaredStatus: "result" });
    expect(result).toMatchObject({
      ok: false,
      status: 418,
      error: "short and stout",
    });
  });
});

describe("headers at three levels (§6.2)", () => {
  it("merges client, route and call headers by name, the call's winning", async () => {
    const levels = createClient<Routes>({
      fetch: fetchRouter,
      headers: { "x-a": "client", "x-b": "client", "x-c": "client" },
      routes: { "GET /echo": { headers: { "x-b": "route", "x-c": "route" } } },
    });
    const result = await levels.get("/echo", {
      headers: { "x-c": "call", "x-version": "2" },
    });
    expect(result.ok && result.data).toMatchObject({
      "x-a": "client",
      "x-b": "route",
      "x-c": "call",
      "x-version": "2",
    });
  });

  it("calls a headers function per request, with the request context, in level order", async () => {
    const seen: string[] = [];
    let n = 0;
    const levels = createClient<Routes>({
      fetch: fetchRouter,
      headers: (ctx) => {
        seen.push(`${ctx.key} #${ctx.attempt}`);
        return { "x-n": String(++n), "x-b": "client" };
      },
      routes: { "GET /echo": { headers: async () => ({ "x-b": "route" }) } },
    });
    const first = await levels.get("/echo");
    const second = await levels.get("/echo");
    expect(first.ok && first.data).toMatchObject({
      "x-n": "1",
      "x-b": "route",
    });
    expect(second.ok && second.data).toMatchObject({ "x-n": "2" });
    expect(seen).toEqual(["GET /echo #1", "GET /echo #1"]);
  });

  it("sends credentials: same-origin by default, the configured mode otherwise", async () => {
    // Bun's `Request` reads back "include" whatever it was given
    // (oven-sh/bun#17052), so the init the client passes is what is checked.
    const Original = globalThis.Request;
    const modes: (RequestInit["credentials"] | undefined)[] = [];
    globalThis.Request = class extends Original {
      constructor(...args: ConstructorParameters<typeof Request>) {
        modes.push(args[1]?.credentials);
        super(...args);
      }
    } as typeof Request;
    try {
      const capture = (credentials?: RequestInit["credentials"]) =>
        createClient<Routes>({
          credentials,
          fetch: async () => Response.json({}),
        });
      await capture().get("/echo");
      await capture("include").get("/echo");
    } finally {
      globalThis.Request = Original;
    }
    expect(modes).toEqual(["same-origin", "include"]);
  });
});

describe("throwOnError (§4.4)", () => {
  const throwing = createClient<Routes, { throwOnError: true }>({
    fetch: fetchRouter,
    manifest,
    throwOnError: true,
  });

  it("returns the success body", async () => {
    const user = await throwing.get("/users/:id", { params: { id: "42" } });
    expect(user.name).toBe("Ada");
  });

  it("throws HttpError with the declared status and parsed body", async () => {
    const error = await throwing
      .post("/users", { body: { name: "taken" } })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HttpError);
    const typed = error as HttpError<Routes["POST /users"]>;
    expect(typed.status).toBe(409);
    expect(typed.error.code).toBe("CONFLICT");
    expect(typed.key).toBe("POST /users");
  });

  it("is switched per call", async () => {
    const user = await api.get("/users/:id", {
      params: { id: "42" },
      throwOnError: true,
    });
    expect(user.name).toBe("Ada");
    const result = await throwing.get("/users/:id", {
      params: { id: "nobody" },
      throwOnError: false,
    });
    expect(result.status).toBe(404);
  });
});

describe("undeclared statuses (§4.3)", () => {
  it("throws UnexpectedStatusError for a status the manifest does not list, body unread", async () => {
    const error = await api.get("/teapot").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(UnexpectedStatusError);
    const unexpected = error as UnexpectedStatusError;
    expect(unexpected.status).toBe(418);
    expect(unexpected.declared).toEqual([200]);
    expect(await unexpected.response.text()).toBe("short and stout");
  });

  it('returns it as a catch-all result under undeclaredStatus: "result"', async () => {
    const lenient = createClient<Routes, { undeclaredStatus: "result" }>({
      fetch: fetchRouter,
      manifest,
      undeclaredStatus: "result",
    });
    const result = await lenient.get("/teapot");
    expect(result).toMatchObject({
      ok: false,
      status: 418,
      error: "short and stout",
    });
  });

  it("returns every status as declared for a route the manifest does not cover", async () => {
    const result = await api.get("/echo");
    expect(result.status).toBe(200);
    const none = createClient<Routes>({ fetch: fetchRouter });
    const teapot = (await none.get("/teapot")) as unknown as {
      ok: boolean;
      status: number;
    };
    expect(teapot).toMatchObject({ ok: false, status: 418 });
  });

  it("throws UnexpectedStatusError under throwOnError, whatever undeclaredStatus says", async () => {
    await expect(
      api.get("/teapot", { throwOnError: true, undeclaredStatus: "result" }),
    ).rejects.toBeInstanceOf(UnexpectedStatusError);
  });
});

describe("response bodies", () => {
  it("throws a ClientError naming the route for a JSON body that is not JSON", async () => {
    const broken = createClient<Routes>({
      fetch: async () =>
        new Response("{nope", {
          headers: { "content-type": "application/json" },
        }),
    });
    const error = await broken.get("/echo").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).message).toContain(
      "GET /echo answered 200 with a body that is not JSON",
    );
    expect((error as ClientError).cause).toBeInstanceOf(SyntaxError);
  });

  it("reads a binary body as a Blob, and leaves an event stream unread", async () => {
    const binary = createClient<Routes>({
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    const blob = await binary.get("/echo");
    expect(blob.ok && blob.data).toBeInstanceOf(Blob);

    const stream = createClient<Routes>({
      fetch: async () =>
        new Response("data: 1\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    });
    const events = await stream.get("/echo");
    expect(events.ok && events.data).toBeUndefined();
    expect(events.response.bodyUsed).toBe(false);
    expect(await events.response.text()).toBe("data: 1\n\n");
  });

  it("reads no body for HEAD", async () => {
    const head = createClient<{
      "HEAD /users/:id": {
        params: { id: string };
        responses: { 200: undefined };
      };
    }>({
      fetch: fetchRouter,
    });
    const result = await head.head("/users/:id", { params: { id: "42" } });
    expect(result).toMatchObject({ ok: true, status: 200, data: undefined });
  });
});
