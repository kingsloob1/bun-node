import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import {
  appendVary,
  cloneDeep,
  createDeferred,
  each,
  encodeUrl,
  etag,
  extractSignedCookies,
  first,
  flattenDeep,
  fresh,
  get,
  getPort,
  isArray,
  isBoolean,
  isBuffer,
  isDateValid,
  isError,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  jsonCookies,
  keys,
  lastIndexOf,
  merge,
  omit,
  orderBy,
  parseCookie,
  parseXmlToObject,
  pick,
  rangeParser,
  serializeCookie,
  set,
  signCookie,
  toHttpDate,
  ucwords,
  unsignCookie,
  values,
  waitUntil,
} from "../lib/utils/native";

describe("native: type guards", () => {
  it("isArray", () => {
    expect(isArray([])).toBe(true);
    expect(isArray({})).toBe(false);
  });

  it("isString", () => {
    expect(isString("a")).toBe(true);
    expect(isString(1)).toBe(false);
  });

  it("isNumber treats NaN as a number (lodash parity)", () => {
    expect(isNumber(1)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(true);
    expect(isNumber("1")).toBe(false);
  });

  it("isBoolean", () => {
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(0)).toBe(false);
  });

  it("isFunction", () => {
    expect(isFunction(() => {})).toBe(true);
    expect(isFunction({})).toBe(false);
  });

  it("isUndefined / isNull", () => {
    expect(isUndefined(undefined)).toBe(true);
    expect(isUndefined(null)).toBe(false);
    expect(isNull(null)).toBe(true);
    expect(isNull(undefined)).toBe(false);
  });

  it("isObject treats arrays and functions as objects, not null", () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(true);
    expect(isObject(() => {})).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject("x")).toBe(false);
  });

  it("isError", () => {
    expect(isError(new Error("x"))).toBe(true);
    expect(isError(new TypeError("x"))).toBe(true);
    expect(isError({})).toBe(false);
  });

  it("isBuffer / isMap", () => {
    expect(isBuffer(Buffer.from("x"))).toBe(true);
    expect(isBuffer("x")).toBe(false);
    expect(isMap(new Map())).toBe(true);
    expect(isMap({})).toBe(false);
  });
});

describe("native: isNumeric", () => {
  it("accepts finite numbers and numeric strings", () => {
    expect(isNumeric(42)).toBe(true);
    expect(isNumeric("42")).toBe(true);
    expect(isNumeric("3.14")).toBe(true);
    expect(isNumeric("-7")).toBe(true);
  });

  it("rejects non-numeric values", () => {
    expect(isNumeric("")).toBe(false);
    expect(isNumeric("   ")).toBe(false);
    expect(isNumeric("abc")).toBe(false);
    expect(isNumeric(Number.NaN)).toBe(false);
    expect(isNumeric(Infinity)).toBe(false);
    expect(isNumeric(null)).toBe(false);
    expect(isNumeric(undefined)).toBe(false);
  });
});

describe("native: collection helpers", () => {
  it("keys / values / first", () => {
    expect(keys({ a: 1, b: 2 })).toEqual(["a", "b"]);
    expect(keys(null)).toEqual([]);
    expect(values({ a: 1, b: 2 })).toEqual([1, 2]);
    expect(first([3, 4])).toBe(3);
    expect(first([])).toBeUndefined();
  });

  it("flattenDeep", () => {
    expect(flattenDeep([1, [2, [3, [4]]]])).toEqual([1, 2, 3, 4]);
  });

  it("each iterates arrays and objects", () => {
    const arr: number[] = [];
    each([10, 20], (v) => arr.push(v));
    expect(arr).toEqual([10, 20]);

    const seen: string[] = [];
    each({ a: 1, b: 2 }, (v, k) => seen.push(`${k}:${v}`));
    expect(seen).toEqual(["a:1", "b:2"]);
  });

  it("omit / pick", () => {
    expect(omit({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
    expect(pick({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("cloneDeep returns an independent copy", () => {
    const original = { nested: { value: 1 }, list: [1, 2] };
    const copy = cloneDeep(original);
    copy.nested.value = 99;
    expect(original.nested.value).toBe(1);
  });

  it("lastIndexOf", () => {
    expect(lastIndexOf([1, 2, 1, 3], 1)).toBe(2);
    expect(lastIndexOf("ababa", "a")).toBe(4);
  });
});

describe("native: get / set", () => {
  it("get resolves dotted and bracket paths", () => {
    const obj = { a: { b: [{ c: 5 }] } };
    expect(get<number>(obj, "a.b[0].c")).toBe(5);
    expect(get<number>(obj, ["a", "b", 0, "c"])).toBe(5);
    expect(get(obj, "a.missing.deep", "fallback")).toBe("fallback");
    expect(get(undefined, "a.b", "d")).toBe("d");
  });

  it("set creates intermediate containers", () => {
    const obj: Record<string, unknown> = {};
    set(obj, "a.b.c", 7);
    expect(obj).toEqual({ a: { b: { c: 7 } } });

    const withArray: Record<string, unknown> = {};
    set(withArray, ["list", 0, "name"], "x");
    expect((withArray.list as { name: string }[])[0].name).toBe("x");
  });
});

describe("native: merge", () => {
  it("deep merges plain objects", () => {
    expect(
      merge({ a: { x: 1 } }, { a: { y: 2 } }, { b: 3 }) as Record<
        string,
        unknown
      >,
    ).toEqual({
      a: { x: 1, y: 2 },
      b: 3,
    });
  });

  it("merges arrays element-wise", () => {
    expect(merge({ list: [1, 2] }, { list: [undefined, 9, 3] })).toEqual({
      list: [1, 9, 3],
    });
  });

  it("assigns non-plain objects (Date) by reference", () => {
    const date = new Date(0);
    const result = merge<{ when?: Date }>({}, { when: date });
    expect(result.when).toBe(date);
  });
});

describe("native: orderBy", () => {
  it("sorts by multiple iteratees and directions", () => {
    const data = [
      { group: 2, score: 1 },
      { group: 1, score: 5 },
      { group: 1, score: 9 },
    ];
    const sorted = orderBy(
      data,
      [(item) => item.group, (item) => item.score],
      ["asc", "desc"],
    );
    expect(sorted).toEqual([
      { group: 1, score: 9 },
      { group: 1, score: 5 },
      { group: 2, score: 1 },
    ]);
  });
});

describe("native: ucwords / encodeUrl", () => {
  it("ucwords capitalises word boundaries", () => {
    expect(ucwords("content-type")).toBe("Content-Type");
    expect(ucwords("hello world")).toBe("Hello World");
  });

  it("encodeUrl preserves existing percent-encoding", () => {
    expect(encodeUrl("/foo bar")).toBe("/foo%20bar");
    expect(encodeUrl("/foo%20bar")).toBe("/foo%20bar");
  });
});

describe("native: dates", () => {
  it("isDateValid", () => {
    expect(isDateValid(new Date())).toBe(true);
    expect(isDateValid(new Date("nonsense"))).toBe(false);
  });

  it("toHttpDate produces an RFC 7231 string", () => {
    expect(toHttpDate(new Date(0))).toBe("Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

describe("native: etag", () => {
  it("produces a stable quoted etag", () => {
    const a = etag("hello world");
    const b = etag(Buffer.from("hello world"));
    expect(a).toBe(b);
    expect(a.startsWith('"')).toBe(true);
  });

  it("differs for different content and handles empty input", () => {
    expect(etag("a")).not.toBe(etag("b"));
    expect(etag("")).toBe('"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"');
  });
});

describe("native: fresh", () => {
  it("matches on if-none-match", () => {
    expect(fresh({ "if-none-match": '"abc"' }, { etag: '"abc"' })).toBe(true);
    expect(fresh({ "if-none-match": '"abc"' }, { etag: '"xyz"' })).toBe(false);
  });

  it("returns false without conditional headers", () => {
    expect(fresh({}, {})).toBe(false);
  });

  it("honours cache-control: no-cache", () => {
    expect(
      fresh(
        { "if-none-match": '"abc"', "cache-control": "no-cache" },
        { etag: '"abc"' },
      ),
    ).toBe(false);
  });

  it("matches on if-modified-since", () => {
    const now = new Date().toUTCString();
    expect(fresh({ "if-modified-since": now }, { "last-modified": now })).toBe(
      true,
    );
  });
});

describe("native: rangeParser", () => {
  it("parses byte ranges", () => {
    const result = rangeParser(1000, "bytes=0-499");
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.type).toBe("bytes");
      expect(result[0]).toEqual({ start: 0, end: 499 });
    }
  });

  it("parses suffix ranges", () => {
    const result = rangeParser(1000, "bytes=-200");
    if (Array.isArray(result)) {
      expect(result[0]).toEqual({ start: 800, end: 999 });
    }
  });

  it("returns -2 for malformed and -1 for unsatisfiable", () => {
    expect(rangeParser(1000, "nonsense")).toBe(-2);
    expect(rangeParser(1000, "bytes=900-100")).toBe(-1);
  });

  it("combines overlapping ranges when requested", () => {
    const result = rangeParser(1000, "bytes=0-100,50-200", { combine: true });
    if (Array.isArray(result)) {
      expect(result).toEqual([{ start: 0, end: 200 }] as never);
    }
  });
});

describe("native: appendVary", () => {
  it("appends unique field names", () => {
    expect(appendVary("", "Accept")).toBe("Accept");
    expect(appendVary("Accept", "Accept-Encoding")).toBe(
      "Accept, Accept-Encoding",
    );
    expect(appendVary("Accept", "accept")).toBe("Accept");
  });

  it("collapses to * when wildcard present", () => {
    expect(appendVary("Accept", "*")).toBe("*");
    expect(appendVary("*", "Accept")).toBe("*");
  });

  it("rejects invalid field names", () => {
    expect(() => appendVary("", "bad header")).toThrow();
  });
});

describe("native: cookies", () => {
  it("parses cookies via Bun's native CookieMap", () => {
    expect(parseCookie("a=1; b=hello%20world")).toEqual({
      a: "1",
      b: "hello world",
    });
    expect(parseCookie("")).toEqual({});
  });

  it("serialises cookies via Bun's native Cookie", () => {
    // Bun.Cookie applies `Path=/` and `SameSite=Lax` defaults.
    const serialized = serializeCookie("token", "abc", {
      path: "/",
      httpOnly: true,
    });
    expect(serialized).toContain("token=abc");
    expect(serialized).toContain("Path=/");
    expect(serialized).toContain("HttpOnly");

    // The Priority attribute is appended manually (Bun.Cookie omits it).
    expect(serializeCookie("p", "1", { priority: "high" })).toContain(
      "Priority=High",
    );
  });

  it("signs and verifies cookie values", () => {
    const signed = signCookie("session", "s3cr3t");
    expect(unsignCookie(signed, "s3cr3t")).toBe("session");
    expect(unsignCookie(signed, "wrong")).toBe(false);
    expect(unsignCookie("no-signature", "s3cr3t")).toBe(false);
  });

  it("jsonCookies parses j: prefixed values", () => {
    expect(jsonCookies({ a: 'j:{"x":1}', b: "plain" })).toEqual({
      a: { x: 1 },
      b: "plain",
    });
  });

  it("extractSignedCookies pulls verified values out", () => {
    const signed = signCookie("v", "secret");
    const cookies: Record<string, string> = {
      sess: `s:${signed}`,
      plain: "kept",
    };
    const result = extractSignedCookies(cookies, ["secret"]);
    expect(result).toEqual({ sess: "v" });
    expect(cookies).toEqual({ plain: "kept" });
  });
});

describe("native: async helpers", () => {
  it("createDeferred resolves externally", async () => {
    const deferred = createDeferred<number>();
    queueMicrotask(() => deferred.resolve(5));
    expect(await deferred.promise).toBe(5);
  });

  it("waitUntil resolves once the predicate passes", async () => {
    let value = 0;
    const timer = setInterval(() => {
      value += 1;
    }, 5);
    const result = await waitUntil(
      () => value,
      (v) => v >= 3,
    );
    clearInterval(timer);
    expect(result).toBeGreaterThanOrEqual(3);
  });

  it("waitUntil rejects after a timeout", async () => {
    await expect(
      waitUntil(
        () => false,
        (v) => v === true,
        { interval: 5, timeout: 30 },
      ),
    ).rejects.toThrow("timed out");
  });
});

describe("native: getPort", () => {
  it("returns an available port and never the same one twice in a row", async () => {
    const a = await getPort();
    const b = await getPort();
    expect(typeof a).toBe("number");
    expect(a).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("honours a preferred port", async () => {
    const preferred = await getPort();
    const result = await getPort({ port: [preferred + 1] });
    expect(typeof result).toBe("number");
  });
});

describe("native: parseXmlToObject", () => {
  it("parses nested elements keyed by the root name", () => {
    const result = parseXmlToObject(
      "<note><to>Tove</to><from>Jani</from></note>",
    );
    expect(result).toEqual({ note: { to: "Tove", from: "Jani" } });
  });

  it("coerces numeric and boolean leaf text", () => {
    const result = parseXmlToObject("<v><n>42</n><b>true</b><s>hi</s></v>");
    expect(result).toEqual({ v: { n: 42, b: true, s: "hi" } });
  });

  it("can disable primitive coercion", () => {
    const result = parseXmlToObject("<v><n>42</n></v>", {
      parsePrimitives: false,
    });
    expect(result).toEqual({ v: { n: "42" } });
  });

  it("exposes attributes under the configured prefix", () => {
    const result = parseXmlToObject(
      `<user id="42" admin="true"><name>Jane</name></user>`,
    );
    expect(result).toEqual({
      user: { "@_id": 42, "@_admin": true, name: "Jane" },
    });
  });

  it("honours a custom attribute prefix and can ignore attributes", () => {
    expect(
      parseXmlToObject(`<a x="1"><b>2</b></a>`, { attributeNamePrefix: "$" }),
    ).toEqual({ a: { $x: 1, b: 2 } });
    expect(
      parseXmlToObject(`<a x="1"><b>2</b></a>`, { ignoreAttributes: true }),
    ).toEqual({ a: { b: 2 } });
  });

  it("collapses repeated sibling elements into an array", () => {
    const result = parseXmlToObject(
      "<list><item>a</item><item>b</item></list>",
    );
    expect(result).toEqual({ list: { item: ["a", "b"] } });
  });

  it("handles self-closing elements", () => {
    const result = parseXmlToObject(`<root><br/><img src="x"/></root>`);
    expect(result).toEqual({ root: { br: "", img: { "@_src": "x" } } });
  });

  it("decodes named and numeric entities", () => {
    const result = parseXmlToObject("<m>a &amp; b &lt; c &#65; &#x42;</m>");
    expect(result).toEqual({ m: "a & b < c A B" });
  });

  it("treats CDATA as raw text and skips comments", () => {
    const result = parseXmlToObject(
      "<root><!-- comment --><![CDATA[<b>raw</b>]]></root>",
    );
    expect(result).toEqual({ root: "<b>raw</b>" });
  });

  it("skips the XML declaration and DOCTYPE prolog", () => {
    const result = parseXmlToObject(
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE root><root><a>1</a></root>`,
    );
    expect(result).toEqual({ root: { a: 1 } });
  });

  it("keeps text alongside attributes under #text", () => {
    const result = parseXmlToObject(`<p class="lead">hello</p>`);
    expect(result).toEqual({ p: { "@_class": "lead", "#text": "hello" } });
  });

  it("throws when there is no XML element", () => {
    expect(() => parseXmlToObject("   ")).toThrow();
  });
});
