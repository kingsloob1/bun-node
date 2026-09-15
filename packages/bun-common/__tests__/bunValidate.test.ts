import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { afterAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { BunValidate, validate, ValidationError } from "../lib/BunValidate";

/**
 * A minimal Standard Schema, hand-rolled.
 *
 * Standard Schema is a specification rather than a library, so conformance is
 * just this shape — which is exactly why `BunValidate` needs no dependency on
 * Zod, Valibot or ArkType. Building one here proves the integration against
 * the spec itself instead of against one vendor's quirks.
 */
function schema<Output>(
  parse: (
    value: unknown,
  ) => { value: Output } | { issues: { message: string; path?: string[] }[] },
  vendor = "test",
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor,
      validate: (value) => {
        const result = parse(value);
        return "issues" in result
          ? {
              issues: result.issues.map((i) => ({
                message: i.message,
                path: i.path,
              })),
            }
          : { value: result.value };
      },
    },
  };
}

/** Coerces `page` to a number, rejecting anything non-numeric. */
const PageQuery = schema<{ page: number }>((value) => {
  const raw = (value as Record<string, unknown>)?.page;
  const page = Number(raw);
  if (raw === undefined || Number.isNaN(page)) {
    return { issues: [{ message: "page must be numeric", path: ["page"] }] };
  }
  return { value: { page } };
});

const TitleBody = schema<{ title: string }>((value) => {
  const title = (value as Record<string, unknown>)?.title;
  if (typeof title !== "string" || title.length === 0) {
    return { issues: [{ message: "title is required", path: ["title"] }] };
  }
  return { value: { title } };
});

const NumericIdParams = schema<{ id: number }>((value) => {
  const raw = (value as Record<string, unknown>)?.id;
  const id = Number(raw);
  if (Number.isNaN(id)) {
    return { issues: [{ message: "id must be numeric", path: ["id"] }] };
  }
  return { value: { id } };
});

const started: BunHttpAdapter[] = [];

/** Boots an adapter, registers `build`, and returns its base URL. */
async function serve(
  build: (adapter: BunHttpAdapter) => void,
): Promise<string> {
  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: true, parseCookies: false, parseQuery: true },
  });
  build(adapter);
  await adapter.listen(0);
  started.push(adapter);
  return `http://127.0.0.1:${adapter.listeningPort}`;
}

afterAll(async () => {
  for (const adapter of started) {
    await adapter.close();
  }
});

describe("BunValidate: successful validation", () => {
  it("replaces query with the parsed value", async () => {
    const base = await serve((adapter) => {
      adapter.get("/posts", validate({ query: PageQuery }), (req, res) => {
        res.json({ page: req.query.page, type: typeof req.query.page });
      });
    });

    const response = await fetch(`${base}/posts?page=3`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ page: 3, type: "number" });
  });

  it("replaces body with the parsed value", async () => {
    const base = await serve((adapter) => {
      adapter.post("/posts", validate({ body: TitleBody }), (req, res) => {
        res.json({ body: req.body });
      });
    });

    const response = await fetch(`${base}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello", extra: "dropped-by-schema" }),
    });
    expect(await response.json()).toEqual({ body: { title: "hello" } });
  });

  it("coerces params, so later handlers see the parsed shape", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/u/:id",
        validate({ params: NumericIdParams }),
        (req, res) => {
          res.json({ id: req.params.id, type: typeof req.params.id });
        },
      );
    });

    expect(await (await fetch(`${base}/u/42`)).json()).toEqual({
      id: 42,
      type: "number",
    });
  });

  it("validates headers without replacing them", async () => {
    const HeaderSchema = schema<{ ok: true }>((value) => {
      const headers = value as Record<string, unknown>;
      return headers["x-token"] === "secret"
        ? { value: { ok: true } }
        : { issues: [{ message: "x-token missing", path: ["x-token"] }] };
    });

    const base = await serve((adapter) => {
      adapter.get("/h", validate({ headers: HeaderSchema }), (req, res) => {
        // Still the live header view, not the parsed object.
        res.json({ token: req.getHeader("x-token") });
      });
    });

    const ok = await fetch(`${base}/h`, { headers: { "x-token": "secret" } });
    expect(await ok.json()).toEqual({ token: "secret" });
  });

  it("leaves the raw value in place when replace is false", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/raw",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          replace: false,
        }),
        (req, res) => res.json({ type: typeof req.query.page }),
      );
    });

    expect(await (await fetch(`${base}/raw?page=3`)).json()).toEqual({
      type: "string",
    });
  });
});

describe("BunValidate: hooks", () => {
  it("normalizes before validating", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/n",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          hooks: {
            query: {
              // The client sends `page=" 3 "`; the schema only accepts numerics.
              normalize: (value) => ({
                ...value,
                page: String(value.page).trim(),
              }),
            },
          },
        }),
        (req, res) => res.json({ page: req.query.page }),
      );
    });

    expect(await (await fetch(`${base}/n?page=%20%203%20`)).json()).toEqual({
      page: 3,
    });
  });

  it("transforms after validating", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/t",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          hooks: {
            query: {
              transform: (value) => ({
                ...value,
                offset: value.page * 10,
              }),
            },
          },
        }),
        (req, res) => res.json(req.query as Record<string, unknown>),
      );
    });

    expect(await (await fetch(`${base}/t?page=2`)).json()).toEqual({
      page: 2,
      offset: 20,
    });
  });
});

describe("BunValidate: failure handling", () => {
  it("passes a ValidationError to the error pipeline by default", async () => {
    const base = await serve((adapter) => {
      adapter.get("/f", validate({ query: PageQuery }), (_req, res) => {
        res.send("unreachable");
      });
      adapter.use(((error, _req, res, _next) => {
        const validation = error as ValidationError;
        res.status(422).json({
          name: validation.name,
          status: validation.status,
          targets: validation.targets,
          issues: validation.issues,
        });
      }) satisfies RouterErrorMiddlewareHandler);
    });

    const response = await fetch(`${base}/f?page=abc`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      name: "ValidationError",
      status: 400,
      targets: ["query"],
      issues: [
        { target: "query", message: "page must be numeric", path: "page" },
      ],
    });
  });

  it("responds directly when onFailure is respond", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/r",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          onFailure: "respond",
          status: 422,
        }),
        (_req, res) => res.send("unreachable"),
      );
    });

    const response = await fetch(`${base}/r?page=abc`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Validation failed",
      issues: [
        { target: "query", message: "page must be numeric", path: "page" },
      ],
    });
  });

  it("uses formatError for the respond body", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/fmt",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          onFailure: "respond",
          formatError: (error) => ({ count: error.issues.length }),
        }),
        (_req, res) => res.send("unreachable"),
      );
    });

    expect(await (await fetch(`${base}/fmt?page=abc`)).json()).toEqual({
      count: 1,
    });
  });

  it("sends a formatError answer that is not an object as it is", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/list",
        validate(
          { query: PageQuery },
          {
            onFailure: "respond",
            formatError: (error) => error.issues.map((issue) => issue.message),
          },
        ),
        (_req, res) => res.send("unreachable"),
      );
      adapter.get(
        "/text",
        validate(
          { query: PageQuery },
          { onFailure: "respond", status: 422, formatError: () => "invalid" },
        ),
        (_req, res) => res.send("unreachable"),
      );
      adapter.get(
        "/null",
        validate(
          { query: PageQuery },
          { onFailure: "respond", formatError: () => null },
        ),
        (_req, res) => res.send("unreachable"),
      );
    });

    const list = await fetch(`${base}/list?page=abc`);
    expect(list.status).toBe(400);
    expect(list.headers.get("content-type")).toContain("application/json");
    expect(await list.json()).toEqual(["page must be numeric"]);

    const text = await fetch(`${base}/text?page=abc`);
    expect(text.status).toBe(422);
    expect(text.headers.get("content-type")).toContain("application/json");
    expect(await text.text()).toBe('"invalid"');

    const nothing = await fetch(`${base}/null?page=abc`);
    expect(nothing.headers.get("content-type")).toContain("application/json");
    expect(await nothing.text()).toBe("null");
  });

  it("throws for the adapter's error handler when onFailure is throw", async () => {
    const base = await serve((adapter) => {
      adapter.get(
        "/th",
        BunValidate.middleware({
          schemas: { query: PageQuery },
          onFailure: "throw",
        }),
        (_req, res) => res.send("unreachable"),
      );
      adapter.setErrorHandler((error, _req, res, _next) => {
        res.status(500).json({ thrown: (error as Error).name });
      });
    });

    const response = await fetch(`${base}/th?page=abc`);
    expect(await response.json()).toEqual({ thrown: "ValidationError" });
  });

  it("collects issues from every target by default", async () => {
    const base = await serve((adapter) => {
      adapter.post(
        "/multi",
        BunValidate.middleware({
          schemas: { query: PageQuery, body: TitleBody },
          onFailure: "respond",
        }),
        (_req, res) => res.send("unreachable"),
      );
    });

    const response = await fetch(`${base}/multi?page=abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as { issues: { target: string }[] };
    expect(payload.issues.map((i) => i.target).sort()).toEqual([
      "body",
      "query",
    ]);
  });

  it("stops at the first failing target when abortEarly is set", async () => {
    const base = await serve((adapter) => {
      adapter.post(
        "/early",
        BunValidate.middleware({
          schemas: { query: PageQuery, body: TitleBody },
          onFailure: "respond",
          abortEarly: true,
        }),
        (_req, res) => res.send("unreachable"),
      );
    });

    const response = await fetch(`${base}/early?page=abc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as {
      issues: { target: string; message: string; path: string }[];
    };
    // `query` is validated before `body`, so only its issue is reported.
    expect(payload.issues).toEqual([
      { target: "query", message: "page must be numeric", path: "page" },
    ]);
  });
});

describe("BunValidate: async schemas", () => {
  it("awaits a schema that validates asynchronously", async () => {
    const AsyncSchema: StandardSchemaV1<unknown, { page: number }> = {
      "~standard": {
        version: 1,
        vendor: "test-async",
        validate: async (value) => {
          await Bun.sleep(1);
          const page = Number((value as Record<string, unknown>)?.page);
          return Number.isNaN(page)
            ? { issues: [{ message: "async reject" }] }
            : { value: { page } };
        },
      },
    };

    const base = await serve((adapter) => {
      adapter.get("/a", validate({ query: AsyncSchema }), (req, res) => {
        res.json({ page: req.query.page });
      });
    });

    expect(await (await fetch(`${base}/a?page=7`)).json()).toEqual({ page: 7 });
  });
});

describe("ValidationError", () => {
  it("summarises its issues in the message", () => {
    const error = new ValidationError(
      [
        { target: "query", message: "page must be numeric", path: "page" },
        { target: "body", message: "title is required", path: "title" },
      ],
      400,
    );

    expect(error.message).toContain("query.page: page must be numeric");
    expect(error.message).toContain("body.title: title is required");
    expect(error.targets).toEqual(["query", "body"]);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("BunValidate: mounted sub-routers", () => {
  it("merges the mount's params with the sub-route's own", async () => {
    const sub = new BunRouter<"/users/:id">();
    sub.get("/posts/:postId", (req, res) => {
      res.json({ params: req.params });
    });

    const base = await serve((adapter) => {
      adapter.use("/users/:id", sub);
    });

    expect(await (await fetch(`${base}/users/42/posts/99`)).json()).toEqual({
      params: { id: "42", postId: "99" },
    });
  });

  it("carries a mount validator's query and body into the sub-router", async () => {
    const sub = new BunRouter<"/orgs/:org", { query: { page: number } }>();
    sub.get("/members", (req, res) => {
      res.json({ page: req.query.page, type: typeof req.query.page });
    });

    const base = await serve((adapter) => {
      adapter.use("/orgs/:org", validate({ query: PageQuery }), sub);
    });

    expect(
      await (await fetch(`${base}/orgs/acme/members?page=3`)).json(),
    ).toEqual({ page: 3, type: "number" });
  });

  it("does NOT carry a mount validator's params into the sub-router", async () => {
    // Two independent reasons, which is why the types drop the mount's
    // `params` entirely:
    //   1. `use()` middleware is not a route handler, so the pipeline never
    //      binds params for it — a mount validator sees `{}`, not `{ id }`.
    //   2. Params are rebound on entering each matched route, so even a
    //      replacement made there would be overwritten before the sub-route.
    const seenAtMount: unknown[] = [];
    const Observing = schema<Record<string, string>>((value) => {
      seenAtMount.push({ ...(value as Record<string, string>) });
      return { value: { id: "replaced-at-mount" } };
    });

    const sub = new BunRouter<"/users/:id">();
    sub.get("/posts", (req, res) => {
      res.json({ id: req.params.id, type: typeof req.params.id });
    });

    const base = await serve((adapter) => {
      adapter.use("/users/:id", validate({ params: Observing }), sub);
    });

    // The sub-route sees the path's own params, not the mount's replacement.
    expect(await (await fetch(`${base}/users/42/posts`)).json()).toEqual({
      id: "42",
      type: "string",
    });
    // And the mount validator never saw the mount params in the first place.
    expect(seenAtMount).toEqual([{}]);
  });

  it("chains validators: a sub-route's sees the mount's output, not the raw query", async () => {
    // Each validator replaces `req.query` wholesale, so a sub-route validator
    // is handed what the mount produced. A sub-route schema therefore has to
    // be written against the mount's output shape, not the raw query string.
    const Doubling = schema<{ page: number; doubled: number }>((value) => {
      const page = Number((value as Record<string, unknown>).page);
      return { value: { page, doubled: page * 2 } };
    });

    const sub = new BunRouter<"/a/:x", { query: { page: number } }>();
    sub.get("/b", validate({ query: Doubling }), (req, res) => {
      res.json({ query: req.query });
    });

    const base = await serve((adapter) => {
      adapter.use("/a/:x", validate({ query: PageQuery }), sub);
    });

    // `cursor` is gone: the mount validator dropped it before the sub-route ran.
    expect(
      await (await fetch(`${base}/a/1/b?cursor=abc&page=9`)).json(),
    ).toEqual({ query: { page: 9, doubled: 18 } });
  });
});
