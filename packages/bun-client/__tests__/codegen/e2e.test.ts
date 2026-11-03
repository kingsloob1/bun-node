/**
 * The generated module works with `createClient` end to end (typed-client
 * plan §12.1, PR-C2): the fixture app's `Routes` and `manifest`
 * (`fixtures/app.gen.ts`, generated from the app itself) drive a client whose
 * requests run through the app's real pipeline with `router.fetch()`, no
 * socket. Types are asserted beside the values (`bun test --check` checks
 * this file), so the generated types and what arrives agree.
 */
import { describe, expect, it } from "bun:test";
import type { Routes } from "./fixtures/app.gen";
import type { Routes as MountsRoutes } from "./fixtures/mounts.gen";
import { createClient, UnexpectedStatusError } from "../../lib/index";
import { buildRouter } from "./fixtures/app";
import { manifest } from "./fixtures/app.gen";
import { buildRouter as buildMountsRouter } from "./fixtures/mounts";
import { manifest as mountsManifest } from "./fixtures/mounts.gen";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

const router = buildRouter();
const api = createClient<Routes>({
  baseUrl: "http://app.test",
  fetch: (request) => router.fetch(request),
  manifest,
  retry: false,
  headers: { "x-tenant": "acme" },
});

describe("the generated map drives the client through the app", () => {
  it("reads a user, typed from the named components", async () => {
    const r = await api.get("/api/users/:id", {
      params: { id: "42" },
      query: { page: 2, expand: ["org"] },
    });
    expect(r.status).toBe(200);
    if (!r.ok) throw new Error("expected 200");
    const _role: Equal<typeof r.data.role, "admin" | "member"> = true;
    const _zip: Equal<
      NonNullable<typeof r.data.address>["zip"],
      string | null
    > = true;
    void [_role, _zip];
    expect(r.data).toMatchObject({
      id: "42",
      name: "Ada",
      role: "admin",
      tags: ["math"],
      scores: { chess: 9 },
    });
    expect(r.data.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("narrows a declared error to the route's x-bun-errors codes", async () => {
    const r = await api.get("/api/users/:id", { params: { id: "7" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected 404");
    const _code: Equal<typeof r.error.code, "NOT_FOUND" | "GONE"> = true;
    void _code;
    expect(r.status).toBe(404);
    expect(r.error.code).toBe("NOT_FOUND");
  });

  it("calls by operationId through the manifest", async () => {
    const user = await api.op.getUser({
      params: { id: "42" },
      throwOnError: true,
    });
    expect(user.name).toBe("Ada");
    const created = await api.op.createUser({ body: { name: "Grace" } });
    expect(created.status).toBe(201);
    const taken = await api.op.createUser({
      body: { name: "Ada", role: "member" },
    });
    if (taken.ok) throw new Error("expected 409");
    const _conflict: Equal<typeof taken.error.code, "CONFLICT"> = true;
    void _conflict;
    expect(taken.error.code).toBe("CONFLICT");
  });

  it("sends a oneOf body and reads it back", async () => {
    const r = await api.post("/api/shapes", {
      body: { kind: "circle", radius: 2 },
      throwOnError: true,
    });
    expect(r).toEqual({ kind: "circle", radius: 2 });
    if (r.kind === "circle") expect(r.radius).toBe(2);
  });

  it("reads a recursive schema", async () => {
    const tree = await api.get("/api/categories", { throwOnError: true });
    expect(tree[0].children[0].name).toBe("leaf");
    const _children: Equal<
      (typeof tree)[number]["children"][number]["children"],
      typeof tree
    > = true;
    void _children;
  });

  it("reads a bodiless status, an event stream (no body: sse() reads it) and an undeclared route", async () => {
    const gone = await api.delete("/api/users/:id", { params: { id: "42" } });
    expect({ status: gone.status, data: gone.data }).toEqual({
      status: 204,
      data: undefined,
    });
    const events = await api.get("/api/users/:id/events", {
      params: { id: "42" },
    });
    expect({ status: events.status, data: events.data }).toEqual({
      status: 200,
      data: undefined,
    });
    const health = await api.get("/api/health");
    expect(health).toMatchObject({ ok: true, status: 200, data: { ok: true } });
  });

  it("throws for a status the manifest does not declare (§4.3)", async () => {
    // Without the tenant header the server's validator answers 400, which
    // the route does not declare.
    const bare = createClient<Routes>({
      fetch: (request) => router.fetch(request),
      manifest,
      retry: false,
    });
    await expect(
      bare.get("/api/users/:id", { params: { id: "42" } }),
    ).rejects.toBeInstanceOf(UnexpectedStatusError);
  });

  it("builds URLs from the generated keys", () => {
    expect(api.url("/api/users/:id", { params: { id: "a b" } })).toBe(
      "http://app.test/api/users/a%20b",
    );
  });

  it("refuses wrong calls at compile time (negative controls)", () => {
    const never = (_: unknown) => {};
    // @ts-expect-error -- the params are required
    never(() => api.get("/api/users/:id"));
    never(() =>
      api.get("/api/users/:id", {
        params: { id: "1" },
        // @ts-expect-error -- page is a number on the wire
        query: { page: "2" },
      }),
    );
    // @ts-expect-error -- not a route of the map
    never(() => api.get("/api/users"));
    // @ts-expect-error -- the body needs a name
    never(() => api.post("/api/users", { body: { role: "admin" } }));
    never(() =>
      api.post("/api/shapes", {
        // @ts-expect-error -- no such shape kind
        body: { kind: "triangle", radius: 1 },
      }),
    );
    // @ts-expect-error -- no such operation
    never(() => api.op.getUsers());
  });
});

describe("bodies beyond JSON through the app (PR-C9, other-transports.md §3–§4)", () => {
  it("uploads typed fields and files as multipart/form-data", async () => {
    const r = await api.post("/api/users/:id/avatar", {
      params: { id: "42" },
      body: { caption: "me" },
      files: {
        avatar: new File(["png!"], "me.png", { type: "image/png" }),
        extras: [new Blob(["a"]), new Blob(["bb"], { type: "text/csv" })],
      },
      throwOnError: true,
    });
    const _size: Equal<(typeof r.files)[number]["size"], number> = true;
    void _size;
    expect(r).toEqual({
      caption: "me",
      files: [
        { field: "avatar", name: "me.png", type: "image/png", size: 4 },
        {
          field: "extras",
          name: "blob",
          type: "application/octet-stream",
          size: 1,
        },
        // Bun's Blob constructor adds the charset (oven-sh/bun#35439).
        {
          field: "extras",
          name: "blob",
          type: expect.stringMatching(/^text\/csv/),
          size: 2,
        },
      ],
    });
  });

  it("sends an urlencoded route's fields as a form", async () => {
    const r = await api.op.login({
      body: { user: "ada", tags: ["x"] },
      throwOnError: true,
    });
    expect(r).toEqual({ user: "ada", tags: ["x"] });
  });

  it("iterates an NDJSON stream, typed per line", async () => {
    const r = await api.get("/api/exports/users", { throwOnError: true });
    const names: string[] = [];
    for await (const row of r) {
      const _row: Equal<typeof row, { id: string; name: string }> = true;
      void _row;
      names.push(row.name);
    }
    expect(names).toEqual(["Ada", "Grace"]);
  });

  it("iterates a raw stream's bytes", async () => {
    const r = await api.get("/api/users/:id/avatar", {
      params: { id: "42" },
      throwOnError: true,
    });
    const bytes: number[] = [];
    for await (const chunk of r) {
      const _chunk: Equal<typeof chunk, Uint8Array> = true;
      void _chunk;
      bytes.push(...chunk);
    }
    expect(bytes).toEqual([1, 2, 3]);
  });

  it("downloads by kind: a named Blob, a stream, an ArrayBuffer; a 404 stays problem+json", async () => {
    const blob = await api.get("/api/users/:id/report", {
      params: { id: "42" },
    });
    if (!blob.ok) throw new Error("expected 200");
    const _blob: Equal<typeof blob.data, Blob> = true;
    void _blob;
    expect(blob.filename).toBe("report-42.pdf");
    expect(blob.data).toBeInstanceOf(File);
    expect((blob.data as File).name).toBe("report-42.pdf");
    expect(await blob.data.text()).toBe("%PDF-1.7");

    const stream = await api.get("/api/users/:id/report", {
      params: { id: "42" },
      as: "stream",
      throwOnError: true,
    });
    const _stream: Equal<typeof stream, ReadableStream<Uint8Array>> = true;
    void _stream;
    expect(await new Response(stream).text()).toBe("%PDF-1.7");

    const buffer = await api.get("/api/users/:id/report", {
      params: { id: "42" },
      as: "arrayBuffer",
      throwOnError: true,
    });
    const _buffer: Equal<typeof buffer, ArrayBuffer> = true;
    void _buffer;
    expect(new TextDecoder().decode(buffer)).toBe("%PDF-1.7");

    const missing = await api.get("/api/users/:id/report", {
      params: { id: "7" },
      as: "stream",
    });
    if (missing.ok) throw new Error("expected 404");
    expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("refuses wrong bodies at compile time (negative controls)", () => {
    const never = (_: unknown) => {};
    never(() =>
      api.post("/api/users/:id/avatar", {
        params: { id: "1" },
        // @ts-expect-error -- the avatar file is required
        files: {},
      }),
    );
    never(() =>
      api.post("/api/users/:id/avatar", {
        params: { id: "1" },
        // @ts-expect-error -- extras is a list of files
        files: { avatar: new Blob([]), extras: new Blob([]) },
      }),
    );
    // @ts-expect-error -- the form needs its user
    never(() => api.post("/api/sessions", { body: { tags: [] } }));
    never(() =>
      // @ts-expect-error -- no such download kind
      api.get("/api/users/:id/report", { params: { id: "1" }, as: "text" }),
    );
  });
});

describe("a registry mounted twice (fixtures/mounts.ts)", () => {
  const mounts = buildMountsRouter();
  const client = createClient<MountsRoutes>({
    baseUrl: "http://app.test",
    fetch: (request) => mounts.fetch(request),
    manifest: mountsManifest,
    retry: false,
  });

  it("calls each mount by its own operation name", async () => {
    const one = await client.op.getUser({
      params: { id: "1" },
      throwOnError: true,
    });
    expect(one).toEqual({ id: "1", version: "v1" });
    const two = await client.op.getUserV2({
      params: { id: "2" },
      throwOnError: true,
    });
    expect(two).toEqual({ id: "2", version: "v2" });
    const listed = await client.op.listUsersV2({ throwOnError: true });
    expect(listed).toEqual([]);
  });

  it("types the two names apart (negative controls)", () => {
    const never = (_: unknown) => {};
    // @ts-expect-error -- the suffix names the second mount, not the first
    never(() => client.op.getUserUsers());
    // @ts-expect-error -- the params are required on the second mount too
    never(() => client.op.getUserV2());
  });
});
