/**
 * Bodies beyond JSON (typed-client plan, `other-transports.md` §3–§4,
 * PR-C9), against real bun-common routes through `router.fetch()` (and one
 * served socket, for a streamed request body over the network):
 *
 * - multipart bodies built from typed fields and files (a `Blob` named
 *   `"blob"`), urlencoded forms, a pre-built `FormData` passed through
 *   unchecked; the files checked before anything is sent;
 * - NDJSON streams checked line by line (a bad line delivered under
 *   `"warn"`, refused under `"throw"`), split across chunks, a line that is
 *   not JSON refused, iteration stopped early; raw chunks;
 * - downloads by kind (`Blob`, `File` named from `Content-Disposition`,
 *   stream, `ArrayBuffer`);
 * - streaming request bodies, never retried.
 *
 * Every check has its control.
 */
import type { RouteManifest, SchemaSource } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { BunRouter, chunks } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { ClientError, createClient, ValidationError } from "../lib/index";

interface Routes {
  "GET /lines": {
    query: { bad?: string; broken?: string };
    responses: { 200: AsyncIterable<{ n: number }> };
  };
  "GET /bytes": { responses: { 200: AsyncIterable<Uint8Array> } };
  "POST /upload": {
    body: { title?: string; meta?: { tags: string[] } } | undefined;
    files: { doc?: Blob; more?: Blob[] };
    responses: { 200: Echo };
  };
  "POST /form": {
    body: { user: string; tags?: string[]; addr?: { city: string } };
    responses: { 200: unknown };
  };
  "PUT /stream": {
    body: ReadableStream<Uint8Array>;
    responses: { 200: { got: string }; 503: unknown };
  };
  "GET /file": {
    query: { name?: string };
    responses: { 200: Blob };
  };
}

/** What `/upload` answers: the fields and each file it received. */
interface Echo {
  fields: Record<string, unknown>;
  files: { field: string; name: string; type: string; size: number }[];
}

const manifest = {
  "GET /lines": { chunks: { 200: "ndjson" } },
  "GET /bytes": { chunks: { 200: "raw" } },
  "POST /upload": { bodyType: "multipart" },
  "POST /form": { bodyType: "urlencoded" },
} as const satisfies RouteManifest<Routes>;

/** Counts the `/stream` attempts, which answer 503 first when asked. */
let streamAttempts = 0;

function buildRouter(): BunRouter {
  const router = new BunRouter();
  router.get("/lines", (req, res) => {
    res.setHeader("content-type", "application/x-ndjson");
    res.status(200);
    if (req.query.broken) {
      void res.end('{"n":1}\nnope\n');
      return;
    }
    // A line split across writes, a CRLF, a blank line, a last line
    // without its newline.
    void res.write('{"n":1}\n{"n"');
    void res.write(":2}\r\n\n");
    void res.end(req.query.bad ? '{"n":"x"}\n{"n":4}' : '{"n":3}');
  });
  router.get("/bytes", (_req, res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.status(200);
    void res.write(new Uint8Array([1, 2]));
    void res.end(new Uint8Array([3]));
  });
  router.post("/upload", async (req, res) => {
    const parts = await req.getMultiParts({});
    res.json({
      fields: parts.fields,
      files: [...parts.files.keys()]
        .map((file) => ({
          field: file.fieldname,
          name: file.originalFilename,
          type: file.mimeType,
          size: file.file.byteLength,
        }))
        .sort((a, b) => a.size - b.size),
    });
  });
  router.post("/form", (req, res) =>
    res.json({ type: req.headers["content-type"], body: req.body }),
  );
  router.put("/stream", (req, res) => {
    streamAttempts++;
    if (req.query.fail && streamAttempts === 1) {
      res.status(503).json({});
      return;
    }
    res.json({ got: new TextDecoder().decode(req.body as Uint8Array) });
  });
  router.get("/file", (req, res) => {
    const name = req.query.name as string | undefined;
    if (name === "star")
      res.setHeader(
        "content-disposition",
        "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
      );
    else if (name === "quoted")
      res.setHeader(
        "content-disposition",
        'attachment; filename="a \\"b\\".pdf"',
      );
    else if (name === "bare")
      res.setHeader("content-disposition", "attachment; filename=plain.pdf");
    res.setHeader("content-type", "application/pdf");
    res.status(200).send(new Blob(["%PDF"]));
  });
  return router;
}

const router = buildRouter();

/** A logger recording its warnings. */
function recorder() {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn: (message: string) => void warnings.push(message),
      error: () => {},
      debug: () => {},
    },
  };
}

/** A client of the router, recording what it sent. */
function client(extra: Parameters<typeof createClient<Routes>>[0] = {}): {
  api: ReturnType<typeof createClient<Routes>>;
  sent: Request[];
} {
  const sent: Request[] = [];
  const api = createClient<Routes>({
    baseUrl: "http://app.test",
    fetch: (request) => {
      sent.push(request);
      return router.fetch(request);
    },
    manifest,
    retry: false,
    mode: "production",
    ...extra,
  });
  return { api, sent };
}

/** Collects an async iterable. */
async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of values) out.push(value);
  return out;
}

/** The rejection of `promise`, or a failure when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const Line = z.object({ n: z.number() });
const SOURCE: SchemaSource<Routes> = {
  schemas: {
    "GET /lines": { responses: { 200: Line } },
    "POST /upload": {
      body: z.optional(z.looseObject({ title: z.optional(z.string().min(2)) })),
      files: z.looseObject({
        doc: z.file().check(z.maxSize(8)),
        more: z.optional(z.array(z.file()).check(z.maxLength(2))),
      }),
    },
  },
};

describe("multipart and urlencoded bodies (other-transports.md §3)", () => {
  it('builds the FormData from typed fields and files; a Blob goes out named "blob"', async () => {
    const { api } = client();
    const r = await api.post("/upload", {
      body: { title: "Report", meta: { tags: ["a", "b"] } },
      files: {
        doc: new File(["hello"], "doc.txt", { type: "text/plain" }),
        more: [new Blob(["x"], { type: "application/pdf" }), new Blob(["yy"])],
      },
      throwOnError: true,
    });
    expect(r.fields).toEqual({ title: "Report", meta: { tags: ["a", "b"] } });
    expect(r.files).toEqual([
      { field: "more", name: "blob", type: "application/pdf", size: 1 },
      {
        field: "more",
        name: "blob",
        type: "application/octet-stream",
        size: 2,
      },
      {
        field: "doc",
        name: "doc.txt",
        type: expect.stringMatching(/^text\/plain/),
        size: 5,
      },
    ]);
  });

  it("control: appended bare, a typed Blob reaches busboy as a field, not a file (oven-sh/bun#35439)", async () => {
    const form = new FormData();
    form.append("more", new Blob(["x"], { type: "application/pdf" }));
    const response = await router.fetch("/upload", {
      method: "POST",
      body: form,
    });
    const echo = (await response.json()) as Echo;
    expect(echo.files).toEqual([]);
    expect(echo.fields).toEqual({ more: "x" });
  });

  it("sends a multipart route's plain-object body as FormData with no files, and a pre-built FormData as it is", async () => {
    const { api, sent } = client();
    const fields = await api.post("/upload", {
      body: { title: "Only" },
      throwOnError: true,
    });
    expect(fields).toEqual({ fields: { title: "Only" }, files: [] });
    expect(sent[0].headers.get("content-type")).toStartWith(
      "multipart/form-data; boundary=",
    );
    const form = new FormData();
    form.set("title", "Pre");
    const prebuilt = await api.post("/upload", {
      body: form as never,
      throwOnError: true,
    });
    expect(prebuilt.fields).toEqual({ title: "Pre" });
  });

  it("sends an urlencoded route's fields as a form bun-common parses back (control: a JSON route's body stays JSON)", async () => {
    const { api, sent } = client();
    const r = await api.post("/form", {
      body: { user: "Ada Love", tags: ["x"], addr: { city: "Lagos" } },
      throwOnError: true,
    });
    expect(r).toEqual({
      type: "application/x-www-form-urlencoded",
      body: { user: "Ada Love", tags: ["x"], addr: { city: "Lagos" } },
    });
    const json = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: (request) => {
        sent.push(request);
        return router.fetch(request);
      },
      retry: false,
    });
    await json.post("/form", { body: { user: "Ada" } });
    expect(sent.at(-1)!.headers.get("content-type")).toBe("application/json");
  });

  it("checks the files before anything is sent: presence, size, count (control: valid files are sent)", async () => {
    const { api, sent } = client({ mode: "development", schemas: SOURCE });
    const missing = await rejection(api.post("/upload", { files: {} }));
    expect(missing).toBeInstanceOf(ValidationError);
    expect((missing as ValidationError).issues).toEqual([
      expect.objectContaining({
        target: "files",
        path: "doc",
        source: "builtin",
      }),
    ]);
    const big = (await rejection(
      api.post("/upload", {
        body: { title: "x" },
        files: {
          doc: new Blob(["123456789"]),
          more: [new Blob([]), new Blob([]), new Blob([])],
        },
      }),
    )) as ValidationError;
    expect(big.issues.map((issue) => `${issue.target}:${issue.path}`)).toEqual([
      "body:title",
      "files:doc",
      "files:more",
    ]);
    expect(sent).toHaveLength(0);
    const ok = await api.post("/upload", {
      body: { title: "ok" },
      files: { doc: new Blob(["1234"]) },
    });
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("runs a BYO files schema, and leaves a pre-built FormData body unchecked (control: a plain body is checked)", async () => {
    const { api } = client({ mode: "development", schemas: SOURCE });
    const custom = (await rejection(
      api.post("/upload", {
        files: { doc: new Blob(["1"]) },
        validate: {
          files: {
            custom: z.object({ doc: z.file().check(z.mime(["image/png"])) }),
          },
        },
      }),
    )) as ValidationError;
    expect(custom.issues).toEqual([
      expect.objectContaining({
        target: "files",
        path: "doc",
        source: "custom",
      }),
    ]);
    const form = new FormData();
    form.set("title", "x");
    form.set("doc", new File(["1"], "d.txt"));
    const prebuilt = await api.post("/upload", {
      body: form as never,
      files: undefined as never,
    });
    expect(prebuilt.status).toBe(200);
    const plain = await rejection(
      api.post("/upload", {
        body: { title: "x" },
        files: { doc: new Blob(["1"]) },
      }),
    );
    expect(plain).toBeInstanceOf(ValidationError);
  });
});

describe("NDJSON and raw streams (other-transports.md §4)", () => {
  it("iterates NDJSON lines across chunk boundaries, CRLF and blank lines, the last without its newline", async () => {
    const { api } = client();
    const r = await api.get("/lines", { throwOnError: true });
    expect(await collect(r)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('checks each line: a bad line is delivered under "warn" (control: a good stream warns nothing)', async () => {
    const log = recorder();
    const { api } = client({
      mode: "development",
      schemas: SOURCE,
      logger: log.logger,
    });
    expect(
      await collect(await api.get("/lines", { throwOnError: true })),
    ).toHaveLength(3);
    expect(log.warnings).toEqual([]);
    const lines = await collect(
      await api.get("/lines", { query: { bad: "1" }, throwOnError: true }),
    );
    expect(lines).toEqual([{ n: 1 }, { n: 2 }, { n: "x" }, { n: 4 }] as never);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain(
      "GET /lines response 200 failed validation",
    );
  });

  it('refuses a bad line under "throw", after delivering the lines before it', async () => {
    const { api } = client({
      mode: "development",
      schemas: SOURCE,
      validate: { onFailure: { response: "throw" } },
    });
    const r = await api.get("/lines", {
      query: { bad: "1" },
      throwOnError: true,
    });
    const seen: unknown[] = [];
    const error = await rejection(
      (async () => {
        for await (const line of r) seen.push(line);
      })(),
    );
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(200);
  });

  it("checks lines with a server's own chunks() declaration (its chunk schema) and a BYO transform", async () => {
    const { api } = client({
      mode: "development",
      schemas: {
        schemas: {
          "GET /lines": {
            responses: { 200: chunks(Line, { framing: "ndjson" }) },
          },
        },
      },
      validate: { onFailure: { response: "throw" } },
    });
    const error = await rejection(
      collect(
        await api.get("/lines", { query: { bad: "1" }, throwOnError: true }),
      ),
    );
    expect(error).toBeInstanceOf(ValidationError);
    const byo = await api.get("/lines", {
      throwOnError: true,
      validate: {
        response: {
          200: { custom: Line.transform((line) => ({ n: line.n * 10 })) },
        },
      },
    });
    expect(await collect(byo)).toEqual([{ n: 10 }, { n: 20 }, { n: 30 }]);
  });

  it("refuses a line that is not JSON, naming it", async () => {
    const { api } = client();
    const r = await api.get("/lines", {
      query: { broken: "1" },
      throwOnError: true,
    });
    const error = await rejection(collect(r));
    expect(error).toBeInstanceOf(ClientError);
    expect((error as Error).message).toBe(
      "GET /lines answered 200 with line 2 that is not JSON",
    );
  });

  it("releases the body when iteration stops early", async () => {
    const { api } = client();
    const r = await api.get("/lines");
    if (!r.ok) throw new Error("expected 200");
    const lines = r.data[Symbol.asyncIterator]();
    expect(await lines.next()).toEqual({ done: false, value: { n: 1 } });
    await lines.return?.();
    expect(r.response.body?.locked).toBe(false);
  });

  it("iterates an NDJSON media type with no manifest entry (control: without it, a binary body is a Blob)", async () => {
    const bare = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: (request) => router.fetch(request),
      retry: false,
    });
    expect(
      await collect(await bare.get("/lines", { throwOnError: true })),
    ).toHaveLength(3);
    const bytes = await bare.get("/bytes", { throwOnError: true });
    expect(bytes).toBeInstanceOf(Blob);
  });

  it("iterates raw chunks as Uint8Arrays", async () => {
    const { api } = client();
    const values = await collect(
      await api.get("/bytes", { throwOnError: true }),
    );
    for (const value of values) expect(value).toBeInstanceOf(Uint8Array);
    expect(values.flatMap((value) => [...value])).toEqual([1, 2, 3]);
  });
});

describe("downloads by kind (other-transports.md §4)", () => {
  it("names the File from Content-Disposition: filename* first, quoted, bare; none leaves a Blob", async () => {
    const { api } = client();
    for (const [name, expected] of [
      ["star", "résumé.pdf"],
      ["quoted", 'a "b".pdf'],
      ["bare", "plain.pdf"],
    ] as const) {
      const r = await api.get("/file", { query: { name } });
      if (!r.ok) throw new Error("expected 200");
      expect(r.filename).toBe(expected);
      expect((r.data as File).name).toBe(expected);
      expect(r.data.type).toBe("application/pdf");
    }
    const unnamed = await api.get("/file");
    if (!unnamed.ok) throw new Error("expected 200");
    expect(unnamed.filename).toBeUndefined();
    expect("filename" in unnamed).toBe(false);
    expect(unnamed.data).not.toBeInstanceOf(File);
    expect(await unnamed.data.text()).toBe("%PDF");
  });

  it("delivers the stream unread, or an ArrayBuffer", async () => {
    const { api } = client();
    const stream = await api.get("/file", { as: "stream", throwOnError: true });
    expect(stream).toBeInstanceOf(ReadableStream);
    expect(await new Response(stream).text()).toBe("%PDF");
    const buffer = await api.get("/file", {
      as: "arrayBuffer",
      throwOnError: true,
    });
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(buffer)).toBe("%PDF");
  });
});

describe("streaming request bodies (other-transports.md §4)", () => {
  /** A stream of `parts`, each its own chunk. */
  const streamOf = (...parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts)
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });

  it("passes a ReadableStream body through (router.fetch)", async () => {
    const { api } = client();
    const r = await api.put("/stream", {
      body: streamOf("ab", "cd"),
      headers: { "content-type": "application/octet-stream" },
      throwOnError: true,
    });
    expect(r).toEqual({ got: "abcd" });
  });

  it('streams it over a socket with duplex: "half"', async () => {
    using server = Bun.serve({
      port: 0,
      fetch: (request) => router.fetch(request),
    });
    const api = createClient<Routes>({
      baseUrl: server.url.href.replace(/\/$/, ""),
      retry: false,
    });
    const r = await api.put("/stream", {
      body: streamOf("over ", "the ", "wire"),
      headers: { "content-type": "application/octet-stream" },
      throwOnError: true,
    });
    expect(r).toEqual({ got: "over the wire" });
  });

  it("never retries a streamed body (control: a buffered body is retried)", async () => {
    const { api } = client({ retry: { attempts: 2, baseMs: 1, maxMs: 1 } });
    streamAttempts = 0;
    const streamed = await api.request("PUT /stream", {
      body: streamOf("x"),
      headers: { "content-type": "application/octet-stream" },
      query: { fail: "1" } as never,
    });
    expect(streamed.status).toBe(503);
    expect(streamAttempts).toBe(1);
    streamAttempts = 0;
    const buffered = await api.request("PUT /stream", {
      body: new Blob(["x"]) as never,
      headers: { "content-type": "application/octet-stream" },
      query: { fail: "1" } as never,
    });
    expect(buffered.status).toBe(200);
    expect(streamAttempts).toBe(2);
  });
});
