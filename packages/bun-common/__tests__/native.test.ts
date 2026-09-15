import type { SerializedError } from "../lib/utils/native";
import { Buffer } from "node:buffer";
import { describe, expect, it, spyOn } from "bun:test";
import {
  appendVary,
  cloneDeep,
  computeBackoff,
  createDeferred,
  decodeXmlEntities,
  deserializeError,
  each,
  encodeUrl,
  etag,
  extractSignedCookies,
  first,
  flattenDeep,
  fresh,
  get,
  getPort,
  isAbortError,
  isAnyArrayBuffer,
  isArray,
  isArrayBufferView,
  isAsyncGeneratorFunction,
  isAsyncIterable,
  isBinaryBody,
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
  jsonClone,
  jsonCookies,
  keys,
  lastIndexOf,
  merge,
  Mutex,
  omit,
  orderBy,
  parseCookie,
  parseXmlToObject,
  pick,
  rangeParser,
  retry,
  Semaphore,
  serializeCookie,
  serializeError,
  set,
  signCookie,
  sleep,
  TimeoutError,
  toHttpDate,
  ucwords,
  unsignCookie,
  values,
  waitUntil,
  withTimeout,
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

  it("isArrayBufferView covers typed arrays and DataView", () => {
    expect(isArrayBufferView(new Uint8Array(1))).toBe(true);
    expect(isArrayBufferView(Buffer.from("x"))).toBe(true);
    expect(isArrayBufferView(new Float64Array(1))).toBe(true);
    expect(isArrayBufferView(new DataView(new ArrayBuffer(1)))).toBe(true);
    expect(isArrayBufferView(new ArrayBuffer(1))).toBe(false);
    expect(isArrayBufferView("x")).toBe(false);
  });

  it("isAnyArrayBuffer covers ArrayBuffer and SharedArrayBuffer", () => {
    expect(isAnyArrayBuffer(new ArrayBuffer(1))).toBe(true);
    expect(isAnyArrayBuffer(new SharedArrayBuffer(1))).toBe(true);
    expect(isAnyArrayBuffer(new Uint8Array(1))).toBe(false);
    expect(isAnyArrayBuffer({})).toBe(false);
  });

  it("isBinaryBody covers both views and raw buffers", () => {
    expect(isBinaryBody(Buffer.from("x"))).toBe(true);
    expect(isBinaryBody(new DataView(new ArrayBuffer(1)))).toBe(true);
    expect(isBinaryBody(new ArrayBuffer(1))).toBe(true);
    expect(isBinaryBody(new SharedArrayBuffer(1))).toBe(true);
    expect(isBinaryBody("x")).toBe(false);
    expect(isBinaryBody({ length: 1 })).toBe(false);
  });

  it("isAsyncIterable", () => {
    expect(
      isAsyncIterable({
        async *[Symbol.asyncIterator]() {
          yield 1;
        },
      }),
    ).toBe(true);
    // A running async generator is itself async-iterable.
    expect(isAsyncIterable((async function* () {})())).toBe(true);
    expect(isAsyncIterable([1, 2])).toBe(false);
    expect(isAsyncIterable("abc")).toBe(false);
  });

  it("isAsyncGeneratorFunction only matches async generator declarations", () => {
    expect(isAsyncGeneratorFunction(async function* () {})).toBe(true);
    expect(isAsyncGeneratorFunction(function* () {})).toBe(false);
    expect(isAsyncGeneratorFunction(async () => {})).toBe(false);
    expect(isAsyncGeneratorFunction(() => {})).toBe(false);
    // The generator object, not the function, is not a match.
    expect(isAsyncGeneratorFunction((async function* () {})())).toBe(false);
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
    // Not a Date at all — the guard overload's domain.
    expect(isDateValid("2020-01-01")).toBe(false);
    expect(isDateValid(Date.now())).toBe(false);
    expect(isDateValid(null)).toBe(false);
    expect(isDateValid({ getTime: () => 0 })).toBe(false);
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

  it("hashes typed arrays, DataViews and ArrayBuffers by their bytes", () => {
    const expected = etag(Buffer.from("hello world"));
    const bytes = new TextEncoder().encode("hello world");
    expect(etag(bytes)).toBe(expected);
    expect(etag(new DataView(bytes.buffer as ArrayBuffer))).toBe(expected);
    expect(etag(bytes.buffer as ArrayBuffer)).toBe(expected);

    const shared = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(shared).set(bytes);
    expect(etag(shared)).toBe(expected);
  });

  it("hashes only a view's window of its buffer", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(etag(bytes.subarray(1, 4))).toBe(etag(new Uint8Array([2, 3, 4])));
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

describe("native: sleep", () => {
  it("resolves after the delay", async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("rejects when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const waiting = sleep(1000, { signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toThrow();
    expect(await waiting.catch((error) => isAbortError(error))).toBe(true);
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      await sleep(1000, { signal: controller.signal }).catch((error) =>
        isAbortError(error),
      ),
    ).toBe(true);
  });
});

describe("native: isAbortError", () => {
  it("recognises AbortError by name and by code", () => {
    const named = new Error("stopped");
    named.name = "AbortError";
    const coded = Object.assign(new Error("stopped"), { code: "ABORT_ERR" });

    expect(isAbortError(named)).toBe(true);
    expect(isAbortError(coded)).toBe(true);
    expect(isAbortError(new Error("other"))).toBe(false);
    expect(isAbortError("nope")).toBe(false);
  });
});

describe("native: withTimeout", () => {
  it("passes the value through when the work finishes in time", async () => {
    expect(await withTimeout(Promise.resolve("ok"), 1000)).toBe("ok");
    expect(await withTimeout(() => "lazy", 1000)).toBe("lazy");
  });

  it("rejects with a TimeoutError carrying the budget", async () => {
    const work = new Promise<string>((resolve) => {
      const timer = setTimeout(resolve, 1000, "late");
      timer.unref?.();
    });

    const error = await withTimeout(work, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).ms).toBe(10);
  });

  it("calls onTimeout so the work can be aborted", async () => {
    const controller = new AbortController();
    const work = sleep(1000, { signal: controller.signal, unref: true });

    await withTimeout(work, 10, {
      onTimeout: () => controller.abort(),
    }).catch(() => {});

    expect(controller.signal.aborted).toBe(true);
  });

  it("treats a non-positive budget as no timeout", async () => {
    expect(await withTimeout(Promise.resolve(1), 0)).toBe(1);
    expect(await withTimeout(Promise.resolve(2), -5)).toBe(2);
  });

  it("swallows a rejection arriving after the timeout", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const work = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("too late")), 20);
        timer.unref?.();
      });

      await expect(withTimeout(work, 5)).rejects.toThrow(TimeoutError);
      await sleep(40);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("native: computeBackoff", () => {
  it("holds the delay steady when fixed", () => {
    expect(computeBackoff(1, { delay: 100 })).toBe(100);
    expect(computeBackoff(5, { delay: 100 })).toBe(100);
    expect(computeBackoff(3, 250)).toBe(250);
  });

  it("grows by the factor when exponential", () => {
    const options = { type: "exponential", delay: 100, factor: 2 } as const;
    expect(computeBackoff(1, options)).toBe(100);
    expect(computeBackoff(2, options)).toBe(200);
    expect(computeBackoff(4, options)).toBe(800);
  });

  it("caps at max", () => {
    expect(
      computeBackoff(10, {
        type: "exponential",
        delay: 100,
        factor: 2,
        max: 1000,
      }),
    ).toBe(1000);
  });

  it("keeps jitter within the requested fraction", () => {
    for (let i = 0; i < 50; i++) {
      const value = computeBackoff(1, { delay: 1000, jitter: 0.1 });
      expect(value).toBeGreaterThanOrEqual(900);
      expect(value).toBeLessThanOrEqual(1100);
    }

    // `true` is shorthand for ±10%.
    const shorthand = computeBackoff(1, { delay: 1000, jitter: true });
    expect(shorthand).toBeGreaterThanOrEqual(900);
    expect(shorthand).toBeLessThanOrEqual(1100);
  });

  it("grows by the attempt when linear", () => {
    const options = { type: "linear", delay: 100 } as const;
    const delays = [1, 2, 3, 10].map((n) => computeBackoff(n, options));
    expect(delays).toEqual([100, 200, 300, 1000]);
  });

  it("follows the Fibonacci sequence when fibonacci", () => {
    const options = { type: "fibonacci", delay: 100 } as const;
    expect(
      [1, 2, 3, 4, 5, 6, 7].map((n) => computeBackoff(n, options)),
    ).toEqual([100, 100, 200, 300, 500, 800, 1300]);
  });

  it("caps linear and fibonacci at max, even where the sequence overflows", () => {
    expect(computeBackoff(50, { type: "linear", delay: 100, max: 1000 })).toBe(
      1000,
    );
    expect(
      computeBackoff(5_000, { type: "fibonacci", delay: 100, max: 60_000 }),
    ).toBe(60_000);
  });

  it("draws full jitter from zero up to the exponential delay", () => {
    const options = { type: "full-jitter", delay: 100, factor: 2 } as const;
    const draws = Array.from({ length: 400 }, () => computeBackoff(4, options));

    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThanOrEqual(800);
    // Spread across the range rather than parked at one end: the whole point.
    expect(draws.some((draw) => draw < 200)).toBe(true);
    expect(draws.some((draw) => draw > 600)).toBe(true);
    // And capped when the exponential delay passes max.
    for (let i = 0; i < 50; i++) {
      expect(
        computeBackoff(20, { type: "full-jitter", delay: 100, max: 500 }),
      ).toBeLessThanOrEqual(500);
    }
  });

  it("keeps decorrelated jitter at or above the base, growing, under max", () => {
    const options = {
      type: "decorrelated-jitter",
      delay: 100,
      max: 10_000,
    } as const;

    const draw = (attempt: number) =>
      Array.from({ length: 400 }, () => computeBackoff(attempt, options));
    const first = draw(1);
    const tenth = draw(10);
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;

    for (const draw of [...first, ...tenth]) {
      expect(draw).toBeGreaterThanOrEqual(100);
      expect(draw).toBeLessThanOrEqual(10_000);
    }
    // One step draws between the base and three times it.
    expect(Math.max(...first)).toBeLessThanOrEqual(300);
    // Later attempts wait longer on average.
    expect(mean(tenth)).toBeGreaterThan(mean(first) * 3);
  });

  it("ignores jitter for the strategies that are random already", () => {
    for (let i = 0; i < 50; i++) {
      expect(
        computeBackoff(1, {
          type: "decorrelated-jitter",
          delay: 100,
          jitter: 5,
        }),
      ).toBeLessThanOrEqual(300);
    }
  });
});

describe("native: retry", () => {
  it("returns the first success", async () => {
    let attempts = 0;
    const value = await retry(
      () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("not yet");
        }
        return "done";
      },
      { attempts: 5, backoff: 1 },
    );

    expect(value).toBe("done");
    expect(attempts).toBe(3);
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    let attempts = 0;
    const failing = retry(
      () => {
        attempts++;
        throw new Error(`attempt ${attempts}`);
      },
      { attempts: 3, backoff: 1 },
    );

    await expect(failing).rejects.toThrow("attempt 3");
    expect(attempts).toBe(3);
  });

  it("stops early when shouldRetry says the error is final", async () => {
    let attempts = 0;
    const failing = retry(
      () => {
        attempts++;
        throw new Error("fatal");
      },
      {
        attempts: 5,
        backoff: 1,
        shouldRetry: (error) => (error as Error).message !== "fatal",
      },
    );

    await expect(failing).rejects.toThrow("fatal");
    expect(attempts).toBe(1);
  });

  it("reports each wait through onRetry", async () => {
    const waits: number[] = [];
    await retry(
      (attempt) => {
        if (attempt < 3) {
          throw new Error("again");
        }
        return attempt;
      },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 2, factor: 2 },
        onRetry: (_error, _attempt, delay) => waits.push(delay),
      },
    );

    expect(waits).toEqual([2, 4]);
  });

  it("aborts between attempts", async () => {
    const controller = new AbortController();
    let attempts = 0;

    const failing = retry(
      () => {
        attempts++;
        controller.abort();
        throw new Error("boom");
      },
      { attempts: 5, backoff: 50, signal: controller.signal },
    );

    expect(await failing.catch((error) => isAbortError(error))).toBe(true);
    expect(attempts).toBe(1);
  });
});

describe("native: serializeError / deserializeError", () => {
  it("round-trips name, message, stack and code", () => {
    const original = Object.assign(new TypeError("bad input"), {
      code: "ERR_BAD",
    });

    const serialized = serializeError(original);
    expect(serialized).toMatchObject({
      name: "TypeError",
      message: "bad input",
      code: "ERR_BAD",
    });
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);

    const restored = deserializeError(serialized);
    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe("TypeError");
    expect(restored.message).toBe("bad input");
    expect(restored.stack).toBe(serialized.stack);
    expect((restored as Error & { code?: string }).code).toBe("ERR_BAD");
  });

  it("follows the cause chain", () => {
    const root = new Error("socket closed");
    const wrapper = new Error("query failed", { cause: root });

    const serialized = serializeError(wrapper);
    expect(serialized.cause?.message).toBe("socket closed");

    const restored = deserializeError(serialized);
    expect((restored.cause as Error).message).toBe("socket closed");
  });

  it("stops following causes at maxDepth", () => {
    const deep = new Error("a", {
      cause: new Error("b", { cause: new Error("c") }),
    });

    const serialized = serializeError(deep, { maxDepth: 1 });
    expect(serialized.cause?.message).toBe("b");
    expect(serialized.cause?.cause).toBeUndefined();
  });

  it("keeps extra own properties under data", () => {
    const error = Object.assign(new Error("nope"), {
      jobId: "j1",
      attempt: 2,
    });

    expect(serializeError(error).data).toEqual({ jobId: "j1", attempt: 2 });
    expect(
      (deserializeError(serializeError(error)) as Error & { jobId?: string })
        .jobId,
    ).toBe("j1");
  });

  it("never lets data overwrite the rebuilt error's own fields", () => {
    // Parsed from JSON, as stored or foreign input would be: that is the only
    // way `__proto__` arrives as an own key rather than setting a prototype.
    const input = JSON.parse(`{
      "name": "LockLostError",
      "message": "real message",
      "stack": "real stack",
      "code": "LOCK_LOST",
      "cause": { "name": "Error", "message": "real cause" },
      "data": {
        "name": "FakeName",
        "message": "fake message",
        "stack": "fake stack",
        "code": "FAKE",
        "cause": "fake cause",
        "__proto__": { "hijacked": true },
        "jobId": "j1",
        "ms": 250
      }
    }`) as SerializedError;
    const restored = deserializeError(input) as Error & Record<string, unknown>;

    expect(restored).toBeInstanceOf(Error);
    expect(restored.name).toBe("LockLostError");
    expect(restored.message).toBe("real message");
    expect(restored.stack).toBe("real stack");
    expect(restored.code).toBe("LOCK_LOST");
    expect((restored.cause as Error).message).toBe("real cause");
    expect(restored.jobId).toBe("j1");
    expect(restored.ms).toBe(250);
    expect(restored.hijacked).toBeUndefined();
  });

  it("keeps a non-Error visible rather than dropping it", () => {
    expect(serializeError("just a string")).toEqual({
      name: "NonError",
      message: "just a string",
    });
    expect(serializeError(42).message).toBe("42");
    expect(serializeError(undefined).name).toBe("NonError");
  });

  it("truncates a very long stack", () => {
    const error = new Error("long");
    error.stack = "x".repeat(5000);

    const serialized = serializeError(error, { maxStackBytes: 100 });
    expect(serialized.stack?.length).toBeLessThan(200);
    expect(serialized.stack).toContain("truncated");
  });
});

describe("native: jsonClone", () => {
  it("returns a structurally equal but distinct value", () => {
    const source = { a: 1, nested: { b: [1, 2, 3] } };
    const cloned = jsonClone(source);

    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.nested).not.toBe(source.nested);
  });

  it("documents the losses that cross a boundary", () => {
    // The return type is `Jsonify<T>`, so each expectation below is also
    // what the compiler says comes back (asserted in native.type-test.ts).
    const dropped = jsonClone({ a: undefined, b: 1, fn: () => 1 });
    expect(dropped).toEqual({ b: 1 });
    expect("a" in dropped).toBe(false);

    const dated = jsonClone({ at: new Date("2020-01-01T00:00:00.000Z") });
    expect(dated).toEqual({ at: "2020-01-01T00:00:00.000Z" });
    expect(dated.at.startsWith("2020")).toBe(true);

    expect(jsonClone({ m: new Map([["a", 1]]), s: new Set([1]) })).toEqual({
      m: {},
      s: {},
    });
    expect(jsonClone([undefined, () => 1, Symbol("s"), 2])).toEqual([
      null,
      null,
      null,
      2,
    ]);
    expect(jsonClone({ custom: { toJSON: () => "custom" } })).toEqual({
      custom: "custom",
    });
    expect(jsonClone(undefined)).toBeUndefined();
    expect(jsonClone(() => 1)).toBeUndefined();
  });

  it("throws on values JSON cannot represent", () => {
    expect(() => jsonClone({ big: 1n })).toThrow(TypeError);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonClone(cyclic)).toThrow();
  });
});

describe("native: Mutex", () => {
  it("serialises holders", async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = mutex.runExclusive(async () => {
      order.push("first:start");
      await sleep(10);
      order.push("first:end");
    });
    const second = mutex.runExclusive(() => {
      order.push("second");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("hands the lock to waiters in arrival order", async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const release = await mutex.acquire();
    expect(mutex.locked).toBe(true);

    const waiters = [1, 2, 3].map(async (id) => {
      const done = await mutex.acquire();
      order.push(id);
      done();
    });

    expect(mutex.waiting).toBe(3);
    release();
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
    expect(mutex.locked).toBe(false);
  });

  it("ignores a second release", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();

    release();
    release();

    expect(mutex.locked).toBe(false);
    const next = await mutex.acquire();
    expect(mutex.locked).toBe(true);
    next();
  });

  it("releases the lock when the body throws", async () => {
    const mutex = new Mutex();
    await expect(
      mutex.runExclusive(() => {
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
    expect(mutex.locked).toBe(false);
  });
});

describe("native: Semaphore", () => {
  it("bounds concurrency", async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    const task = () =>
      semaphore.runExclusive(async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        active--;
      });

    await Promise.all(Array.from({ length: 6 }, task));

    expect(peak).toBe(2);
    expect(semaphore.available).toBe(2);
  });

  it("tryAcquire never waits", async () => {
    const semaphore = new Semaphore(1);
    const held = semaphore.tryAcquire();

    expect(held).not.toBeNull();
    expect(semaphore.tryAcquire()).toBeNull();

    held?.();
    expect(semaphore.tryAcquire()).not.toBeNull();
  });

  it("wakes waiters when permits are added", async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const order: string[] = [];

    const waiter = semaphore.acquire().then((release) => {
      order.push("second");
      release();
    });

    expect(semaphore.waiting).toBe(1);
    semaphore.setPermits(2);
    await waiter;

    expect(order).toEqual(["second"]);
    first();
    expect(semaphore.permits).toBe(2);
  });
});

/*
 * Code/documentation harmonization — each case below failed before its fix.
 */
describe("native: behaviour matches the documentation", () => {
  it("encodeUrl replaces an unmatched surrogate with U+FFFD, as encodeurl does", () => {
    expect(encodeUrl("/\uD800")).toBe("/%EF%BF%BD");
    expect(encodeUrl("/\uDC00x")).toBe("/%EF%BF%BDx");
    expect(encodeUrl("/x\uD800b")).toBe("/x%EF%BF%BDb");
    expect(encodeUrl("/\uDFFF\uD800")).toBe("/%EF%BF%BD%EF%BF%BD");
    // A well-formed pair is still encoded as the character it forms.
    expect(encodeUrl("/😀")).toBe("/%F0%9F%98%80");
  });

  it("jsonCookies parses in place and returns the same object, as cookie-parser does", () => {
    const cookies: Record<string, string> = {
      a: 'j:{"x":1}',
      b: "plain",
      c: "j:not json",
      d: "j:null",
      e: "j:false",
      f: "j:[1]",
    };
    const result = jsonCookies(cookies);

    expect(result).toBe(cookies);
    // cookie-parser only replaces a value that parses to something truthy.
    expect(cookies as Record<string, unknown>).toEqual({
      a: { x: 1 },
      b: "plain",
      c: "j:not json",
      d: "j:null",
      e: "j:false",
      f: [1],
    });
  });

  it("serializeCookie omits SameSite for sameSite: false, as the cookie package does", () => {
    expect(serializeCookie("a", "1", { sameSite: false })).toBe("a=1; Path=/");
    expect(
      serializeCookie("a", "1", { sameSite: false, priority: "high" }),
    ).toBe("a=1; Path=/; Priority=High");
    // Unset still gets Bun's documented default.
    expect(serializeCookie("a", "1")).toContain("SameSite=Lax");
  });

  it("sleep rejects with an AbortError carrying a non-Error reason as its cause", async () => {
    const controller = new AbortController();
    controller.abort("because");
    const early = await sleep(1000, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(early).toBeInstanceOf(Error);
    expect(isAbortError(early)).toBe(true);
    expect((early as Error).cause).toBe("because");

    const later = new AbortController();
    const waiting = sleep(1000, { signal: later.signal });
    later.abort(42);
    const midWait = await waiting.catch((error: unknown) => error);
    expect(isAbortError(midWait)).toBe(true);
    expect((midWait as Error).cause).toBe(42);

    // An Error reason is still rejected as-is.
    const reason = new Error("shutting down");
    const withError = new AbortController();
    withError.abort(reason);
    expect(
      await sleep(1000, { signal: withError.signal }).catch((e: unknown) => e),
    ).toBe(reason);
  });

  it("retry rejects the same way for a non-Error abort reason", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const error = await retry(() => 1, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(error)).toBe(true);
    expect((error as Error).cause).toBe("stop");
  });

  it("withTimeout rejects, never throws, when the work function throws synchronously", async () => {
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = withTimeout(() => {
        throw new Error("sync");
      }, 100);
    }).not.toThrow();
    await expect(returned).rejects.toThrow("sync");

    let noBudget: Promise<unknown> | undefined;
    expect(() => {
      noBudget = withTimeout(() => {
        throw new Error("sync, no budget");
      }, 0);
    }).not.toThrow();
    await expect(noBudget).rejects.toThrow("sync, no budget");
  });

  it("withTimeout's timeout rejection is named TimeoutError", async () => {
    const error = await withTimeout(new Promise(() => {}), 5).catch(
      (e: unknown) => e,
    );
    expect((error as Error).name).toBe("TimeoutError");
    expect(new TimeoutError(1).name).toBe("TimeoutError");
  });

  it("Semaphore never runs more holders than a lowered limit, nor reports negative availability", async () => {
    const semaphore = new Semaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();
    let thirdHolding = false;
    const third = semaphore.acquire().then((release) => {
      thirdHolding = true;
      return release;
    });

    semaphore.setPermits(1);
    expect(semaphore.available).toBe(0);

    first();
    await sleep(5);
    expect(thirdHolding).toBe(false);
    expect(semaphore.available).toBe(0);
    expect(semaphore.tryAcquire()).toBeNull();

    second();
    const releaseThird = await third;
    expect(thirdHolding).toBe(true);
    expect(semaphore.available).toBe(0);

    releaseThird();
    expect(semaphore.available).toBe(1);
    expect(semaphore.permits).toBe(1);
  });

  it("Semaphore keeps its peak at the limit through a lowering under load", async () => {
    const semaphore = new Semaphore(4);
    let active = 0;
    let overLimit = false;

    const task = () =>
      semaphore.runExclusive(async () => {
        active++;
        if (active > semaphore.permits) {
          overLimit = true;
        }
        await sleep(2);
        active--;
      });

    const all = Promise.all(Array.from({ length: 20 }, task));
    await sleep(1);
    semaphore.setPermits(2);
    // Holders admitted before the change may still be finishing; after they
    // drain nothing new starts above the lowered limit.
    await sleep(10);
    overLimit = false;
    await all;

    expect(overLimit).toBe(false);
    expect(semaphore.available).toBe(2);
  });

  it("decodeXmlEntities leaves a reference past U+10FFFF untouched", () => {
    expect(decodeXmlEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeXmlEntities("&#x110000; &#x10FFFF;")).toBe(
      "&#x110000; \u{10FFFF}",
    );
    expect(decodeXmlEntities("&#99999999999999999999;")).toBe(
      "&#99999999999999999999;",
    );
    expect(parseXmlToObject("<m>&#1114112;</m>")).toEqual({ m: "&#1114112;" });
  });

  it("serializeError counts maxStackBytes in UTF-8 bytes and cuts on a character boundary", () => {
    const error = new Error("multibyte");
    error.stack = "é".repeat(10); // 20 UTF-8 bytes, 10 characters

    // Fits in bytes: untouched.
    expect(serializeError(error, { maxStackBytes: 20 }).stack).toBe(
      "é".repeat(10),
    );
    // 10 characters but 20 bytes: a 10-byte cap keeps 5 characters.
    expect(serializeError(error, { maxStackBytes: 10 }).stack).toBe(
      `${"é".repeat(5)}\n… (stack truncated)`,
    );
    // An odd cap cannot split a two-byte character.
    expect(serializeError(error, { maxStackBytes: 9 }).stack).toBe(
      `${"é".repeat(4)}\n… (stack truncated)`,
    );

    const emoji = new Error("astral");
    emoji.stack = "😀😀"; // 8 bytes
    expect(serializeError(emoji, { maxStackBytes: 6 }).stack).toBe(
      "😀\n… (stack truncated)",
    );
  });

  it("retry's waits keep the process alive by default, and unref: true lets it exit", () => {
    const nativePath = new URL("../lib/utils/native.ts", import.meta.url)
      .pathname;
    const run = (options: string): string => {
      const child = Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          `import { retry } from ${JSON.stringify(nativePath)};
           retry(() => { throw new Error("down"); }, { attempts: 2, backoff: 150${options} })
             .catch(() => console.log("gave up"));`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      return child.stdout.toString().trim();
    };

    expect(run("")).toBe("gave up");
    expect(run(", unref: true")).toBe("");
  });
});
