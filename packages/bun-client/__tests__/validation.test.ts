/**
 * Validation on the client (typed-client plan §5.4–§5.5, §6.2, PR-C4):
 *
 * - a request part failing throws `ValidationError` before anything is sent;
 *   a response failing warns and delivers, by default;
 * - each failure mode (`"throw"`, `"warn"`, a hook) in each direction;
 * - the defaults per mode, and the mode's default from `NODE_ENV`;
 * - precedence across the client, route and call levels, `false` included;
 * - BYO schemas after the built-in ones, issues merged, `replace: true`,
 *   transforms applied;
 * - the issues' shape and their value-free messages; the schema source's
 *   loading and its failures.
 *
 * The server is a `fetch` stub recording what it was sent, so "nothing was
 * sent" is observable. Every check has its control.
 */
import type { SchemaSource, ValidationErrorIssue } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { ClientError, createClient, ValidationError } from "../lib/index";

interface Routes {
  "POST /users/:id": {
    params: { id: string };
    query: { page?: number };
    headers: { "x-tenant": string };
    body: { name: string; age?: number };
    responses: { 200: { id: string; name: string }; 404: { code: string } };
  };
  "GET /health": {
    responses: { 200: { ok: boolean } };
  };
}

const User = z.object({ id: z.string(), name: z.string() });

/** The built-in schemas: what a generated module, or a shared one, exports. */
const SOURCE: SchemaSource<Routes> = {
  schemas: {
    "POST /users/:id": {
      params: z.looseObject({ id: z.string().min(2) }),
      query: z.looseObject({ page: z.optional(z.int().min(1)) }),
      headers: z.looseObject({ "x-tenant": z.string() }),
      body: z.looseObject({
        name: z.string().min(1),
        age: z.optional(z.int()),
      }),
      responses: { 200: User, 404: z.object({ code: z.string() }) },
    },
    "GET /health": { responses: { 200: z.object({ ok: z.boolean() }) } },
  },
};

/** A stub server: answers `answer`'s body and status, and records every request. */
function server(answer: { status?: number; body: unknown }) {
  const sent: Request[] = [];
  return {
    sent,
    fetch: (request: Request) => {
      sent.push(request);
      return Promise.resolve(
        Response.json(answer.body, { status: answer.status ?? 200 }),
      );
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

/** A valid call to `POST /users/:id`. */
const VALID = {
  params: { id: "42" },
  query: { page: 1 },
  body: { name: "Ada" },
} as const;

/** The rejection of `promise`, or a failure when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("the request (§5.5: throws before sending)", () => {
  it("throws ValidationError and sends nothing (control: a valid call is sent)", async () => {
    const stub = server({ body: { id: "42", name: "Ada" } });
    const api = createClient<Routes>({
      baseUrl: "http://api.test",
      fetch: stub.fetch,
      schemas: () => Promise.resolve(SOURCE),
      mode: "development",
      headers: { "x-tenant": "acme" },
      retry: false,
    });
    const error = await rejection(
      api.post("/users/:id", { ...VALID, body: { name: "" } }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(ClientError);
    expect(stub.sent).toHaveLength(0);
    const failure = error as ValidationError;
    expect(failure.direction).toBe("request");
    expect(failure.status).toBeUndefined();
    expect(failure.key).toBe("POST /users/:id");
    expect(failure.issues).toEqual([
      expect.objectContaining({
        target: "body",
        path: "name",
        source: "builtin",
      }) as ValidationErrorIssue,
    ]);

    // Control.
    const ok = await api.post("/users/:id", VALID);
    expect(ok.status).toBe(200);
    expect(stub.sent).toHaveLength(1);
  });

  it("reports every failing part at once: params, query and body, in that order", async () => {
    const stub = server({ body: {} });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
    });
    const error = (await rejection(
      api.post("/users/:id", {
        params: { id: "1" },
        query: { page: 0 },
        body: { name: "" },
      }),
    )) as ValidationError;
    expect(error.issues.map((issue) => [issue.target, issue.path])).toEqual([
      ["params", "id"],
      ["query", "page"],
      ["body", "name"],
    ]);
    expect(stub.sent).toHaveLength(0);
  });

  it("checks the headers as they are sent, every level's (control: the client's header satisfies it)", async () => {
    const stub = server({ body: { id: "42", name: "Ada" } });
    const bare = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
    });
    const error = (await rejection(
      bare.post("/users/:id", VALID),
    )) as ValidationError;
    expect(error.issues).toEqual([
      expect.objectContaining({
        target: "headers",
        path: "x-tenant",
      }) as ValidationErrorIssue,
    ]);
    expect(stub.sent).toHaveLength(0);

    const withHeader = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
      headers: () => ({ "x-tenant": "acme" }),
    });
    expect((await withHeader.post("/users/:id", VALID)).status).toBe(200);
  });

  it('"warn" logs and sends anyway (control: "throw" sends nothing)', async () => {
    const stub = server({ body: { id: "42", name: "Ada" } });
    const log = recorder();
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
      headers: { "x-tenant": "acme" },
      logger: log.logger,
      validate: { onFailure: { request: "warn" } },
    });
    const r = await api.post("/users/:id", { ...VALID, body: { name: "" } });
    expect(r.status).toBe(200);
    expect(stub.sent).toHaveLength(1);
    expect(log.warnings).toEqual([
      expect.stringContaining(
        "POST /users/:id request failed validation: body.name:",
      ) as string,
    ]);
    await rejection(
      api.post("/users/:id", {
        ...VALID,
        body: { name: "" },
        validate: { onFailure: "throw" },
      }),
    );
    expect(stub.sent).toHaveLength(1);
  });

  it("a hook receives the error: returning sends, throwing fails the call", async () => {
    const stub = server({ body: { id: "42", name: "Ada" } });
    const seen: ValidationError[] = [];
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
      headers: { "x-tenant": "acme" },
      validate: {
        onFailure: {
          request: (error) => void seen.push(error),
        },
      },
    });
    await api.post("/users/:id", { ...VALID, body: { name: "" } });
    expect(seen).toHaveLength(1);
    expect(stub.sent).toHaveLength(1);

    const refusal = new Error("refused by the hook");
    const failing = await rejection(
      api.post("/users/:id", {
        ...VALID,
        body: { name: "" },
        validate: {
          onFailure: {
            request: () => {
              throw refusal;
            },
          },
        },
      }),
    );
    expect(failing).toBe(refusal);
    expect(stub.sent).toHaveLength(1);
  });
});

describe("the response (§5.5: warns and delivers)", () => {
  it("warns through the logger and delivers the body as it arrived (control: a valid body warns nothing)", async () => {
    const log = recorder();
    const stub = server({ body: { id: 42, name: "Ada" } });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
      logger: log.logger,
    });
    const r = await api.get("/health", { validate: { request: false } });
    // `{ id, name }` is not `{ ok: boolean }`.
    expect(r.data as unknown).toEqual({ id: 42, name: "Ada" });
    expect(log.warnings).toEqual([
      "GET /health response 200 failed validation: response.ok: Invalid input: expected boolean, received undefined",
    ]);

    const valid = createClient<Routes>({
      fetch: server({ body: { ok: true } }).fetch,
      schemas: SOURCE,
      mode: "development",
      logger: log.logger,
    });
    expect((await valid.get("/health")).data).toEqual({ ok: true });
    expect(log.warnings).toHaveLength(1);
  });

  it('"throw" rejects with the status; a hook is called with the error', async () => {
    const api = createClient<Routes>({
      fetch: server({ status: 404, body: { code: 7 } }).fetch,
      schemas: SOURCE,
      mode: "development",
      retry: false,
      headers: { "x-tenant": "acme" },
      validate: { onFailure: { response: "throw" } },
    });
    const error = (await rejection(
      api.post("/users/:id", VALID),
    )) as ValidationError;
    expect(error).toBeInstanceOf(ValidationError);
    expect({
      direction: error.direction,
      status: error.status,
      issues: error.issues,
    }).toEqual({
      direction: "response",
      status: 404,
      issues: [
        {
          target: "response",
          path: "code",
          key: "404",
          message: "Invalid input: expected string, received number",
          source: "builtin",
        },
      ],
    });

    const seen: ValidationError[] = [];
    const hooked = createClient<Routes>({
      fetch: server({ status: 404, body: { code: 7 } }).fetch,
      schemas: SOURCE,
      mode: "development",
      headers: { "x-tenant": "acme" },
      validate: { onFailure: { response: (e) => void seen.push(e) } },
    });
    const r = await hooked.post("/users/:id", VALID);
    expect(r.error as unknown).toEqual({ code: 7 });
    expect(seen.map((e) => e.status)).toEqual([404]);
  });

  it("checks the body a throwOnError call throws as HttpError", async () => {
    const api = createClient<Routes>({
      fetch: server({ status: 404, body: { code: 7 } }).fetch,
      schemas: SOURCE,
      mode: "development",
      headers: { "x-tenant": "acme" },
      validate: { onFailure: "throw" },
    });
    const error = (await rejection(
      api.post("/users/:id", { ...VALID, throwOnError: true }),
    )) as ValidationError;
    expect(error.status).toBe(404);
  });

  it("strips prototype-pollution keys from what arrived, as the server's receiver does", async () => {
    const api = createClient<Routes>({
      fetch: () =>
        Promise.resolve(
          new Response('{"ok":true,"__proto__":{"polluted":1}}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      schemas: SOURCE,
      mode: "development",
    });
    const r = await api.get("/health");
    expect(Object.hasOwn(r.data as object, "__proto__")).toBe(false);
    // Control: without validation the key arrives (JSON.parse keeps it own).
    const plain = createClient<Routes>({
      fetch: () =>
        Promise.resolve(
          new Response('{"ok":true,"__proto__":{"polluted":1}}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      mode: "production",
    });
    expect(
      Object.hasOwn((await plain.get("/health")).data as object, "__proto__"),
    ).toBe(true);
  });
});

describe("defaults (§5.5)", () => {
  it("production checks nothing and loads no schemas (control: development loads them on first use)", async () => {
    let loads = 0;
    const schemas = () => {
      loads++;
      return Promise.resolve(SOURCE);
    };
    const stub = server({ body: { wrong: true } });
    const log = recorder();
    const production = createClient<Routes>({
      fetch: stub.fetch,
      schemas,
      mode: "production",
      logger: log.logger,
    });
    await production.post("/users/:id", { ...VALID, body: { name: "" } });
    await production.get("/health");
    expect({ loads, sent: stub.sent.length, warnings: log.warnings }).toEqual({
      loads: 0,
      sent: 2,
      warnings: [],
    });

    const development = createClient<Routes>({
      fetch: stub.fetch,
      schemas,
      mode: "development",
      logger: log.logger,
    });
    await development.get("/health");
    await development.get("/health");
    expect(loads).toBe(1);
    expect(log.warnings).toHaveLength(2);
  });

  it("reads the mode from NODE_ENV when none is given", async () => {
    const before = process.env.NODE_ENV;
    try {
      const counts: number[] = [];
      for (const env of ["production", "test", "development"]) {
        process.env.NODE_ENV = env;
        let loads = 0;
        const api = createClient<Routes>({
          fetch: server({ body: { ok: true } }).fetch,
          schemas: () => {
            loads++;
            return Promise.resolve(SOURCE);
          },
        });
        await api.get("/health");
        counts.push(loads);
      }
      expect(counts).toEqual([0, 1, 1]);
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it("with no schema source, development checks nothing and loads no checks", async () => {
    const stub = server({ body: { anything: 1 } });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      mode: "development",
    });
    expect((await api.get("/health")).data as unknown).toEqual({
      anything: 1,
    });
  });
});

describe("precedence (§6.2: client, route, call; later wins)", () => {
  /** A client whose every built-in check fails, recording what it warns. */
  function failing(config: Parameters<typeof createClient<Routes>>[0] = {}) {
    const log = recorder();
    const stub = server({ body: { wrong: true } });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      retry: false,
      logger: log.logger,
      ...config,
    });
    return { api, log, stub };
  }

  it("a route turns on what the client turned off; a call turns it off again", async () => {
    const { api, log } = failing({
      mode: "development",
      validate: { response: false },
      routes: { "GET /health": { validate: { response: true } } },
    });
    await api.get("/health");
    expect(log.warnings).toHaveLength(1);
    await api.get("/health", { validate: { response: false } });
    expect(log.warnings).toHaveLength(1);
    // Control: another route keeps the client's `false`.
    await api.post("/users/:id", { ...VALID, headers: { "x-tenant": "a" } });
    expect(log.warnings).toHaveLength(1);
  });

  it("production with a route switched on checks that route alone", async () => {
    const { api, log } = failing({
      mode: "production",
      routes: { "GET /health": { validate: { response: true } } },
    });
    await api.get("/health");
    expect(log.warnings).toHaveLength(1);
    await api.post("/users/:id", { ...VALID, headers: { "x-tenant": "a" } });
    expect(log.warnings).toHaveLength(1);
  });

  it("`validate: false` at any level turns everything off, BYO included; a later level turns it back on", async () => {
    const custom = z.object({ never: z.literal(true) });
    const { api, log } = failing({
      mode: "development",
      validate: false,
      routes: {
        "GET /health": { validate: { response: { 200: { custom } } } },
      },
    });
    await api.get("/health");
    expect(log.warnings).toHaveLength(1);
    await api.get("/health", { validate: false });
    expect(log.warnings).toHaveLength(1);
  });

  it("per status: an entry for 404 leaves 200 on the switch", async () => {
    const { api, log } = failing({
      mode: "development",
      headers: { "x-tenant": "acme" },
      validate: { response: { 404: false } },
    });
    await api.get("/health");
    expect(log.warnings).toHaveLength(1);
  });

  it("onFailure merges per direction", async () => {
    const { api } = failing({
      mode: "development",
      headers: { "x-tenant": "acme" },
      validate: { onFailure: "throw" },
      routes: {
        "GET /health": { validate: { onFailure: { response: "warn" } } },
      },
    });
    // The route's response "warn" wins for the response...
    expect((await api.get("/health")).status).toBe(200);
    // ...the client's "throw" still holds for the request.
    expect(
      await rejection(
        api.get("/health", {
          validate: { request: true, query: { custom: z.never() } },
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });
});

describe("bring your own (§5.4)", () => {
  it("runs after the built-in schema; both report at once, built-in first", async () => {
    const stub = server({ body: {} });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      headers: { "x-tenant": "acme" },
      routes: {
        "POST /users/:id": {
          validate: {
            body: { custom: z.looseObject({ name: z.string().max(3) }) },
          },
        },
      },
    });
    const error = (await rejection(
      api.post("/users/:id", { ...VALID, body: { name: "", age: 1.5 } }),
    )) as ValidationError;
    expect(error.issues.map((i) => [i.source, i.target, i.path])).toEqual([
      ["builtin", "body", "name"],
      ["builtin", "body", "age"],
    ]);
    const both = (await rejection(
      api.post("/users/:id", { ...VALID, body: { name: "Grace", age: 1.5 } }),
    )) as ValidationError;
    expect(both.issues.map((i) => [i.source, i.path])).toEqual([
      ["builtin", "age"],
      ["custom", "name"],
    ]);
    expect(stub.sent).toHaveLength(0);
  });

  it("replace: true runs only the BYO schema (control: without it the built-in one fails)", async () => {
    const stub = server({ body: {} });
    const lenient = z.looseObject({ name: z.string() });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      schemas: SOURCE,
      mode: "development",
      headers: { "x-tenant": "acme" },
    });
    const call = { ...VALID, body: { name: "" } };
    await api.post("/users/:id", {
      ...call,
      validate: { body: { custom: lenient, replace: true } },
    });
    expect(stub.sent).toHaveLength(1);
    expect(
      await rejection(
        api.post("/users/:id", {
          ...call,
          validate: { body: { custom: lenient } },
        }),
      ),
    ).toBeInstanceOf(ValidationError);
  });

  it("a BYO transform is applied: what it returns is sent, and delivered", async () => {
    const stub = server({ body: { id: "42", name: "Ada" } });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      mode: "production",
      routes: {
        "POST /users/:id": {
          validate: {
            body: {
              custom: z
                .object({ name: z.string() })
                .transform((body) => ({ name: body.name.trim() })),
            },
            response: {
              200: {
                custom: User.transform((user) => ({
                  ...user,
                  name: user.name.toUpperCase(),
                })),
              },
            },
          },
        },
      },
    });
    const r = await api.post("/users/:id", {
      ...VALID,
      body: { name: "  Ada  " },
    });
    expect(await stub.sent[0].json()).toEqual({ name: "Ada" });
    expect(r.ok && r.data).toEqual({ id: "42", name: "ADA" });
  });

  it("a part set to false drops its BYO schema too", async () => {
    const stub = server({ body: {} });
    const api = createClient<Routes>({
      fetch: stub.fetch,
      mode: "production",
      routes: {
        "POST /users/:id": { validate: { body: { custom: z.never() } } },
      },
    });
    expect(await rejection(api.post("/users/:id", VALID))).toBeInstanceOf(
      ValidationError,
    );
    await api.post("/users/:id", { ...VALID, validate: { body: false } });
    expect(stub.sent).toHaveLength(1);
  });

  it("runs an asynchronous Standard Schema", async () => {
    const asyncSchema = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) =>
          Promise.resolve(
            typeof value === "object" && value !== null && "ok" in value
              ? { value }
              : { issues: [{ message: "Needs ok", path: ["ok"] }] },
          ),
      },
    };
    const log = recorder();
    const api = createClient<Routes>({
      fetch: server({ body: { nope: 1 } }).fetch,
      mode: "production",
      logger: log.logger,
      validate: { response: { 200: { custom: asyncSchema } } },
    });
    await api.get("/health");
    expect(log.warnings).toEqual([
      "GET /health response 200 failed validation: response.ok: Needs ok",
    ]);
  });
});

describe("issues and the schema source", () => {
  it("never quotes what was checked (bun-contract's scrub; control: a message quoting nothing is kept)", async () => {
    const secret = "hunter2-very-secret";
    /** A schema whose message quotes the value at its issue's path, as valibot's do. */
    const quoting = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({
          issues: [
            {
              message: `bad name ${JSON.stringify((value as { name: unknown }).name)}`,
              path: ["name"],
            },
          ],
        }),
      },
    };
    const api = createClient<Routes>({
      fetch: server({ body: {} }).fetch,
      mode: "production",
      validate: { body: { custom: quoting } },
    });
    const error = (await rejection(
      api.post("/users/:id", { ...VALID, body: { name: secret } }),
    )) as ValidationError;
    expect(error.message).not.toContain(secret);
    expect(error.issues[0].message).toBe("Invalid value");
    // Control: the same schema's message about a value it does not quote stays.
    const kept = (await rejection(
      api.post("/users/:id", {
        ...VALID,
        body: { name: 7 as unknown as string },
      }),
    )) as ValidationError;
    expect(kept.issues[0].message).toBe("bad name 7");
  });

  it("a source that fails to load rejects the call with ClientError, and is retried by the next", async () => {
    let attempts = 0;
    const api = createClient<Routes>({
      fetch: server({ body: { ok: true } }).fetch,
      mode: "development",
      schemas: () => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error("chunk failed"))
          : Promise.resolve(SOURCE);
      },
    });
    const error = await rejection(api.get("/health"));
    expect(error).toBeInstanceOf(ClientError);
    expect((error as ClientError).message).toContain(
      "the built-in schemas failed to load",
    );
    expect(((error as ClientError).cause as Error).message).toBe(
      "chunk failed",
    );
    expect((await api.get("/health")).status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("a module without a `schemas` export is named as the problem", async () => {
    const api = createClient<Routes>({
      fetch: server({ body: { ok: true } }).fetch,
      mode: "development",
      schemas: () => Promise.resolve({} as SchemaSource<Routes>),
    });
    expect(
      ((await rejection(api.get("/health"))) as ClientError).message,
    ).toContain("has no `schemas` object");
  });
});
