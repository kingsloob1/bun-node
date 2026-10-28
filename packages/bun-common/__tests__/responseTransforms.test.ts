/**
 * `res.addResponseTransform(t, { first })` (bun-cache plan §9.7, PR-H0): a
 * `first` transform goes to the front of the list, so it sees the
 * `Response` as produced — before `compression()` rewrites it — and the
 * response validation gate, which decides before any transform runs, is
 * unaffected. Negative controls: the same registrations without `first` run
 * in registration order, and a capture placed after `compression()` then
 * sees the compressed `Response` with no body.
 */
import type {
  BunResponse,
  BunResponseTransform,
  BunResponseTransformContext,
} from "../lib/index";
import type {
  NextFunction,
  RouterErrorMiddlewareHandler,
} from "../lib/types/general";
import * as zlib from "node:zlib";
import { describe, expect, it } from "bun:test";
import {
  BunRouter,
  compression,
  createTestLogger,
  validate,
} from "../lib/index";
import { z } from "zod";

/** A text body over compression()'s 1 KiB threshold. */
const TEXT = "cache me ".repeat(400);

/** What a capturing transform saw. */
interface Seen {
  /** The `Content-Encoding` of the `Response` it was given. */
  encoding: string | null;
  /** Its status. */
  status: number;
  /** `context.body`, as text when it was a string. */
  body: BunResponseTransformContext["body"];
}

/** A transform that records what it is given and passes it on unchanged. */
function capture(into: Seen[]): BunResponseTransform {
  return {
    transform: (response, { body }) => {
      into.push({
        encoding: response.headers.get("Content-Encoding"),
        status: response.status,
        body,
      });
      return response;
    },
  };
}

/** A transform that appends `name` to `order` and passes the response on. */
function named(name: string, order: string[]): BunResponseTransform {
  return {
    transform: (response) => {
      order.push(name);
      return response;
    },
  };
}

/** A middleware registering `transform`, `{ first }` or not. */
function registering(transform: BunResponseTransform, first?: boolean) {
  return (_req: unknown, res: BunResponse, next: NextFunction) => {
    res.addResponseTransform(
      transform,
      first === undefined ? undefined : { first },
    );
    return next();
  };
}

describe("addResponseTransform: order", () => {
  it("runs in registration order by default (the control)", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    router.get(
      "/",
      registering(named("a", order)),
      registering(named("b", order)),
      (_req, res) => res.send("ok"),
    );
    await router.fetch("/");
    expect(order).toEqual(["a", "b"]);
  });

  it("{ first: true } runs ahead of every transform registered before it", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    router.get(
      "/",
      registering(named("a", order)),
      registering(named("b", order)),
      registering(named("c", order), true),
      (_req, res) => res.send("ok"),
    );
    await router.fetch("/");
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("several first transforms run newest first; { first: false } appends", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    router.get(
      "/",
      registering(named("a", order)),
      registering(named("f1", order), true),
      registering(named("f2", order), true),
      registering(named("z", order), false),
      (_req, res) => res.send("ok"),
    );
    await router.fetch("/");
    expect(order).toEqual(["f2", "f1", "a", "z"]);
  });

  it("first on an empty list is the only transform, and still runs", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    router.get("/", registering(named("only", order), true), (_req, res) =>
      res.send("ok"),
    );
    expect(await (await router.fetch("/")).text()).toBe("ok");
    expect(order).toEqual(["only"]);
  });

  it("a first transform added during a run does not reorder that run", async () => {
    const order: string[] = [];
    const router = new BunRouter();
    let added = false;
    router.get(
      "/",
      (_req, res: BunResponse, next: NextFunction) => {
        res.addResponseTransform({
          transform: (response) => {
            order.push("a");
            // Added while the list is being run: it must neither run in
            // this pass nor shift `a` so that it runs again. Added once, so
            // an in-place `unshift` fails this test instead of looping.
            if (!added) {
              added = true;
              res.addResponseTransform(named("late", order), { first: true });
            }
            return response;
          },
        });
        return next();
      },
      registering(named("b", order)),
      (_req, res) => res.send("ok"),
    );
    await router.fetch("/");
    expect(order).toEqual(["a", "b"]);
  });

  it("returns the response, for chaining", () => {
    const router = new BunRouter();
    let chained: unknown;
    router.get("/", (_req, res) => {
      chained = res.addResponseTransform(named("x", []), { first: true });
      res.send("ok");
    });
    return router.fetch("/").then(() => {
      expect(chained).toBeDefined();
      expect((chained as BunResponse).req.path).toBe("/");
    });
  });
});

describe("addResponseTransform { first } with compression()", () => {
  /** compression() first, then a capture registered `first` or not. */
  function app(first: boolean, seen: Seen[]): BunRouter {
    const router = new BunRouter();
    router.use(compression());
    router.get("/page", registering(capture(seen), first), (_req, res) =>
      res.type("text/plain").send(TEXT),
    );
    return router;
  }

  it("a first capture after compression() sees the uncompressed body; the client gets it compressed", async () => {
    const seen: Seen[] = [];
    const response = await app(true, seen).fetch("/page", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(seen).toEqual([{ encoding: null, status: 200, body: TEXT }]);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(zlib.gunzipSync(bytes).toString()).toBe(TEXT);
  });

  it("without first, the capture sees the compressed Response and no body (the control)", async () => {
    const seen: Seen[] = [];
    const response = await app(false, seen).fetch("/page", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(seen).toEqual([{ encoding: "gzip", status: 200, body: undefined }]);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("an answer sent without next() after compression() is still compressed", async () => {
    // The cache hit's path: compression() registered ahead, the layer
    // answers and stops the pipeline.
    const router = new BunRouter();
    let handlerRan = false;
    router.use(compression());
    router.get(
      "/hit",
      (_req, res: BunResponse) => {
        res.type("text/plain").send(new TextEncoder().encode(TEXT));
      },
      () => {
        handlerRan = true;
      },
    );
    const response = await router.fetch("/hit", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(handlerRan).toBe(false);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(zlib.gunzipSync(bytes).toString()).toBe(TEXT);
  });

  it("a first transform that replaces the Response is what compression() compresses", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get(
      "/swap",
      registering(
        {
          transform: (response) =>
            new Response(TEXT.toUpperCase(), {
              status: response.status,
              headers: { "Content-Type": "text/plain" },
            }),
        },
        true,
      ),
      (_req, res) => res.status(500).type("text/plain").send("broken"),
    );
    const response = await router.fetch("/swap", {
      headers: { "Accept-Encoding": "gzip" },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(zlib.gunzipSync(bytes).toString()).toBe(TEXT.toUpperCase());
  });
});

describe("addResponseTransform { first } with the response validation gate", () => {
  /** A secret the schema strips and a refused answer must not carry. */
  const SECRET = "hunter2-the-password";
  const User = z.object({ id: z.number(), role: z.string().default("user") });

  it('sees the body the gate let through: the parsed output under responseOutput: "parsed" (V13)', async () => {
    const seen: Seen[] = [];
    const router = new BunRouter({ logger: createTestLogger().logger });
    router.get(
      "/user",
      registering(capture(seen), true),
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseOutput: "parsed",
        },
      ),
      (_req, res) => {
        res.json({ id: 1, password: SECRET });
      },
    );
    const response = await router.fetch("/user");
    expect(await response.json()).toEqual({ id: 1, role: "user" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(200);
    const body = seen[0]?.body;
    expect(typeof body).toBe("string");
    expect(JSON.parse(body as string)).toEqual({ id: 1, role: "user" });
  });

  it("never sees a refused response, only the error handler's answer", async () => {
    const seen: Seen[] = [];
    const router = new BunRouter({ logger: createTestLogger().logger });
    router.get(
      "/user",
      registering(capture(seen), true),
      validate(
        {},
        {
          responses: { 200: { content: { "application/json": User } } },
          responseValidation: "error",
        },
      ),
      (_req, res) => {
        // Typed by the declared response, so the bad body needs a cast.
        res.json({ id: "not a number", password: SECRET } as unknown as {
          id: number;
        });
      },
    );
    router.use(((_error, _req, res, _next) => {
      res.status(500).type("text/plain").send("refused");
    }) satisfies RouterErrorMiddlewareHandler);
    const response = await router.fetch("/user");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("refused");
    expect(seen).toEqual([{ encoding: null, status: 500, body: "refused" }]);
  });
});
