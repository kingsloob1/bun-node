import { describe, expect, it } from "bun:test";
import { mergeBunRequestOptions, signCookie } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * `parseQuery` and `parseCookies` take `boolean | options`, as `parseBody`
 * does. The older separate options (`parseQueryOpts`, `cookieParseOptions`,
 * `cookieSecret`) are deprecated but still honoured, and the object forms win
 * over them.
 */

function build(
  url: string,
  options: ConstructorParameters<typeof BunRequest>[2],
  cookie?: string,
): BunRequest {
  return BunRequest.init(
    new Request(url, { headers: cookie ? { cookie } : undefined }),
    testServer,
    options,
  ) as BunRequest;
}

const SIGNED = `sid=s:${signCookie("abc", "new")}; theme=dark`;

/** Standard decoding, plus "dark" read as "DARK": visible, and harmless to signatures. */
const shout = (value: string) =>
  decodeURIComponent(value).replace("dark", "DARK");

describe("parseQuery: boolean | QueryParserOpts", () => {
  it("parses with the defaults for true, nothing for false", () => {
    expect(
      build("http://h/?a[b]=1", { parseBody: false, parseQuery: true }).query,
    ).toEqual({ a: { b: "1" } });
    expect(
      build("http://h/?a=1", { parseBody: false, parseQuery: false }).query,
    ).toEqual({});
  });

  it("an object turns parsing on with its options, merged over the defaults", () => {
    const req = build("http://h/?a[b]=1&r=1&r=2", {
      parseBody: false,
      parseQuery: { nesting: false },
    });
    // nesting off; arrayRepeat still on from the defaults.
    expect(req.query).toEqual({ "a[b]": "1", r: ["1", "2"] });
  });

  it("still honours the deprecated parseQueryOpts, which an object form overrides", () => {
    const legacy = build("http://h/?a[b]=1", {
      parseBody: false,
      parseQuery: true,
      parseQueryOpts: { nesting: false },
    });
    expect(legacy.query).toEqual({ "a[b]": "1" });
    const both = build("http://h/?a[b]=1", {
      parseBody: false,
      parseQuery: { nesting: true },
      parseQueryOpts: { nesting: false },
    });
    expect(both.query).toEqual({ a: { b: "1" } });
  });

  it("treats a value of the wrong type as true", () => {
    const req = build("http://h/?a=1", {
      parseBody: false,
      parseQuery: "yes" as never,
    });
    expect(req.query).toEqual({ a: "1" });
  });
});

describe("parseCookies: boolean | ParseCookiesConfig", () => {
  it("an object's secret verifies signed cookies and becomes req.secret", () => {
    const req = build(
      "http://h/",
      { parseBody: false, parseCookies: { secret: ["new", "old"] } },
      SIGNED,
    );
    expect(req.cookies).toEqual({ theme: "dark" });
    expect(req.signedCookies).toEqual({ sid: "abc" });
    expect(req.secret).toBe("new");
  });

  it("an object's decode replaces the standard decoding", () => {
    const req = build(
      "http://h/",
      { parseBody: false, parseCookies: { decode: (v) => `<${v}>` } },
      "a=x%20y",
    );
    expect(req.cookies).toEqual({ a: "<x%20y>" });
  });

  it("an empty object is the same as true", () => {
    const req = build(
      "http://h/",
      { parseBody: false, parseCookies: {} },
      "a=x%20y",
    );
    expect(req.cookies).toEqual({ a: "x y" });
    expect(req.secret).toBeUndefined();
  });

  it("false parses nothing", () => {
    const req = build(
      "http://h/",
      { parseBody: false, parseCookies: false },
      "a=1",
    );
    expect(req.cookies).toEqual({});
  });

  it("still honours the deprecated cookieSecret and cookieParseOptions", () => {
    const req = build(
      "http://h/",
      {
        parseBody: false,
        parseCookies: true,
        cookieSecret: "new",
        cookieParseOptions: { decode: shout },
      },
      SIGNED,
    );
    expect(req.signedCookies).toEqual({ sid: "abc" });
    expect(req.cookies).toEqual({ theme: "DARK" });
    expect(req.secret).toBe("new");
  });

  it("an object form wins over the deprecated options, field by field", () => {
    const req = build(
      "http://h/",
      {
        parseBody: false,
        parseCookies: { secret: "new" },
        cookieSecret: "wrong",
        cookieParseOptions: { decode: shout },
      },
      SIGNED,
    );
    // secret from the object; decode, which the object leaves out, from the
    // deprecated option.
    expect(req.signedCookies).toEqual({ sid: "abc" });
    expect(req.cookies).toEqual({ theme: "DARK" });
    expect(req.secret).toBe("new");
  });

  it("signs res.cookie(…, { signed: true }) with the object's first secret", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseCookies: { secret: ["new", "old"] } },
    });
    adapter.get("/set", (_req, res) => {
      res.cookie("sid", "abc", { signed: true }).send("ok");
    });
    const header = (await adapter.fetch("/set")).headers.get("set-cookie");
    expect(header).toContain(
      `sid=${encodeURIComponent(`s:${signCookie("abc", "new")}`)}`,
    );
  });
});

describe("mergeBunRequestOptions with the object forms", () => {
  it("merges object parseQuery and parseCookies over object bases", () => {
    const merged = mergeBunRequestOptions(
      { parseQuery: { nesting: false }, parseCookies: { secret: "s" } },
      {
        parseBody: true,
        parseQuery: { arrayRepeat: false },
        parseCookies: { decode: String },
      },
    );
    expect(merged.parseQuery).toEqual({ arrayRepeat: false, nesting: false });
    expect(merged.parseCookies).toEqual({ decode: String, secret: "s" });
  });

  it("lets a boolean on either side replace the other", () => {
    expect(
      mergeBunRequestOptions(
        { parseCookies: false },
        { parseBody: true, parseCookies: { secret: "s" } },
      ).parseCookies,
    ).toBe(false);
    expect(
      mergeBunRequestOptions({ parseQuery: { nesting: false } }).parseQuery,
    ).toEqual({ nesting: false });
  });

  it("is what an adapter's request option goes through", async () => {
    const adapter = new BunHttpAdapter(0, {
      request: { parseQuery: { nesting: false } },
    });
    adapter.get("/q", (req, res) => res.json(req.query));
    expect(await (await adapter.fetch("/q?a[b]=1")).json()).toEqual({
      "a[b]": "1",
    });
  });
});
