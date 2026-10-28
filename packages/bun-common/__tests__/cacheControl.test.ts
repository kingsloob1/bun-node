/**
 * `formatCacheControl()` and `cacheControl()` (bun-cache plan §9.7, PR-H0):
 * RFC 9111 §5.2.2 response directives, RFC 5861's stale windows and
 * RFC 8246's `immutable`, in seconds; contradictions and malformed values
 * refused at run time as the types refuse them at compile time
 * (`cacheControl.type-test.ts`).
 */
import type { CacheControlDirectives } from "../lib/index";
import * as zlib from "node:zlib";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunRouter,
  cacheControl,
  compression,
  formatCacheControl,
} from "../lib/index";
import { makeResponse } from "./helpers";

/** A text body over compression()'s 1 KiB threshold. */
const TEXT = "fresh ".repeat(400);

/** Formats a value the types would refuse, to check the run-time guard. */
function formatUnchecked(directives: Record<string, unknown>): string {
  // A `Record<string, unknown>` is accepted as is: every directive is
  // optional, and `unknown` reaches none of them through the index.
  return formatCacheControl(directives);
}

describe("formatCacheControl: each directive", () => {
  it.each([
    [{ public: true }, "public"],
    [{ private: true }, "private"],
    [{ noCache: true }, "no-cache"],
    [{ noStore: true }, "no-store"],
    [{ maxAge: 60 }, "max-age=60"],
    [{ sMaxAge: 300 }, "s-maxage=300"],
    [{ staleWhileRevalidate: 30 }, "stale-while-revalidate=30"],
    [{ staleIfError: 600 }, "stale-if-error=600"],
    [{ mustRevalidate: true }, "must-revalidate"],
    [{ proxyRevalidate: true }, "proxy-revalidate"],
    [{ mustUnderstand: true }, "must-understand"],
    [{ noTransform: true }, "no-transform"],
    [{ immutable: true }, "immutable"],
  ] as [CacheControlDirectives, string][])("%o → %s", (directives, header) => {
    expect(formatCacheControl(directives)).toBe(header);
  });

  it("writes every directive at once, in a fixed order, whatever the key order", () => {
    expect(
      formatCacheControl({
        immutable: true,
        noTransform: true,
        mustUnderstand: true,
        proxyRevalidate: true,
        mustRevalidate: true,
        staleIfError: 4,
        staleWhileRevalidate: 3,
        sMaxAge: 2,
        maxAge: 1,
        noCache: true,
        public: true,
      }),
    ).toBe(
      "public, no-cache, max-age=1, s-maxage=2, stale-while-revalidate=3, " +
        "stale-if-error=4, must-revalidate, proxy-revalidate, must-understand, " +
        "no-transform, immutable",
    );
  });

  it("the plan's three examples", () => {
    expect(
      formatCacheControl({ public: true, maxAge: 31_536_000, immutable: true }),
    ).toBe("public, max-age=31536000, immutable");
    expect(
      formatCacheControl({
        sMaxAge: 60,
        staleWhileRevalidate: 30,
        staleIfError: 600,
      }),
    ).toBe("s-maxage=60, stale-while-revalidate=30, stale-if-error=600");
    expect(formatCacheControl({ private: true, noStore: true })).toBe(
      "private, no-store",
    );
  });

  it("must-understand with no-store, as RFC 9111 §5.2.2.3 recommends", () => {
    expect(formatCacheControl({ noStore: true, mustUnderstand: true })).toBe(
      "no-store, must-understand",
    );
  });

  it("leaves out false and undefined directives; nothing set is an empty string", () => {
    expect(
      formatCacheControl({
        public: false,
        private: undefined,
        noStore: false,
        maxAge: undefined,
        immutable: false,
      }),
    ).toBe("");
    expect(formatCacheControl({})).toBe("");
    expect(formatCacheControl({ public: false, private: true })).toBe(
      "private",
    );
    expect(formatCacheControl({ noStore: false, maxAge: 5 })).toBe("max-age=5");
  });

  it("max-age=0 is written, not dropped", () => {
    expect(formatCacheControl({ maxAge: 0, mustRevalidate: true })).toBe(
      "max-age=0, must-revalidate",
    );
  });
});

describe("formatCacheControl: the qualified forms (RFC 9111 §5.2.2.4, §5.2.2.7)", () => {
  it("writes field names as one quoted string, even a single one", () => {
    expect(formatCacheControl({ private: ["Set-Cookie"] })).toBe(
      'private="Set-Cookie"',
    );
    expect(formatCacheControl({ noCache: ["Set-Cookie", "X-Session"] })).toBe(
      'no-cache="Set-Cookie, X-Session"',
    );
    expect(
      formatCacheControl({
        private: ["Authorization"],
        noCache: ["Set-Cookie"],
      }),
    ).toBe('private="Authorization", no-cache="Set-Cookie"');
  });

  it("refuses an empty list (true is the unqualified form)", () => {
    expect(() => formatCacheControl({ noCache: [] })).toThrow(TypeError);
    expect(() => formatCacheControl({ private: [] })).toThrow(
      /at least one field name/,
    );
  });

  it.each([
    ["a quote", 'Set-"Cookie'],
    ["a comma", "Set-Cookie, X"],
    ["a space", "Set Cookie"],
    ["an empty name", ""],
  ])("refuses a field name with %s", (_label, field) => {
    expect(() => formatCacheControl({ noCache: [field] })).toThrow(TypeError);
  });

  it("refuses a field name that is not a string", () => {
    expect(() => formatUnchecked({ private: [42] })).toThrow(TypeError);
  });
});

describe("formatCacheControl: delta-seconds (RFC 9111 §1.2.2)", () => {
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe", 2 ** 53],
  ])("refuses a %s lifetime with a RangeError", (_label, value) => {
    for (const key of [
      "maxAge",
      "sMaxAge",
      "staleWhileRevalidate",
      "staleIfError",
    ]) {
      expect(() => formatUnchecked({ [key]: value })).toThrow(RangeError);
    }
  });

  it("refuses a lifetime that is not a number", () => {
    expect(() => formatUnchecked({ maxAge: "60" })).toThrow(RangeError);
  });

  it("writes the token form, never a quoted number (§5.2.2.1)", () => {
    expect(formatCacheControl({ maxAge: 5 })).not.toContain('"');
  });
});

describe("formatCacheControl: contradictions and mistakes", () => {
  it("refuses public with private, in either form", () => {
    expect(() => formatUnchecked({ public: true, private: true })).toThrow(
      /both public and private/,
    );
    expect(() =>
      formatUnchecked({ public: true, private: ["Set-Cookie"] }),
    ).toThrow(TypeError);
  });

  it.each([
    ["maxAge", 60],
    ["sMaxAge", 60],
    ["staleWhileRevalidate", 30],
    ["staleIfError", 600],
    ["immutable", true],
  ])("refuses noStore with %s", (key, value) => {
    expect(() => formatUnchecked({ noStore: true, [key]: value })).toThrow(
      new RegExp(`noStore.*${key}`),
    );
  });

  it("refuses noStore with max-age=0 too", () => {
    // max-age=0 is still a lifetime: the types refuse it, so the run-time
    // check does too, rather than special-casing a zero.
    expect(() => formatUnchecked({ noStore: true, maxAge: 0 })).toThrow(
      TypeError,
    );
  });

  it("refuses an unknown key (a typo)", () => {
    expect(() => formatUnchecked({ max_age: 60 })).toThrow(
      /Unknown Cache-Control directive key: max_age/,
    );
    expect(() => formatUnchecked({ maxage: 60 })).toThrow(TypeError);
  });

  it("refuses a flag that is not a boolean", () => {
    expect(() => formatUnchecked({ public: "yes" })).toThrow(TypeError);
    expect(() => formatUnchecked({ noStore: 1 })).toThrow(TypeError);
    expect(() => formatUnchecked({ immutable: ["x"] })).toThrow(TypeError);
  });
});

describe("cacheControl(): the middleware", () => {
  it("sets Cache-Control and goes on to the handler", async () => {
    const router = new BunRouter();
    router.get(
      "/feed",
      cacheControl({
        sMaxAge: 60,
        staleWhileRevalidate: 30,
        staleIfError: 600,
      }),
      (_req, res) => res.send("feed"),
    );
    const response = await router.fetch("/feed");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("feed");
    expect(response.headers.get("Cache-Control")).toBe(
      "s-maxage=60, stale-while-revalidate=30, stale-if-error=600",
    );
    expect(response.headers.has("Surrogate-Control")).toBe(false);
  });

  it("sets Surrogate-Control too when asked", async () => {
    const router = new BunRouter();
    router.get(
      "/page",
      cacheControl(
        { maxAge: 0, mustRevalidate: true },
        { surrogateControl: { maxAge: 3600, staleIfError: 86_400 } },
      ),
      (_req, res) => res.send("page"),
    );
    const response = await router.fetch("/page");
    expect(response.headers.get("Cache-Control")).toBe(
      "max-age=0, must-revalidate",
    );
    expect(response.headers.get("Surrogate-Control")).toBe(
      "max-age=3600, stale-if-error=86400",
    );
  });

  it("replaces a Cache-Control set earlier; a handler can still change it", async () => {
    const router = new BunRouter();
    router.use((_req, res, next) => {
      res.set("Cache-Control", "no-cache");
      return next();
    });
    router.get("/a", cacheControl({ maxAge: 10 }), (_req, res) =>
      res.send("a"),
    );
    router.get("/b", cacheControl({ maxAge: 10 }), (_req, res) => {
      res.set("Cache-Control", "private, no-store");
      res.send("b");
    });
    expect((await router.fetch("/a")).headers.get("Cache-Control")).toBe(
      "max-age=10",
    );
    expect((await router.fetch("/b")).headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
  });

  it("leaves a response already sent alone, and still calls next()", async () => {
    const res = await makeResponse();
    res.set("Cache-Control", "no-store").send("early");
    expect(res.headersSent).toBe(true);
    let nexted = 0;
    cacheControl({ public: true, maxAge: 60 })(res.req, res, () => {
      nexted += 1;
    });
    expect(nexted).toBe(1);
    expect(res.getHeader("Cache-Control")).toBe("no-store");
  });

  it("formats once, when built: a bad directive throws there, not per request", () => {
    expect(() => cacheControl({ maxAge: -1 })).toThrow(RangeError);
    expect(() =>
      cacheControl({ maxAge: 1 }, {
        surrogateControl: { public: true, private: true },
      } as never),
    ).toThrow(TypeError);
  });

  it("refuses no directives at all", () => {
    expect(() => cacheControl({})).toThrow(/at least one directive/);
    expect(() => cacheControl({ public: false })).toThrow(TypeError);
    expect(() => cacheControl({ maxAge: 1 }, { surrogateControl: {} })).toThrow(
      /surrogateControl needs at least one directive/,
    );
  });

  it("applies under router.use() to every route below it, and to HEAD", async () => {
    const router = new BunRouter();
    router.use(
      "/assets",
      cacheControl({ public: true, maxAge: 31_536_000, immutable: true }),
    );
    router.get("/assets/app.js", (_req, res) =>
      res.type("text/javascript").send("1"),
    );
    const get = await router.fetch("/assets/app.js");
    const head = await router.fetch("/assets/app.js", { method: "HEAD" });
    for (const response of [get, head]) {
      expect(response.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
    }
  });

  it("noTransform keeps compression() off the body", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/plain", cacheControl({ maxAge: 60 }), (_req, res) =>
      res.type("text/plain").send(TEXT),
    );
    router.get(
      "/raw",
      cacheControl({ maxAge: 60, noTransform: true }),
      (_req, res) => res.type("text/plain").send(TEXT),
    );
    const init = { headers: { "Accept-Encoding": "gzip" } };
    const plain = await router.fetch("/plain", init);
    expect(plain.headers.get("Content-Encoding")).toBe("gzip");
    expect(
      zlib.gunzipSync(new Uint8Array(await plain.arrayBuffer())).toString(),
    ).toBe(TEXT);
    const raw = await router.fetch("/raw", init);
    expect(raw.headers.get("Content-Encoding")).toBeNull();
    expect(raw.headers.get("Cache-Control")).toBe("max-age=60, no-transform");
    expect(await raw.text()).toBe(TEXT);
  });

  it("works on the adapter, served over a socket", async () => {
    const adapter = new BunHttpAdapter();
    adapter.get(
      "/me",
      cacheControl({ private: true, noStore: true }),
      (_req, res) => res.json({ me: true }),
    );
    await adapter.listen(0);
    try {
      const response = await fetch(
        `http://${adapter.listeningHost}:${adapter.listeningPort}/me`,
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ me: true });
    } finally {
      await adapter.close();
    }
  });
});
