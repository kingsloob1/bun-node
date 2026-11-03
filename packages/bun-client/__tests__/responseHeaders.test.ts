/**
 * Response headers (typed-client plan §5.6, a PR-C4 follow-up): the headers
 * a route declares per status are checked when the response arrives, under
 * the same switch and failure mode as the body.
 *
 * - a missing or invalid declared header warns and the response is
 *   delivered (the default), throws under `"throw"`, reaches a hook;
 * - header and body issues come in one error, headers first;
 * - `false` for the status turns the header check off; `replace: true`
 *   replaces the body's built-in schema only, so the headers are still
 *   checked; a BYO schema checks the body alone;
 * - a body left unread (a download as `"stream"`, an NDJSON stream) has its
 *   headers checked once, before it is handed on;
 * - production checks nothing.
 *
 * The server is a `fetch` stub answering a fixed response. Every check has
 * its control.
 */
import type { SchemaSource, ValidationErrorIssue } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createClient, ValidationError } from "../lib/index";

interface Routes {
  "GET /pets": {
    responses: { 200: { id: string }[]; 404: { code: string } };
    responseHeaders: {
      200: { "x-total-count": string; "x-page"?: "first" | "next" };
    };
  };
  "GET /export": {
    responses: { 200: AsyncIterable<{ id: string }> };
    responseHeaders: { 200: { "x-export-id": string } };
  };
  "GET /file": {
    responses: { 200: Blob };
    responseHeaders: { 200: { "x-checksum": string } };
  };
}

/** The built-in schemas, as a generated module writes them. */
const SOURCE: SchemaSource<Routes> = {
  schemas: {
    "GET /pets": {
      responses: {
        200: z.array(z.looseObject({ id: z.string() })),
        404: z.looseObject({ code: z.string() }),
      },
      responseHeaders: {
        200: z.looseObject({
          "x-total-count": z.string().regex(/^\d+$/),
          "x-page": z.optional(z.enum(["first", "next"])),
        }),
      },
    },
    "GET /export": {
      responses: { 200: z.looseObject({ id: z.string() }) },
      responseHeaders: {
        200: z.looseObject({ "x-export-id": z.string() }),
      },
    },
    "GET /file": {
      responseHeaders: { 200: z.looseObject({ "x-checksum": z.string() }) },
    },
  },
};

/** The manifest's streamed status. */
const MANIFEST = { "GET /export": { chunks: { 200: "ndjson" } } } as const;

/** A stub server: answers `make()` to every request, counting them. */
function server(make: () => Response) {
  let served = 0;
  return {
    get served() {
      return served;
    },
    fetch: () => {
      served++;
      return Promise.resolve(make());
    },
  };
}

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

/** A JSON answer with `headers`. */
function json(
  body: unknown,
  headers: Record<string, string>,
  status = 200,
): Response {
  return Response.json(body, { status, headers });
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

/** A client of the stub, in development, with the built-in schemas. */
function client(
  stub: ReturnType<typeof server>,
  log: ReturnType<typeof recorder>,
  extra: Parameters<typeof createClient<Routes>>[0] = {},
) {
  return createClient<Routes>({
    baseUrl: "http://api.test",
    fetch: stub.fetch,
    schemas: SOURCE,
    manifest: MANIFEST,
    mode: "development",
    retry: false,
    logger: log.logger,
    ...extra,
  });
}

describe("declared response headers (§5.6)", () => {
  it("a missing or invalid header warns and the response is delivered (control: valid headers warn nothing)", async () => {
    const log = recorder();
    let headers: Record<string, string> = { "x-total-count": "2" };
    const api = client(
      server(() => json([{ id: "1" }], headers)),
      log,
    );
    const valid = await api.get("/pets");
    expect(valid.ok && valid.data).toEqual([{ id: "1" }]);
    expect(log.warnings).toEqual([]);

    headers = { "x-page": "last" };
    const drifted = await api.get("/pets");
    expect(drifted.ok && drifted.data).toEqual([{ id: "1" }]);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain("GET /pets response 200");
    expect(log.warnings[0]).toContain("headers.x-total-count");
    expect(log.warnings[0]).toContain("headers.x-page");
  });

  it('"throw" rejects with the headers\' issues, target `headers`, direction `response`', async () => {
    const log = recorder();
    const api = client(
      server(() => json([{ id: "1" }], { "x-total-count": "many" })),
      log,
      { validate: { onFailure: { response: "throw" } } },
    );
    const error = await rejection(api.get("/pets"));
    expect(error).toBeInstanceOf(ValidationError);
    const failure = error as ValidationError;
    expect(failure.direction).toBe("response");
    expect(failure.status).toBe(200);
    expect(failure.issues).toEqual([
      expect.objectContaining({
        target: "headers",
        path: "x-total-count",
        key: "200",
        source: "builtin",
      }) as ValidationErrorIssue,
    ]);
    expect(log.warnings).toEqual([]);
  });

  it("a hook is called with the error, and the response delivered when it returns", async () => {
    const seen: ValidationError[] = [];
    const api = client(
      server(() => json([{ id: "1" }], {})),
      recorder(),
      { validate: { onFailure: { response: (e) => void seen.push(e) } } },
    );
    const result = await api.get("/pets");
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].issues.map((issue) => issue.target)).toEqual(["headers"]);
  });

  it("header and body issues come in one error, the headers first", async () => {
    const api = client(
      server(() => json([{ id: 1 }], {})),
      recorder(),
      { validate: { onFailure: { response: "throw" } } },
    );
    const error = (await rejection(api.get("/pets"))) as ValidationError;
    expect(error.issues.map((issue) => [issue.target, issue.path])).toEqual([
      ["headers", "x-total-count"],
      ["response", "0.id"],
    ]);
  });

  it("a status without declared headers checks only its body (control: the 200's are checked)", async () => {
    const log = recorder();
    const api = client(
      server(() => json({ code: "NOT_FOUND" }, {}, 404)),
      log,
    );
    expect((await api.get("/pets")).status).toBe(404);
    expect(log.warnings).toEqual([]);
  });

  it("`false` for the status turns its header check off (control: on, it warns)", async () => {
    const log = recorder();
    const api = client(
      server(() => json([{ id: "1" }], {})),
      log,
    );
    await api.get("/pets", { validate: { response: { 200: false } } });
    expect(log.warnings).toEqual([]);
    await api.get("/pets", { validate: { response: false } });
    expect(log.warnings).toEqual([]);
    await api.get("/pets");
    expect(log.warnings).toHaveLength(1);
  });

  it("`replace: true` replaces the body's built-in schema only: the headers are still checked, and a BYO schema sees the body", async () => {
    const log = recorder();
    const api = client(
      server(() => json([{ id: 7 }], {})),
      log,
      { validate: { onFailure: { response: "throw" } } },
    );
    const Custom = z.array(z.object({ id: z.number() }));
    const error = (await rejection(
      api.get("/pets", {
        validate: { response: { 200: { custom: Custom, replace: true } } },
      }),
    )) as ValidationError;
    // The built-in body schema (`id` a string) did not run; the headers' did.
    expect(error.issues).toEqual([
      expect.objectContaining({
        target: "headers",
        path: "x-total-count",
        source: "builtin",
      }) as ValidationErrorIssue,
    ]);
    // Control: with the header, the BYO output is delivered.
    const fine = createClient<Routes>({
      fetch: server(() => json([{ id: 7 }], { "x-total-count": "1" })).fetch,
      baseUrl: "http://api.test",
      schemas: SOURCE,
      mode: "development",
      retry: false,
      validate: { onFailure: { response: "throw" } },
    });
    const result = await fine.get("/pets", {
      throwOnError: true,
      validate: { response: { 200: { custom: Custom, replace: true } } },
    });
    expect(result).toEqual([{ id: 7 }]);
  });

  it("a download left unread has its headers checked alone, and is released when the check throws", async () => {
    let body: ReadableStream<Uint8Array> | undefined;
    const answer = (headers: Record<string, string>) => () => {
      body = new Blob(["bytes"]).stream();
      return new Response(body, {
        headers: { "content-type": "application/octet-stream", ...headers },
      });
    };
    const throwing = client(server(answer({})), recorder(), {
      validate: { onFailure: { response: "throw" } },
    });
    const error = (await rejection(
      throwing.get("/file", { as: "stream" }),
    )) as ValidationError;
    expect(error.issues.map((issue) => issue.path)).toEqual(["x-checksum"]);
    // Released: a cancelled stream can no longer be read.
    expect(body!.locked).toBe(false);
    await expect(body!.getReader().read()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    // Control: with the header, the stream is handed on unread.
    const passing = client(
      server(answer({ "x-checksum": "abc" })),
      recorder(),
      {
        validate: { onFailure: { response: "throw" } },
      },
    );
    const result = await passing.get("/file", {
      as: "stream",
      throwOnError: true,
    });
    expect(await new Response(result).text()).toBe("bytes");
  });

  it("an NDJSON stream has its headers checked once, not per line (control: each line is still checked)", async () => {
    const log = recorder();
    const api = client(
      server(
        () =>
          new Response('{"id":"1"}\n{"id":2}\n{"id":"3"}\n', {
            headers: { "content-type": "application/x-ndjson" },
          }),
      ),
      log,
    );
    const result = await api.get("/export", { throwOnError: true });
    const lines: unknown[] = [];
    for await (const line of result) lines.push(line);
    expect(lines).toEqual([{ id: "1" }, { id: 2 }, { id: "3" }]);
    const headerWarnings = log.warnings.filter((warning) =>
      warning.includes("headers.x-export-id"),
    );
    expect(headerWarnings).toHaveLength(1);
    // The one bad line warned on its own.
    expect(log.warnings.filter((w) => w.includes("response.id"))).toHaveLength(
      1,
    );
  });

  it("production checks no header and loads no schemas (control: a call switched on checks them)", async () => {
    const log = recorder();
    let loads = 0;
    const api = createClient<Routes>({
      baseUrl: "http://api.test",
      fetch: server(() => json([{ id: "1" }], {})).fetch,
      schemas: () => {
        loads++;
        return Promise.resolve(SOURCE);
      },
      mode: "production",
      retry: false,
      logger: log.logger,
    });
    await api.get("/pets");
    expect(loads).toBe(0);
    expect(log.warnings).toEqual([]);
    await api.get("/pets", { validate: { response: true } });
    expect(loads).toBe(1);
    expect(log.warnings).toHaveLength(1);
  });
});
