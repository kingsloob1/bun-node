/**
 * Option tour: the native utilities — every exported helper from
 * `lib/utils/native.ts` and `lib/utils/general.ts`, and the compatibility
 * exports (`cookie`, `cookieSignature`, `cookieParser`, `vary`, `eTag`,
 * `accepts`, `typeIs`, `mime`), called with every option and checked.
 *
 * ```bash
 * bun 12-options/native-utilities.ts
 * ```
 *
 * Each check is taken from the helper's JSDoc, edge cases included, so a
 * failing check means the code and its documentation have drifted apart.
 *
 * Timing checks use fixed inputs and generous bounds. Checks about whether a
 * timer holds the process open run in a child process, because the only way
 * to see a process exit early is to watch one.
 *
 * Not covered: `applyMixins` and `isNodeReadableStream` live in
 * `lib/utils/general.ts` but `lib/index.ts` does not re-export them.
 */
import type {
  JsonValue,
  Range,
  RangeParserResult,
  SerializedError,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import {
  accepts,
  appendVary,
  cloneDeep,
  coerceXmlPrimitive,
  combineRanges,
  computeBackoff,
  cookie,
  cookieParser,
  cookieSignature,
  createDeferred,
  decodeXmlEntities,
  deserializeError,
  each,
  encodeUrl,
  eTag,
  etag,
  extractSignedCookies,
  first,
  flattenDeep,
  fresh,
  get,
  getMimeFromStr,
  getPort,
  getUniqueFilename,
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
  isMime,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  isXmlWhitespace,
  jsonClone,
  jsonCookies,
  keys,
  lastIndexOf,
  merge,
  mime,
  Mutex,
  omit,
  orderBy,
  parseByteSize,
  parseCookie,
  parseXmlToObject,
  pathExists,
  pick,
  randomBytes,
  rangeParser,
  retry,
  Semaphore,
  serializeCookie,
  serializeError,
  set,
  signCookie,
  sleep,
  streamToBuffer,
  TimeoutError,
  toHttpDate,
  typeIs,
  ucwords,
  unset,
  unsignCookie,
  values,
  vary,
  waitUntil,
  withTimeout,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Option tour: native utilities");

// Several checks await unref'd timers (withTimeout's default, sleep with
// `unref: true`); hold the process open until the end.
const keepAlive = setInterval(() => {}, 1_000);

/** What a short child script printed, and how long it ran. */
interface ScriptResult {
  /** stdout and stderr together, trimmed. */
  output: string;
  /** Wall-clock milliseconds from spawn to exit. */
  ms: number;
}

/** Runs `source` in a fresh Bun process, resolving the package by name. */
function runScript(source: string): ScriptResult {
  const started = performance.now();
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", source],
    cwd: import.meta.dir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return {
    output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
    ms: performance.now() - started,
  };
}

/** What a caught value was, by name, without assuming it is an `Error`. */
function nameOf(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : undefined;
}

/** Runs `run`, answering with its value, or `threw <name>` if it threw. */
function outcome<T>(run: () => T): T | string {
  try {
    return run();
  } catch (error) {
    return `threw ${String(nameOf(error))}`;
  }
}

/**
 * Runs `run` and answers with whatever it threw, or `undefined`. `unknown`,
 * since anything can be thrown.
 */
function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
step("Type guards");

checkEqual(
  "isArray / isString / isNumber / isBoolean",
  [
    isArray([]),
    isArray({ length: 0 }),
    isString(""),
    isString(1),
    isNumber(0),
    isNumber(Number.NaN), // lodash parity: NaN is a number
    isNumber("1"),
    isBoolean(false),
    isBoolean(0),
  ],
  [true, false, true, false, true, true, false, true, false],
);
checkEqual(
  "isFunction / isUndefined / isNull",
  [
    isFunction(() => {}),
    isFunction(class {}),
    isFunction({}),
    isUndefined(undefined),
    isUndefined(null),
    isNull(null),
    isNull(undefined),
  ],
  [true, true, false, true, false, true, false],
);
checkEqual(
  "isObject: arrays and functions yes, null and primitives no",
  [
    isObject({}),
    isObject([]),
    isObject(() => {}),
    isObject(null),
    isObject("x"),
  ],
  [true, true, true, false, false],
);
checkEqual(
  "isError: instances, subclasses, and anything tagged [object Error]",
  [
    isError(new Error("x")),
    isError(new TypeError("x")),
    isError({ [Symbol.toStringTag]: "Error" }),
    isError({ name: "Error", message: "x" }),
  ],
  [true, true, true, false],
);
checkEqual(
  "isBuffer / isMap",
  [
    isBuffer(Buffer.from("x")),
    isBuffer(new Uint8Array(1)),
    isMap(new Map()),
    isMap(new WeakMap()),
  ],
  [true, false, true, false],
);
checkEqual(
  "isArrayBufferView: typed arrays, Buffer, DataView — not a raw buffer",
  [
    isArrayBufferView(new Uint8Array(1)),
    isArrayBufferView(new Float64Array(1)),
    isArrayBufferView(Buffer.from("x")),
    isArrayBufferView(new DataView(new ArrayBuffer(1))),
    isArrayBufferView(new ArrayBuffer(1)),
  ],
  [true, true, true, true, false],
);
checkEqual(
  "isAnyArrayBuffer: ArrayBuffer and SharedArrayBuffer only",
  [
    isAnyArrayBuffer(new ArrayBuffer(1)),
    isAnyArrayBuffer(new SharedArrayBuffer(1)),
    isAnyArrayBuffer(new Uint8Array(1)),
  ],
  [true, true, false],
);
checkEqual(
  "isBinaryBody: either of the two",
  [
    isBinaryBody(new Uint8Array(1)),
    isBinaryBody(new DataView(new ArrayBuffer(1))),
    isBinaryBody(new SharedArrayBuffer(1)),
    isBinaryBody("bytes"),
    isBinaryBody({ length: 1 }),
  ],
  [true, true, true, false, false],
);

/** An async generator function, for the two async-iteration guards. */
async function* generate(): AsyncGenerator<number> {
  yield 1;
}
checkEqual(
  "isAsyncIterable: anything with Symbol.asyncIterator",
  [
    isAsyncIterable(generate()),
    isAsyncIterable({
      [Symbol.asyncIterator]() {
        return generate();
      },
    }),
    isAsyncIterable([1]),
    isAsyncIterable(null),
  ],
  [true, true, false, false],
);
checkEqual(
  "isAsyncGeneratorFunction: the declaration, not a running generator",
  [
    isAsyncGeneratorFunction(generate),
    isAsyncGeneratorFunction(generate()),
    isAsyncGeneratorFunction(function* sync() {}),
    isAsyncGeneratorFunction(async () => {}),
  ],
  [true, false, false, false],
);

/* ------------------------------------------------------------------ */
step("isNumeric and parseByteSize");

checkEqual(
  "isNumeric: finite numbers and numeric strings",
  [42, -1.5, "42", " 3.14 ", "-7", "1e3", "0x10"].map((value) =>
    isNumeric(value),
  ),
  [true, true, true, true, true, true, true],
);
checkEqual(
  "isNumeric: not empty, blank, NaN, Infinity or non-strings",
  [
    "",
    "   ",
    "abc",
    Number.NaN,
    Infinity,
    "Infinity",
    null,
    undefined,
    true,
    [1],
  ].map((value) => isNumeric(value)),
  [false, false, false, false, false, false, false, false, false, false],
);

checkEqual(
  "parseByteSize: units are powers of 1024, case-insensitive, space allowed",
  ["1b", "1kb", "1KB", "1 mb", "2gb", "1tb", "1pb", "512"].map((value) =>
    parseByteSize(value),
  ),
  [1, 1_024, 1_024, 1_048_576, 2 * 1_024 ** 3, 1_024 ** 4, 1_024 ** 5, 512],
);
checkEqual(
  "parseByteSize: fractional strings are floored",
  [parseByteSize("1.5kb"), parseByteSize("0.1b")],
  [1_536, 0],
);
checkEqual(
  "parseByteSize: a finite non-negative number is returned as-is (not floored)",
  [parseByteSize(0), parseByteSize(1.5), parseByteSize(10_000)],
  [0, 1.5, 10_000],
);
checkEqual(
  "parseByteSize: unparseable or negative is undefined",
  [
    parseByteSize(-1),
    parseByteSize(Number.NaN),
    parseByteSize(Infinity),
    parseByteSize("-1kb"),
    parseByteSize("1kib"),
    parseByteSize("kb"),
    parseByteSize(""),
  ],
  [undefined, undefined, undefined, undefined, undefined, undefined, undefined],
);

/* ------------------------------------------------------------------ */
step("keys / values / first / flattenDeep / each / lastIndexOf");

checkEqual(
  "keys and values: own enumerable, [] for null/undefined",
  [
    keys({ a: 1, b: 2 }),
    keys(null),
    keys("ab"),
    values({ a: 1, b: 2 }),
    values(undefined),
  ],
  [["a", "b"], [], ["0", "1"], [1, 2], []],
);
checkEqual(
  "first: any array-like; undefined when empty or nullish",
  [first([3, 4]), first("xy"), first([]), first(null), first(undefined)],
  [3, "x", undefined, undefined, undefined],
);
checkEqual(
  "flattenDeep: every level",
  flattenDeep([1, [2, [3, [4, [5]]]], []]),
  [1, 2, 3, 4, 5],
);

const visits: ([number, number] | [string, string] | string)[] = [];
each([10, 20], (value, index) => {
  visits.push([index, value]);
});
each({ a: "x", b: "y" }, (value, key) => {
  visits.push([key, value]);
});
each(undefined, () => {
  visits.push("never");
});
checkEqual(
  "each: arrays by index, objects by key, nullish not at all",
  visits,
  [
    [0, 10],
    [1, 20],
    ["a", "x"],
    ["b", "y"],
  ],
);
checkEqual(
  "lastIndexOf: arrays and strings; -1 when absent",
  [lastIndexOf([1, 2, 1], 1), lastIndexOf("ababa", "ba"), lastIndexOf([1], 9)],
  [2, 3, -1],
);

/* ------------------------------------------------------------------ */
step("get / set / unset");

const tree = { a: { b: [{ c: 5 }], nil: null, zero: 0 } };
checkEqual(
  "get: dotted, bracket and array paths",
  [get(tree, "a.b[0].c"), get(tree, "a.b.0.c"), get(tree, ["a", "b", 0, "c"])],
  [5, 5, 5],
);
checkEqual(
  "get: the default replaces only undefined",
  [
    get(tree, "a.missing.deep", "d"),
    get(undefined, "a", "d"),
    get(tree, "a.nil", "d"),
    get(tree, "a.zero", "d"),
  ],
  ["d", "d", null, 0],
);
checkEqual("get: an empty path is the object itself", get(tree, ""), tree);

const target: Record<string, JsonValue> = { keep: 1, scalar: 5 };
set(target, "x.y.z", 1);
set(target, ["arr", 0, "name"], "first");
set(target, "str[0].name", "string path");
set(target, "scalar.inner", true); // a primitive in the way is replaced
checkEqual(
  "set: creates containers — an array only for a numeric array-path segment",
  target,
  {
    keep: 1,
    scalar: { inner: true },
    x: { y: { z: 1 } },
    arr: [{ name: "first" }],
    str: { 0: { name: "string path" } },
  },
);
check(
  "set: returns the same object",
  set(target, "keep", 2) === target && target.keep === 2,
);
checkEqual("set: an empty path changes nothing", set({ a: 1 }, "", 2), {
  a: 1,
});

const removable: Record<string, number> = { a: 1, b: 2 };
checkEqual(
  "unset: true for an object (even a missing key), false otherwise",
  [
    unset(removable, "a"),
    unset(removable, "zzz"),
    unset(null, "a"),
    unset(5, "a"),
  ],
  [true, true, false, false],
);
checkEqual("unset: the key is gone", removable, { b: 2 });

/* ------------------------------------------------------------------ */
step("pick / omit / merge / orderBy");

const record = { id: 1, name: "Ada", secret: "x" };
checkEqual(
  "pick: listed keys that exist",
  pick(record, ["id", "name", "nope"]),
  {
    id: 1,
    name: "Ada",
  },
);
checkEqual("omit: every other own key", omit(record, ["secret", "nope"]), {
  id: 1,
  name: "Ada",
});
checkEqual(
  "pick and omit: {} for nullish",
  [pick(null, ["a"]), omit(undefined, ["a"])],
  [{}, {}],
);
check(
  "pick uses `in`, so an inherited key is picked too",
  typeof pick({}, ["toString"]).toString === "function",
);
checkEqual(
  "omit and pick are shallow: a dotted name is just a key",
  omit({ a: { b: 1 } }, ["a.b"]),
  { a: { b: 1 } },
);

const date = new Date(0);
const base = { a: { x: 1, list: [1, 2, 3] }, keep: "k" };
const mergedResult = merge(base, { a: { y: 2, list: [undefined, 20] } }, null, {
  keep: undefined,
  when: date,
});
checkEqual(
  "merge: deep, arrays by index, undefined skipped, null sources ignored",
  mergedResult,
  { a: { x: 1, y: 2, list: [1, 20, 3] }, keep: "k", when: date },
);
check(
  "merge: mutates and returns the target; a Date is assigned by reference",
  mergedResult === base && (mergedResult as { when?: Date }).when === date,
);
const scalarUnder: { a: number | { b: number } } = { a: 1 };
checkEqual(
  "merge: a plain object over a scalar replaces it",
  merge(scalarUnder, { a: { b: 2 } }),
  { a: { b: 2 } },
);

const rows = [
  { g: 2, s: 1, id: "a" },
  { g: 1, s: 5, id: "b" },
  { g: 1, s: 9, id: "c" },
  { g: 1, s: 5, id: "d" },
];
checkEqual(
  "orderBy: several keys and directions, stable on ties",
  orderBy(rows, [(row) => row.g, (row) => row.s], ["asc", "desc"]).map(
    (row) => row.id,
  ),
  ["c", "b", "d", "a"],
);
checkEqual(
  "orderBy: a missing direction is asc; the input is untouched",
  [
    orderBy(rows, [(row) => row.s], []).map((row) => row.id),
    rows.map((row) => row.id),
  ],
  [
    ["a", "b", "d", "c"],
    ["a", "b", "c", "d"],
  ],
);

/* ------------------------------------------------------------------ */
step("cloneDeep and jsonClone");

/** A class instance, to see what each clone keeps. */
class Money {
  /** Minor units. */
  cents = 100;
}
const original = {
  when: new Date(0),
  map: new Map([["k", 1]]),
  set: new Set([1]),
  money: new Money(),
  nested: { n: 1 },
};
const structured = cloneDeep(original);
check(
  "cloneDeep: independent, Date/Map/Set preserved",
  structured !== original &&
    structured.nested !== original.nested &&
    structured.when instanceof Date &&
    structured.map.get("k") === 1 &&
    structured.set.has(1),
);
/** The cloned instance, typed by shape so `instanceof` cannot narrow it away. */
const clonedMoney: { cents: number } = structured.money;
check(
  "cloneDeep: a class instance comes back a plain object",
  !(clonedMoney instanceof Money) && clonedMoney.cents === 100,
);
/** An object that refers to itself. */
interface Cyclic {
  /** The object itself, once the cycle is closed. */
  self?: Cyclic;
}
const cyclic: Cyclic = {};
cyclic.self = cyclic;
check("cloneDeep: cycles survive", cloneDeep(cyclic).self?.self !== undefined);
checkEqual(
  "cloneDeep: a function throws DataCloneError",
  nameOf(thrown(() => cloneDeep({ fn: () => 1 }))),
  "DataCloneError",
);

checkEqual(
  "jsonClone: what JSON gives back",
  jsonClone({
    a: undefined,
    at: new Date("2020-01-01T00:00:00.000Z"),
    m: new Map([["a", 1]]),
    fn: () => 1,
    custom: { toJSON: () => "custom" },
    // No cast: `jsonClone` returns `Jsonify<T>`, so the compiler already
    // knows `at` is a string, `m` an empty object and `fn` gone.
  }),
  { at: "2020-01-01T00:00:00.000Z", m: {}, custom: "custom" },
);
// The one loss the type cannot show: `NaN` still types as `number`, while the
// wire carries `null` — so this check reads the wire.
checkEqual(
  "jsonClone: NaN is null on the wire",
  JSON.stringify(jsonClone({ nan: Number.NaN })),
  '{"nan":null}',
);
checkEqual(
  "jsonClone: undefined and a bare function are undefined",
  [jsonClone(undefined), jsonClone(() => 1)],
  [undefined, undefined],
);
await checkRejects("jsonClone: a BigInt", () => jsonClone({ id: 1n }), {
  name: "TypeError",
});
await checkRejects("jsonClone: a cycle", () => jsonClone(cyclic), {
  name: "TypeError",
});

/* ------------------------------------------------------------------ */
step("ucwords / encodeUrl / toHttpDate / isDateValid");

checkEqual(
  "ucwords: after start, whitespace or hyphen; ASCII lower-case only; rest untouched",
  [
    "content-type",
    "hello world",
    "x-REQUEST-id",
    "snake_case",
    "élan vital",
    "\ttab",
  ].map((text) => ucwords(text)),
  [
    "Content-Type",
    "Hello World",
    "X-REQUEST-Id",
    "Snake_case",
    "élan Vital",
    "\tTab",
  ],
);

checkEqual(
  "encodeUrl: encodes unsafe characters, keeps valid escapes and reserved ones",
  [
    encodeUrl("/foo bar"),
    encodeUrl("/foo%20bar"),
    encodeUrl("/100%"),
    encodeUrl("/%zz"),
    encodeUrl("/café"),
    encodeUrl("/a?b=c&d=[1]#frag"),
    encodeUrl('<tag>"quote"'),
  ],
  [
    "/foo%20bar",
    "/foo%20bar",
    "/100%25",
    "/%25zz",
    "/caf%C3%A9",
    "/a?b=c&d=[1]#frag",
    "%3Ctag%3E%22quote%22",
  ],
);
checkEqual(
  "encodeUrl: a lone surrogate becomes U+FFFD, as encodeurl does",
  outcome(() => encodeUrl("/\uD800")),
  "/%EF%BF%BD",
);

checkEqual(
  "toHttpDate: RFC 7231 form",
  toHttpDate(new Date(Date.UTC(2026, 2, 10, 9, 5, 7))),
  "Tue, 10 Mar 2026 09:05:07 GMT",
);
checkEqual(
  "toHttpDate: an invalid date",
  toHttpDate(new Date("nope")),
  "Invalid Date",
);
checkEqual(
  "isDateValid",
  [
    isDateValid(new Date(0)),
    isDateValid(new Date("nope")),
    isDateValid("2020-01-01"), // not a Date at all: the guard answers false
  ],
  [true, false, false],
);

/* ------------------------------------------------------------------ */
step("etag");

const helloTag = etag("hello world");
checkEqual(
  "etag: the same for every holder of the same bytes",
  [
    etag(Buffer.from("hello world")),
    etag(new TextEncoder().encode("hello world")),
    etag(new DataView(new TextEncoder().encode("hello world").buffer)),
    etag(new TextEncoder().encode("hello world").buffer),
    eTag("hello world"),
  ],
  [helloTag, helloTag, helloTag, helloTag, helloTag],
);
const shared = new SharedArrayBuffer(11);
new Uint8Array(shared).set(new TextEncoder().encode("hello world"));
checkEqual("etag: a SharedArrayBuffer", etag(shared), helloTag);
check(
  "etag: quoted, strong, byte length in hex first",
  /^"b-[0-9a-f]+"$/.test(helloTag) && etag("é").startsWith('"2-'),
  { helloTag, accent: etag("é") },
);
checkEqual(
  "etag: only a view's window counts",
  etag(new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4)),
  etag(new Uint8Array([2, 3, 4])),
);
checkEqual(
  "etag: the empty entity",
  [etag(""), etag(new Uint8Array(0))],
  ['"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"', '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'],
);
check("etag: different content, different tag", etag("a") !== etag("b"));

/* ------------------------------------------------------------------ */
step("fresh");

const lastModified = "Thu, 01 Jan 2026 00:00:00 GMT";
const resHeaders = { etag: '"abc"', "last-modified": lastModified };
checkEqual(
  "fresh: If-None-Match",
  [
    fresh({ "if-none-match": '"abc"' }, resHeaders),
    fresh({ "if-none-match": '"xyz"' }, resHeaders),
    fresh({ "if-none-match": '"xyz", "abc"' }, resHeaders),
    fresh({ "if-none-match": ['"xyz"', '"abc"'] }, resHeaders),
    fresh({ "if-none-match": 'W/"abc"' }, resHeaders),
    fresh({ "if-none-match": '"abc"' }, { etag: 'W/"abc"' }),
    fresh({ "if-none-match": '"abc"' }, {}),
    fresh({ "if-none-match": "*" }, {}),
  ],
  [true, false, true, true, true, true, false, true],
);
checkEqual(
  "fresh: If-Modified-Since",
  [
    fresh({ "if-modified-since": lastModified }, resHeaders),
    fresh({ "if-modified-since": "Fri, 02 Jan 2026 00:00:00 GMT" }, resHeaders),
    fresh({ "if-modified-since": "Wed, 31 Dec 2025 00:00:00 GMT" }, resHeaders),
    fresh({ "if-modified-since": lastModified }, {}),
  ],
  [true, true, false, false],
);
checkEqual(
  "fresh: both must pass; no-cache and no conditionals are never fresh",
  [
    fresh(
      {
        "if-none-match": '"abc"',
        "if-modified-since": "Wed, 31 Dec 2025 00:00:00 GMT",
      },
      resHeaders,
    ),
    fresh(
      { "if-none-match": '"abc"', "cache-control": "max-age=0, no-cache" },
      resHeaders,
    ),
    fresh(
      { "if-none-match": '"abc"', "cache-control": ["public", "no-cache"] },
      resHeaders,
    ),
    fresh(
      { "if-none-match": '"abc"', "cache-control": "no-store" },
      resHeaders,
    ),
    fresh({}, resHeaders),
  ],
  [false, false, false, true, false],
);

/* ------------------------------------------------------------------ */
step("rangeParser and combineRanges");

/** A parser result, with the array's `type` made comparable. */
function describeRanges(
  result: RangeParserResult,
): -1 | -2 | { type: string; ranges: Range[] } {
  return Array.isArray(result)
    ? { type: result.type, ranges: [...result] }
    : result;
}

checkEqual(
  "rangeParser: forms of a range",
  [
    describeRanges(rangeParser(1_000, "bytes=0-499")),
    describeRanges(rangeParser(1_000, "bytes=-200")),
    describeRanges(rangeParser(1_000, "bytes=900-")),
    describeRanges(rangeParser(1_000, "bytes=0-5000")),
    describeRanges(rangeParser(1_000, "items=0-1,4-5")),
  ],
  [
    { type: "bytes", ranges: [{ start: 0, end: 499 }] },
    { type: "bytes", ranges: [{ start: 800, end: 999 }] },
    { type: "bytes", ranges: [{ start: 900, end: 999 }] },
    { type: "bytes", ranges: [{ start: 0, end: 999 }] },
    {
      type: "items",
      ranges: [
        { start: 0, end: 1 },
        { start: 4, end: 5 },
      ],
    },
  ],
);
checkEqual(
  "rangeParser: an unsatisfiable range among good ones is dropped",
  describeRanges(rangeParser(1_000, "bytes=0-1,5000-6000")),
  { type: "bytes", ranges: [{ start: 0, end: 1 }] },
);
checkEqual(
  "rangeParser: -2 for no '=', -1 when nothing is satisfiable",
  [
    rangeParser(1_000, "nonsense"),
    rangeParser(1_000, "bytes=900-100"),
    rangeParser(1_000, "bytes=1000-"),
    rangeParser(0, "bytes=0-"),
    rangeParser(1_000, "bytes=-0"),
  ],
  [-2, -1, -1, -1, -1],
);
checkEqual(
  "rangeParser: an unreadable range is skipped, so nothing is satisfiable: -1 (as range-parser does)",
  rangeParser(1_000, "bytes=abc"),
  -1,
);
checkEqual(
  "rangeParser combine: overlapping and adjacent merge, request order kept",
  describeRanges(
    rangeParser(1_000, "bytes=20-29,0-4,3-9,10-12", { combine: true }),
  ),
  {
    type: "bytes",
    ranges: [
      { start: 20, end: 29 },
      { start: 0, end: 12 },
    ],
  },
);
checkEqual(
  "rangeParser combine: false leaves them as asked",
  describeRanges(rangeParser(1_000, "bytes=0-4,5-9", { combine: false })),
  {
    type: "bytes",
    ranges: [
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ],
  },
);
checkEqual(
  "combineRanges: directly, type kept, a range inside another absorbed",
  describeRanges(
    combineRanges(
      Object.assign(
        [
          { start: 50, end: 60 },
          { start: 0, end: 100 },
          { start: 200, end: 210 },
        ],
        { type: "bytes" },
      ),
    ),
  ),
  {
    type: "bytes",
    ranges: [
      { start: 0, end: 100 },
      { start: 200, end: 210 },
    ],
  },
);
checkEqual(
  "combineRanges: gaps of one byte or more stay separate",
  describeRanges(
    combineRanges(
      Object.assign(
        [
          { start: 0, end: 4 },
          { start: 6, end: 9 },
        ],
        { type: "bytes" },
      ),
    ),
  ),
  {
    type: "bytes",
    ranges: [
      { start: 0, end: 4 },
      { start: 6, end: 9 },
    ],
  },
);

/* ------------------------------------------------------------------ */
step("appendVary (and vary)");

checkEqual(
  "appendVary: appends, de-duplicates case-insensitively, keeps first casing",
  [
    appendVary("", "Accept"),
    appendVary("Accept", "Accept-Encoding"),
    appendVary("Accept", "accept"),
    appendVary("accept", ["Origin", "ACCEPT", "Origin"]),
    appendVary("Accept", "Origin, User-Agent"),
    vary("", ["A", "B"]),
  ],
  [
    "Accept",
    "Accept, Accept-Encoding",
    "Accept",
    "accept, Origin",
    "Accept, Origin, User-Agent",
    "A, B",
  ],
);
checkEqual(
  "appendVary: * wins either way",
  [
    appendVary("Accept", "*"),
    appendVary("*", "Accept"),
    appendVary("Accept, *", "Origin"),
  ],
  ["*", "*", "*"],
);
await checkRejects(
  "appendVary: an invalid field name",
  () => appendVary("", "bad header"),
  {
    name: "TypeError",
    message: /field argument contains an invalid header name/,
  },
);
await checkRejects(
  "appendVary: validated even when current is *",
  () => appendVary("*", ["ok", "no good"]),
  { name: "TypeError" },
);

/* ------------------------------------------------------------------ */
step("Cookies");

/** The `; `-separated parts of a Set-Cookie value. */
function cookieParts(header: string): string[] {
  return header.split("; ");
}

checkEqual(
  "parseCookie: values are percent-decoded",
  parseCookie("a=1; b=hello%20world"),
  { a: "1", b: "hello world" },
);
checkEqual("parseCookie: an empty header", parseCookie(""), {});
checkEqual(
  "parseCookie: options.decode is not applied (documented)",
  parseCookie("a=x", { decode: (value) => value.toUpperCase() }),
  { a: "x" },
);

const defaultParts = cookieParts(serializeCookie("theme", "dark"));
check(
  "serializeCookie: Bun's Path=/ and SameSite=Lax defaults",
  defaultParts[0] === "theme=dark" &&
    defaultParts.includes("Path=/") &&
    defaultParts.includes("SameSite=Lax"),
  defaultParts,
);

const expires = new Date("2030-01-01T00:00:00Z");
const everyOption = cookieParts(
  serializeCookie("session", "abc", {
    domain: "example.com",
    path: "/app",
    expires,
    maxAge: 3_600.9,
    httpOnly: true,
    secure: true,
    partitioned: true,
    sameSite: "none",
    priority: "high",
  }),
);
for (const part of [
  "session=abc",
  "Domain=example.com",
  "Path=/app",
  `Expires=${toHttpDate(expires)}`,
  "Max-Age=3600", // floored
  "HttpOnly",
  "Secure",
  "Partitioned",
  "SameSite=None",
]) {
  check(
    `serializeCookie: every option → ${part}`,
    everyOption.includes(part),
    everyOption,
  );
}
checkEqual(
  "serializeCookie: Priority is appended last",
  everyOption.at(-1),
  "Priority=High",
);

checkEqual(
  "serializeCookie: sameSite true/strict/lax",
  [
    cookieParts(serializeCookie("a", "1", { sameSite: true })).includes(
      "SameSite=Strict",
    ),
    cookieParts(serializeCookie("a", "1", { sameSite: "strict" })).includes(
      "SameSite=Strict",
    ),
    cookieParts(serializeCookie("a", "1", { sameSite: "lax" })).includes(
      "SameSite=Lax",
    ),
  ],
  [true, true, true],
);
check(
  "serializeCookie: sameSite false omits SameSite, as the cookie package does",
  !cookieParts(serializeCookie("a", "1", { sameSite: false })).some((part) =>
    part.startsWith("SameSite"),
  ),
  serializeCookie("a", "1", { sameSite: false }),
);
checkEqual(
  "serializeCookie: priority low and medium",
  [
    serializeCookie("a", "1", { priority: "low" }).endsWith("; Priority=Low"),
    serializeCookie("a", "1", { priority: "medium" }).endsWith(
      "; Priority=Medium",
    ),
  ],
  [true, true],
);
check(
  "serializeCookie: path '' leaves Path for the browser to set",
  !cookieParts(serializeCookie("a", "1", { path: "" })).some((part) =>
    part.startsWith("Path="),
  ),
  serializeCookie("a", "1", { path: "" }),
);
checkEqual(
  "serializeCookie: values are percent-encoded; options.encode is not applied (documented)",
  parseCookie(
    cookieParts(
      serializeCookie("a", "x y;z", { encode: (value) => value.toUpperCase() }),
    )[0]!,
  ),
  { a: "x y;z" },
);

const signed = signCookie("user.42", "s3cr3t");
check(
  "signCookie: value, a dot, unpadded base64 HMAC-SHA256",
  /^user\.42\.[A-Z0-9+/]{43}$/i.test(signed),
  signed,
);
checkEqual(
  "unsignCookie",
  [
    unsignCookie(signed, "s3cr3t"), // a value containing dots is fine
    unsignCookie(signed, "wrong"),
    unsignCookie(signed.replace("42", "43"), "s3cr3t"),
    unsignCookie("no-dot", "s3cr3t"),
    unsignCookie(`${signed}x`, "s3cr3t"),
  ],
  ["user.42", false, false, false, false],
);

const cookieInput: Record<string, string> = {
  a: 'j:{"x":1}',
  b: "plain",
  c: "j:not json",
  d: "j:null",
  e: "j:[1,2]",
};
const parsedCookies = jsonCookies(cookieInput);
checkEqual(
  "jsonCookies: j: values parsed; bad JSON and falsy results (j:null) left raw, as in cookie-parser",
  parsedCookies,
  { a: { x: 1 }, b: "plain", c: "j:not json", d: "j:null", e: [1, 2] },
);
// `cookieInput` is still typed as strings; parsing in place made `a` JSON.
checkEqual<[boolean, JsonValue]>(
  "jsonCookies: parses in place and returns the same object, as documented",
  [parsedCookies === cookieInput, cookieInput.a],
  [true, { x: 1 }],
);

const jar: Record<string, string> = {
  current: `s:${signCookie("v1", "new")}`,
  rotated: `s:${signCookie("v2", "old")}`,
  forged: "s:admin.bad",
  plain: "kept",
};
checkEqual(
  "extractSignedCookies: verified against any of the secrets, in order",
  extractSignedCookies(jar, ["new", "old"]),
  { current: "v1", rotated: "v2" },
);
checkEqual(
  "extractSignedCookies: verified entries removed; forgeries and plain cookies stay",
  jar,
  {
    forged: "s:admin.bad",
    plain: "kept",
  },
);
checkEqual(
  "extractSignedCookies: no secrets, nothing verified",
  extractSignedCookies({ a: `s:${signCookie("x", "k")}` }, []),
  {},
);

check(
  "cookie / cookieSignature / cookieParser are the same functions",
  cookie.parse === parseCookie &&
    cookie.serialize === serializeCookie &&
    cookieSignature.sign === signCookie &&
    cookieSignature.unsign === unsignCookie &&
    cookieParser.JSONCookies === jsonCookies &&
    cookieParser.signedCookies === extractSignedCookies &&
    vary === appendVary &&
    eTag === etag,
);

/* ------------------------------------------------------------------ */
step("accepts, typeIs, mime, getMimeFromStr, isMime");

checkEqual(
  "accepts and typeIs: the packages' callable functions",
  [typeof accepts, typeof typeIs],
  ["function", "function"],
);
// Both packages read only `headers`, and bun-common types them that way
// (`RequestHeadersLike`): a plain header object needs no cast.
const browser = accepts({
  headers: {
    accept: "text/html, application/json;q=0.9, */*;q=0.1",
    "accept-encoding": "gzip, br;q=0.8",
    "accept-charset": "utf-8, iso-8859-1;q=0.2",
    "accept-language": "en;q=0.8, es, pt",
  },
});
checkEqual(
  "accepts: types",
  [
    browser.types(["json", "html"]),
    browser.types(["png"]),
    browser.types(["application/json"]),
    browser.types(),
  ],
  ["html", "png", "application/json", ["text/html", "application/json", "*/*"]],
);
checkEqual(
  "accepts: no match is false; no Accept header takes the first offered",
  [
    accepts({ headers: { accept: "application/json" } }).types(["html"]),
    accepts({ headers: {} }).types(["xml", "json"]),
  ],
  [false, "xml"],
);
checkEqual(
  "accepts: encodings, charsets, languages",
  [
    browser.encodings(["br", "deflate"]),
    browser.encodings(["deflate"]),
    browser.charsets(),
    browser.charsets(["iso-8859-1"]),
    browser.languages(),
    browser.languages(["en", "fr"]),
    browser.languages(["fr"]),
  ],
  [
    "br",
    false,
    ["utf-8", "iso-8859-1"],
    "iso-8859-1",
    ["es", "pt", "en"],
    "en",
    false,
  ],
);

const jsonBody = {
  headers: {
    "content-type": "application/json; charset=utf-8",
    "content-length": "2",
  },
};
checkEqual(
  "typeIs(request, types)",
  [
    typeIs(jsonBody, ["urlencoded", "json"]),
    typeIs(jsonBody, ["application/*"]),
    typeIs(jsonBody, ["html"]),
    typeIs({ headers: { "content-type": "application/json" } }, ["json"]), // no body
    typeIs({ headers: { "content-length": "2" } }, ["json"]), // body, no type
  ],
  ["json", "application/json", false, null, false],
);
checkEqual(
  "typeIs.is / normalize / match / hasBody",
  [
    typeIs.is("text/html; charset=utf-8", ["text/*"]),
    typeIs.is("application/vnd.api+json", ["+json"]),
    typeIs.is("application/json"),
    typeIs.is("image/png", ["json", "html"]),
    ["json", "urlencoded", "multipart", "+json", "text/html"].map((type) =>
      typeIs.normalize(type),
    ),
    [
      typeIs.match("text/*", "text/html"),
      typeIs.match("*/*+json", "application/ld+json"),
      typeIs.match("text/*", "image/png"),
      typeIs.match(false, "text/html"),
    ],
    [
      typeIs.hasBody({ headers: { "content-length": "0" } }),
      typeIs.hasBody({ headers: { "transfer-encoding": "chunked" } }),
      typeIs.hasBody({ headers: {} }),
    ],
  ],
  [
    "text/html",
    "application/vnd.api+json",
    "application/json",
    false,
    [
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/*",
      "*/*+json",
      "text/html",
    ],
    [true, true, false, false],
    [true, true, false],
  ],
);

checkEqual(
  "mime.getType: a bare extension, a file name, a path without an extension",
  [
    mime.getType("json"),
    mime.getType("dir/Report.PDF"),
    mime.getType("dir/no-extension"),
    mime.getType("x.unheard-of"),
  ],
  ["application/json", "application/pdf", null, null],
);
checkEqual(
  "mime.getExtension / getAllExtensions",
  [
    mime.getExtension("text/html; charset=utf-8"),
    mime.getExtension("application/unheard-of"),
    [...(mime.getAllExtensions("image/jpeg") ?? [])],
  ],
  ["html", null, ["jpg", "jpeg", "jpe"]],
);
await checkRejects(
  "mime.define: the default instance is frozen",
  () => mime.define({ "application/x-mine": ["mine"] }),
  {
    message: /define\(\) not allowed for built-in Mime objects/,
  },
);

checkEqual(
  "isMime: a media type with a known extension",
  [
    isMime("application/json"),
    isMime("image/png"),
    isMime("TEXT/HTML"),
    isMime("json"),
    isMime("application/x-unheard-of"),
  ],
  [true, true, true, false, false],
);
checkEqual(
  "getMimeFromStr: a known media type passes through as given; anything else is looked up",
  [
    getMimeFromStr("application/json"),
    getMimeFromStr("TEXT/HTML"),
    getMimeFromStr("text/html; charset=utf-8"),
    getMimeFromStr("png"),
    getMimeFromStr("archive.tar.gz"),
    getMimeFromStr("nothing-known"),
  ],
  [
    "application/json",
    "TEXT/HTML",
    "text/html; charset=utf-8",
    "image/png",
    "application/gzip",
    null,
  ],
);

/* ------------------------------------------------------------------ */
step("createDeferred and waitUntil");

const deferred = createDeferred<number>();
queueMicrotask(() => deferred.resolve(5));
checkEqual("createDeferred: resolve", await deferred.promise, 5);
const rejected = createDeferred<number>();
rejected.reject(new Error("nope"));
await checkRejects("createDeferred: reject", () => rejected.promise, {
  message: /^nope$/,
});
const chained = createDeferred<string>();
chained.resolve(Promise.resolve("from a promise"));
checkEqual(
  "createDeferred: resolve with a PromiseLike",
  await chained.promise,
  "from a promise",
);

let counter = 0;
const counting = setInterval(() => {
  counter++;
}, 5);
checkEqual(
  "waitUntil: resolves with the value that satisfied the predicate",
  (await waitUntil(
    () => counter,
    (value) => value >= 3,
  )) >= 3,
  true,
);
clearInterval(counting);
checkEqual(
  "waitUntil: getValue may be async",
  await waitUntil(
    async () => "ready",
    (value) => value === "ready",
  ),
  "ready",
);
let polls = 0;
let started = performance.now();
await checkRejects(
  "waitUntil: rejects once timeout passes",
  () => {
    return waitUntil(
      () => {
        polls++;
        return false;
      },
      (value) => value,
      { interval: 20, timeout: 100 },
    );
  },
  { message: /^waitUntil timed out$/ },
);
const waited = performance.now() - started;
check(
  "waitUntil: interval spaces the polls (about 100ms / 20ms)",
  polls >= 3 && polls <= 10,
  { polls },
);
check(
  "waitUntil: gave up after its timeout, not long after",
  waited >= 90 && waited < 2_000,
  { waited },
);

/* ------------------------------------------------------------------ */
step("sleep and isAbortError");

started = performance.now();
await sleep(50);
check(
  "sleep: waits at least about ms",
  performance.now() - started >= 40,
  performance.now() - started,
);
started = performance.now();
await sleep(-100);
check("sleep: a negative ms is zero", performance.now() - started < 1_000);

const midWait = new AbortController();
started = performance.now();
const pendingSleep = sleep(10_000, { signal: midWait.signal });
setTimeout(() => midWait.abort(), 20);
const midWaitError = await pendingSleep.catch((error: unknown) => error);
check(
  "sleep signal: abort() mid-wait rejects promptly with an AbortError",
  isAbortError(midWaitError) &&
    nameOf(midWaitError) === "AbortError" &&
    performance.now() - started < 2_000,
  midWaitError,
);

const withReason = new AbortController();
const reason = new Error("shutting down");
withReason.abort(reason);
checkEqual(
  "sleep signal: already aborted with an Error reason rejects with that very error",
  (await sleep(10_000, { signal: withReason.signal }).catch(
    (error: unknown) => error,
  )) === reason,
  true,
);

const stringReason = new AbortController();
stringReason.abort("because");
const stringReasonError = await sleep(10_000, {
  signal: stringReason.signal,
}).catch((error: unknown) => error);
checkEqual(
  "sleep signal: a non-Error reason rejects with an Error named AbortError, the reason as its cause",
  [
    stringReasonError instanceof Error,
    nameOf(stringReasonError),
    isAbortError(stringReasonError),
    (stringReasonError as Error).cause,
  ],
  [true, "AbortError", true, "because"],
);

const timedSignal = await sleep(10_000, {
  signal: AbortSignal.timeout(20),
}).catch((error: unknown) => error);
checkEqual(
  "sleep signal: AbortSignal.timeout rejects with its TimeoutError, which is not an abort",
  [nameOf(timedSignal), isAbortError(timedSignal)],
  ["TimeoutError", false],
);

const unrefSleep = runScript(`
  import { sleep } from "@kingsleyweb/bun-common";
  console.log("scheduled");
  sleep(5000, { unref: true }).then(() => console.log("woke"));
`);
check(
  "sleep unref: true does not keep the process alive",
  unrefSleep.output === "scheduled" && unrefSleep.ms < 4_000,
  unrefSleep,
);
const refSleep = runScript(`
  import { sleep } from "@kingsleyweb/bun-common";
  sleep(200).then(() => console.log("woke"));
`);
checkEqual(
  "sleep unref: defaults to false — the process waits for it",
  refSleep.output,
  "woke",
);

const namedAbort = new Error("x");
namedAbort.name = "AbortError";
checkEqual(
  "isAbortError",
  [
    isAbortError(namedAbort),
    isAbortError(Object.assign(new Error("x"), { code: "ABORT_ERR" })),
    isAbortError({ code: 20 }),
    isAbortError({ name: "AbortError" }),
    isAbortError(new Error("x")),
    isAbortError("AbortError"),
    isAbortError(null),
  ],
  [true, true, true, true, false, false, false],
);

/* ------------------------------------------------------------------ */
step("withTimeout and TimeoutError");

checkEqual(
  "withTimeout: in time, a promise or a function (sync or async)",
  [
    await withTimeout(Promise.resolve("promise"), 1_000),
    await withTimeout(() => "sync", 1_000),
    await withTimeout(async () => "async", 1_000),
  ],
  ["promise", "sync", "async"],
);
checkEqual(
  "withTimeout: ms <= 0 (or NaN) means no timeout",
  [
    await withTimeout(
      sleep(30).then(() => 0),
      0,
    ),
    await withTimeout(
      sleep(30).then(() => -1),
      -1,
    ),
    await withTimeout(
      sleep(30).then(() => "nan"),
      Number.NaN,
    ),
  ],
  [0, -1, "nan"],
);
await checkRejects(
  "withTimeout: the work's own rejection passes through",
  () => withTimeout(Promise.reject(new Error("own")), 1_000),
  {
    message: /^own$/,
  },
);

const events: string[] = [];
const timeoutError = await checkRejects(
  "withTimeout: a TimeoutError with the default message",
  () => {
    return withTimeout(sleep(5_000, { unref: true }), 30, {
      onTimeout: () => {
        events.push("onTimeout");
      },
    }).catch((error: unknown) => {
      events.push("rejected");
      throw error;
    });
  },
  { name: "TimeoutError", message: /^Timed out after 30ms$/ },
);
check(
  "TimeoutError: instanceof, with ms",
  timeoutError instanceof TimeoutError &&
    (timeoutError as TimeoutError).ms === 30,
);
checkEqual("withTimeout onTimeout: called once, before the rejection", events, [
  "onTimeout",
  "rejected",
]);
await checkRejects(
  "withTimeout message: replaces the default",
  () =>
    withTimeout(sleep(5_000, { unref: true }), 20, {
      message: "report too slow",
    }),
  { name: "TimeoutError", message: /^report too slow$/ },
);
checkEqual(
  "TimeoutError: constructed directly",
  [
    new TimeoutError(5).message,
    new TimeoutError(5, "custom").message,
    new TimeoutError(5).name,
    new TimeoutError(5).ms,
  ],
  ["Timed out after 5ms", "custom", "TimeoutError", 5],
);

const unhandled: unknown[] = [];
/** Records a rejection nobody handled. */
function onUnhandled(rejection: unknown): void {
  unhandled.push(rejection);
}
process.on("unhandledRejection", onUnhandled);
const lateRejection = sleep(40).then(() => {
  throw new Error("too late");
});
await withTimeout(lateRejection, 10).catch(() => {});
await sleep(80);
process.off("unhandledRejection", onUnhandled);
checkEqual(
  "withTimeout: a rejection after the timeout never goes unhandled",
  unhandled,
  [],
);

let syncOutcome: string;
try {
  syncOutcome = await withTimeout(() => {
    throw new Error("sync");
  }, 100).then(
    () => "resolved",
    () => "rejected",
  );
} catch {
  syncOutcome = "threw synchronously";
}
checkEqual(
  "withTimeout: a function that throws synchronously still rejects",
  syncOutcome,
  "rejected",
);

const unrefDefault = runScript(`
  import { withTimeout } from "@kingsleyweb/bun-common";
  withTimeout(new Promise(() => {}), 5000).catch((error) => console.log(error.name));
`);
check(
  "withTimeout unref: defaults to true — the timer alone does not hold the process",
  unrefDefault.output === "" && unrefDefault.ms < 4_000,
  unrefDefault,
);
const refTimeout = runScript(`
  import { withTimeout } from "@kingsleyweb/bun-common";
  withTimeout(new Promise(() => {}), 200, { unref: false }).catch((error) => console.log(error.name));
`);
checkEqual(
  "withTimeout unref: false — the process waits and sees the timeout",
  refTimeout.output,
  "TimeoutError",
);

/* ------------------------------------------------------------------ */
step("computeBackoff");

/** Many draws of one backoff, for the random strategies. */
function draws(
  attempt: number,
  options: Parameters<typeof computeBackoff>[1],
  count = 300,
): number[] {
  return Array.from({ length: count }, () => computeBackoff(attempt, options));
}

checkEqual(
  "computeBackoff: defaults — fixed, 1000ms",
  [computeBackoff(1), computeBackoff(7), computeBackoff(3, {})],
  [1_000, 1_000, 1_000],
);
checkEqual(
  "computeBackoff: a number is { type: fixed, delay }",
  [computeBackoff(1, 250), computeBackoff(9, 250)],
  [250, 250],
);
checkEqual(
  "type fixed",
  [1, 2, 5].map((attempt) =>
    computeBackoff(attempt, { type: "fixed", delay: 100 }),
  ),
  [100, 100, 100],
);
checkEqual(
  "type exponential: delay × factor^(n-1), factor defaults to 2",
  [
    [1, 2, 3, 4].map((attempt) =>
      computeBackoff(attempt, { type: "exponential", delay: 100 }),
    ),
    [1, 2, 3].map((attempt) =>
      computeBackoff(attempt, { type: "exponential", delay: 100, factor: 3 }),
    ),
  ],
  [
    [100, 200, 400, 800],
    [100, 300, 900],
  ],
);
checkEqual(
  "type linear: delay × n",
  [1, 2, 3, 10].map((attempt) =>
    computeBackoff(attempt, { type: "linear", delay: 100 }),
  ),
  [100, 200, 300, 1_000],
);
checkEqual(
  "type fibonacci: delay × 1, 1, 2, 3, 5, 8, 13",
  [1, 2, 3, 4, 5, 6, 7].map((attempt) =>
    computeBackoff(attempt, { type: "fibonacci", delay: 100 }),
  ),
  [100, 100, 200, 300, 500, 800, 1_300],
);
checkEqual(
  "max: caps every deterministic strategy, even past overflow",
  [
    computeBackoff(10, { type: "exponential", delay: 100, max: 1_000 }),
    computeBackoff(50, { type: "linear", delay: 100, max: 1_000 }),
    computeBackoff(5_000, { type: "fibonacci", delay: 100, max: 60_000 }),
    computeBackoff(1, { type: "fixed", delay: 5_000, max: 10 }),
  ],
  [1_000, 1_000, 60_000, 10],
);
checkEqual(
  "attempt: floored, and anything below 1 counts as 1",
  [
    computeBackoff(2.9, { type: "linear", delay: 100 }),
    computeBackoff(0, { type: "linear", delay: 100 }),
    computeBackoff(-5, { type: "exponential", delay: 100 }),
  ],
  [200, 100, 100],
);
checkEqual(
  "a negative delay is never below zero",
  computeBackoff(1, { delay: -50 }),
  0,
);
checkEqual(
  "jitter 0 and false: none",
  [
    computeBackoff(1, { delay: 100, jitter: 0 }),
    computeBackoff(1, { delay: 100, jitter: false }),
  ],
  [100, 100],
);

const jitterTrue = draws(1, { delay: 1_000, jitter: true });
check(
  "jitter true: ±10%",
  jitterTrue.every((ms) => ms >= 900 && ms <= 1_100) &&
    new Set(jitterTrue).size > 1,
  {
    min: Math.min(...jitterTrue),
    max: Math.max(...jitterTrue),
  },
);
const jitterHalf = draws(3, { type: "exponential", delay: 100, jitter: 0.5 });
check(
  "jitter 0.5 on exponential: 400ms ±50%",
  jitterHalf.every((ms) => ms >= 200 && ms <= 600),
  {
    min: Math.min(...jitterHalf),
    max: Math.max(...jitterHalf),
  },
);
const aboveMax = draws(1, { delay: 1_000, max: 500, jitter: 0.5 });
check(
  "jitter is applied after max, so it may sit above max (documented), never below zero",
  aboveMax.every((ms) => ms >= 250 && ms <= 750) &&
    aboveMax.some((ms) => ms > 500),
  { min: Math.min(...aboveMax), max: Math.max(...aboveMax) },
);

const fullJitter = draws(
  4,
  { type: "full-jitter", delay: 100, factor: 2 },
  400,
);
check(
  "type full-jitter: anywhere in [0, exponential delay], spread across it",
  fullJitter.every((ms) => ms >= 0 && ms <= 800) &&
    fullJitter.some((ms) => ms < 200) &&
    fullJitter.some((ms) => ms > 600),
  { min: Math.min(...fullJitter), max: Math.max(...fullJitter) },
);
check(
  "type full-jitter: factor and max apply; jitter does not",
  draws(3, { type: "full-jitter", delay: 100, factor: 3, jitter: 5 }).every(
    (ms) => ms <= 900,
  ) &&
    draws(20, { type: "full-jitter", delay: 100, max: 500 }).every(
      (ms) => ms <= 500,
    ),
);

const decorrelatedFirst = draws(
  1,
  { type: "decorrelated-jitter", delay: 100, max: 10_000 },
  400,
);
const decorrelatedTenth = draws(
  10,
  { type: "decorrelated-jitter", delay: 100, max: 10_000 },
  400,
);
/** The arithmetic mean. */
function mean(numbers: number[]): number {
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}
check(
  "type decorrelated-jitter: never below delay, never above max; one step at most 3× delay",
  [...decorrelatedFirst, ...decorrelatedTenth].every(
    (ms) => ms >= 100 && ms <= 10_000,
  ) && Math.max(...decorrelatedFirst) <= 300,
  { firstMax: Math.max(...decorrelatedFirst) },
);
check(
  "type decorrelated-jitter: grows with the attempt",
  mean(decorrelatedTenth) > mean(decorrelatedFirst) * 3,
  { first: mean(decorrelatedFirst), tenth: mean(decorrelatedTenth) },
);
check(
  "type decorrelated-jitter: factor and jitter do not apply",
  draws(1, {
    type: "decorrelated-jitter",
    delay: 100,
    factor: 50,
    jitter: 5,
  }).every((ms) => ms >= 100 && ms <= 300),
);

/* ------------------------------------------------------------------ */
step("retry");

let calls = 0;
await checkRejects(
  "attempts: defaults to 3, and the last error is rethrown",
  () => {
    return retry(
      (attempt) => {
        calls++;
        throw new Error(`attempt ${attempt}`);
      },
      { backoff: 1 },
    );
  },
  { message: /^attempt 3$/ },
);
checkEqual("attempts default: 3 calls", calls, 3);

/** How many times `retry` calls a function that always fails, given `attempts`. */
async function callsFor(attempts: number): Promise<number> {
  let count = 0;
  await retry(
    () => {
      count++;
      throw new Error("x");
    },
    { attempts, backoff: 1 },
  ).catch(() => {});
  return count;
}
checkEqual(
  "attempts: floored, at least 1",
  [
    await callsFor(0),
    await callsFor(-3),
    await callsFor(2.7),
    await callsFor(5),
  ],
  [1, 1, 2, 5],
);

const seenArgs: [number, boolean][] = [];
const retrySignal = new AbortController().signal;
checkEqual(
  "fn: receives the 1-based attempt and the signal; the first success is returned",
  await retry(
    (attempt, signal) => {
      seenArgs.push([attempt, signal === retrySignal]);
      if (attempt < 2) {
        throw new Error("once");
      }
      return "ok";
    },
    { backoff: 1, signal: retrySignal },
  ),
  "ok",
);
checkEqual("fn arguments", seenArgs, [
  [1, true],
  [2, true],
]);

started = performance.now();
const defaultDelays: number[] = [];
await retry(
  (attempt) => {
    if (attempt === 1) {
      throw new Error("first");
    }
    return attempt;
  },
  {
    attempts: 2,
    onRetry: (_error, _attempt, delayMs) => {
      defaultDelays.push(delayMs);
    },
  },
);
check(
  "backoff: defaults to fixed 1000ms",
  defaultDelays[0] === 1_000 && performance.now() - started >= 900,
  { defaultDelays, elapsed: performance.now() - started },
);

const onRetryCalls: [string, number, number][] = [];
await retry(
  (attempt) => {
    throw new Error(`e${attempt}`);
  },
  {
    attempts: 4,
    backoff: { type: "exponential", delay: 2, factor: 3 },
    onRetry: (error, attempt, delayMs) => {
      onRetryCalls.push([(error as Error).message, attempt, delayMs]);
    },
  },
).catch(() => {});
checkEqual(
  "onRetry: before each wait, with the error, the attempt and the computed delay — not after the last",
  onRetryCalls,
  [
    ["e1", 1, 2],
    ["e2", 2, 6],
    ["e3", 3, 18],
  ],
);

const shouldRetryCalls: [string, number][] = [];
let fatalCalls = 0;
await checkRejects(
  "shouldRetry: false stops at once with that error",
  () => {
    return retry(
      (attempt) => {
        fatalCalls++;
        throw new Error(attempt === 2 ? "fatal" : "transient");
      },
      {
        attempts: 10,
        backoff: 1,
        shouldRetry: (error, attempt) => {
          shouldRetryCalls.push([(error as Error).message, attempt]);
          return (error as Error).message !== "fatal";
        },
      },
    );
  },
  { message: /^fatal$/ },
);
checkEqual(
  "shouldRetry: receives the error and attempt",
  [fatalCalls, shouldRetryCalls],
  [
    2,
    [
      ["transient", 1],
      ["fatal", 2],
    ],
  ],
);

const preAborted = new AbortController();
preAborted.abort();
let preAbortedCalls = 0;
const preAbortedError = await retry(
  () => {
    preAbortedCalls++;
    return 1;
  },
  { signal: preAborted.signal },
).catch((error: unknown) => error);
checkEqual(
  "signal: already aborted — fn is never called",
  [preAbortedCalls, isAbortError(preAbortedError)],
  [0, true],
);

const duringWait = new AbortController();
started = performance.now();
setTimeout(() => duringWait.abort(), 30);
const duringWaitError = await retry(
  () => {
    throw new Error("down");
  },
  { attempts: 5, backoff: 10_000, signal: duringWait.signal },
).catch((error: unknown) => error);
check(
  "signal: abort during a wait rejects promptly with the abort, not the last error",
  isAbortError(duringWaitError) && performance.now() - started < 2_000,
  duringWaitError,
);

const retryReason = new Error("deploy started");
const reasonController = new AbortController();
reasonController.abort(retryReason);
checkEqual(
  "signal: an Error reason is what retry rejects with",
  (await retry(() => 1, { signal: reasonController.signal }).catch(
    (error: unknown) => error,
  )) === retryReason,
  true,
);

const thrownValue = await retry(
  () => {
    throw "a string"; // eslint-disable-line no-throw-literal
  },
  { attempts: 2, backoff: 1 },
).catch((error: unknown) => error);
checkEqual(
  "retry: a thrown non-Error is rethrown as-is",
  thrownValue,
  "a string",
);

const lonelyRetry = runScript(`
  import { retry } from "@kingsleyweb/bun-common";
  retry(() => { throw new Error("down"); }, { attempts: 2, backoff: 300 })
    .catch(() => console.log("gave up"));
`);
checkEqual(
  "unref: defaults to false — a retry alone keeps the process alive between attempts",
  lonelyRetry.output,
  "gave up",
);
const unrefRetry = runScript(`
  import { retry } from "@kingsleyweb/bun-common";
  retry(() => { throw new Error("down"); }, { attempts: 2, backoff: 300, unref: true })
    .catch(() => console.log("gave up"));
`);
checkEqual(
  "unref: true — the waits do not hold the process, so it exits before the next attempt",
  unrefRetry.output,
  "",
);

/* ------------------------------------------------------------------ */
step("Mutex");

const mutex = new Mutex();
checkEqual("Mutex: starts unlocked", [mutex.locked, mutex.waiting], [false, 0]);
const releaseFirst = await mutex.acquire();
const order: number[] = [];
const waiters = [1, 2, 3].map(async (id) => {
  const release = await mutex.acquire();
  order.push(id);
  release();
});
checkEqual(
  "Mutex: held, three waiting",
  [mutex.locked, mutex.waiting],
  [true, 3],
);
releaseFirst();
checkEqual(
  "Mutex: release hands straight to the next waiter — never unlocked in between",
  mutex.locked,
  true,
);
releaseFirst(); // a second call is a no-op
await Promise.all(waiters);
checkEqual(
  "Mutex: FIFO, and unlocked at the end",
  [order, mutex.locked, mutex.waiting],
  [[1, 2, 3], false, 0],
);

const interleave: string[] = [];
await Promise.all([
  mutex.runExclusive(async () => {
    interleave.push("a:in");
    await sleep(10);
    interleave.push("a:out");
  }),
  mutex.runExclusive(() => {
    interleave.push("b");
  }),
]);
checkEqual("Mutex runExclusive: never interleaves", interleave, [
  "a:in",
  "a:out",
  "b",
]);
checkEqual(
  "Mutex runExclusive: returns fn's value",
  await mutex.runExclusive(async () => 42),
  42,
);
await checkRejects(
  "Mutex runExclusive: fn's error propagates",
  () => {
    return mutex.runExclusive(() => {
      throw new Error("inner");
    });
  },
  { message: /^inner$/ },
);
checkEqual(
  "Mutex runExclusive: released however fn settles",
  mutex.locked,
  false,
);

/* ------------------------------------------------------------------ */
step("Semaphore");

checkEqual(
  "Semaphore permits: floored, at least 1",
  [
    new Semaphore(0).permits,
    new Semaphore(-2).permits,
    new Semaphore(2.9).permits,
    new Semaphore(4).available,
  ],
  [1, 1, 2, 4],
);

const pool = new Semaphore(2);
let active = 0;
let peak = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    await pool.runExclusive(async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    });
  }),
);
checkEqual(
  "Semaphore runExclusive: bounded concurrency, all permits back",
  [peak, pool.available],
  [2, 2],
);

const heldA = pool.tryAcquire();
const heldB = pool.tryAcquire();
checkEqual(
  "Semaphore tryAcquire: null when none free, without waiting",
  [heldA !== null, heldB !== null, pool.tryAcquire(), pool.available],
  [true, true, null, 0],
);
heldA?.();
heldA?.(); // a second call is a no-op
checkEqual(
  "Semaphore release: idempotent, never above permits",
  pool.available,
  1,
);
heldB?.();

const waiterPool = new Semaphore(1);
const holding = await waiterPool.acquire();
let woke = false;
const pendingPermit = waiterPool.acquire().then((release) => {
  woke = true;
  return release;
});
checkEqual("Semaphore: a waiter queues", waiterPool.waiting, 1);
waiterPool.setPermits(2);
const wokenRelease = await pendingPermit;
checkEqual(
  "Semaphore setPermits: raising wakes waiters at once",
  [woke, waiterPool.permits, waiterPool.available],
  [true, 2, 0],
);
wokenRelease();
holding();
checkEqual("Semaphore: both released", waiterPool.available, 2);

const shrinking = new Semaphore(3);
const s1 = await shrinking.acquire();
const s2 = await shrinking.acquire();
shrinking.setPermits(1);
checkEqual(
  "Semaphore setPermits: lowering never revokes a held permit — available stays at 0 meanwhile",
  [shrinking.permits, shrinking.available, shrinking.tryAcquire()],
  [1, 0, null],
);
s1();
s2();
checkEqual(
  "Semaphore setPermits: the lower limit is in force once holders release",
  shrinking.available,
  1,
);

const overLimit = new Semaphore(2);
const o1 = await overLimit.acquire();
const o2 = await overLimit.acquire();
let o3Holding = false;
const o3 = overLimit.acquire().then((release) => {
  o3Holding = true;
  return release;
});
overLimit.setPermits(1);
o1();
await sleep(10);
check(
  "Semaphore setPermits: lowered to 1 with one holder left, a queued waiter keeps waiting",
  !o3Holding && overLimit.available === 0,
  { o3Holding, available: overLimit.available },
);
o2();
const o3Release = await o3;
o3Release();
checkEqual(
  "Semaphore: settles back to the lowered limit",
  overLimit.available,
  1,
);

/* ------------------------------------------------------------------ */
step("getPort");

const firstPort = await getPort();
check(
  "getPort: a port number",
  Number.isInteger(firstPort) && firstPort > 0 && firstPort < 65_536,
  firstPort,
);
check(
  "getPort: never the same port twice within a second",
  (await getPort()) !== firstPort,
);
check(
  "getPort port: a recently handed-out preferred port is skipped",
  (await getPort({ port: firstPort })) !== firstPort,
);

const occupied = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("busy"),
});
const occupiedPort = occupied.port!;
check(
  "getPort port: a busy preferred port (single or list) falls back to a free one",
  (await getPort({ port: occupiedPort })) !== occupiedPort &&
    (await getPort({ port: [occupiedPort, occupiedPort] })) !== occupiedPort,
);
await occupied.stop(true);

check(
  "getPort host: binds the given host",
  Number.isInteger(await getPort({ host: "127.0.0.1" })),
);
const preferred = await getPort();
await sleep(1_100); // the lock lasts about a second
checkEqual(
  "getPort port: a free preferred port is returned once its lock expires",
  await getPort({ port: [preferred] }),
  preferred,
);

/* ------------------------------------------------------------------ */
step("serializeError and deserializeError");

const coded = Object.assign(new TypeError("bad input"), {
  code: "ERR_BAD",
  jobId: "j1",
  when: new Date(0),
  big: 1n,
  fn: () => {},
});
Object.defineProperty(coded, "hidden", {
  value: "not enumerable",
  enumerable: false,
});
const flat = serializeError(coded);
checkEqual(
  "serializeError: name, message, code; data keeps JSON-able own enumerable extras",
  [flat.name, flat.message, flat.code, flat.data],
  [
    "TypeError",
    "bad input",
    "ERR_BAD",
    { jobId: "j1", when: "1970-01-01T00:00:00.000Z" },
  ],
);
check(
  "serializeError: stack kept, and the whole thing survives JSON",
  typeof flat.stack === "string" &&
    Bun.deepEquals(JSON.parse(JSON.stringify(flat)), flat),
);
checkEqual(
  "serializeError: a numeric code is kept, any other kind dropped; no extras means no data",
  [
    serializeError(Object.assign(new Error("x"), { code: 42 })).code,
    "code" in
      serializeError(Object.assign(new Error("x"), { code: { nested: true } })),
    "data" in serializeError(new Error("x")),
  ],
  [42, false, false],
);
const blank = new Error("replaced below");
blank.message = "";
blank.name = "";
checkEqual(
  "serializeError: an empty name becomes Error",
  [serializeError(blank).name, serializeError(blank).message],
  ["Error", ""],
);
checkEqual(
  "serializeError: a non-Error becomes NonError",
  [
    serializeError("text"),
    serializeError(42),
    serializeError({ a: 1 }),
    serializeError(null),
    serializeError(undefined),
  ],
  [
    { name: "NonError", message: "text" },
    { name: "NonError", message: "42" },
    { name: "NonError", message: "[object Object]" },
    { name: "NonError", message: "null" },
    { name: "NonError", message: "undefined" },
  ],
);
checkEqual(
  "serializeError: something tagged [object Error] counts as an error",
  serializeError({
    [Symbol.toStringTag]: "Error",
    name: "Remote",
    message: "from elsewhere",
  }),
  { name: "Remote", message: "from elsewhere" },
);
const unprintable = {
  toString() {
    throw new Error("no");
  },
};
checkEqual(
  "serializeError: survives a throwing toString",
  serializeError(unprintable).message,
  "[object Object]",
);

/** A chain of errors, `levels` causes deep. */
function chain(levels: number): Error {
  let error = new Error(`level ${levels}`);
  for (let level = levels - 1; level >= 0; level--) {
    error = new Error(`level ${level}`, { cause: error });
  }
  return error;
}
/** How many `cause` levels a serialised error kept. */
function causeDepth(error: SerializedError): number {
  return error.cause ? 1 + causeDepth(error.cause) : 0;
}
checkEqual(
  "maxDepth: defaults to 5; 1 and 0 as given",
  [
    causeDepth(serializeError(chain(8))),
    causeDepth(serializeError(chain(8), { maxDepth: 1 })),
    causeDepth(serializeError(chain(8), { maxDepth: 0 })),
  ],
  [5, 1, 0],
);
checkEqual(
  "serializeError: a non-Error cause is kept as NonError",
  serializeError(new Error("outer", { cause: "inner reason" })).cause,
  { name: "NonError", message: "inner reason" },
);

const longStack = new Error("long");
longStack.stack = "x".repeat(9_000);
checkEqual(
  "maxStackBytes: defaults to 8192, then a truncation marker",
  serializeError(longStack).stack,
  `${"x".repeat(8_192)}\n… (stack truncated)`,
);
checkEqual(
  "maxStackBytes: as given",
  serializeError(longStack, { maxStackBytes: 10 }).stack,
  `${"x".repeat(10)}\n… (stack truncated)`,
);
const causeTruncated = serializeError(new Error("o", { cause: longStack }), {
  maxStackBytes: 4,
});
const multibyteStack = new Error("multibyte");
multibyteStack.stack = "é".repeat(10); // 10 characters, 20 UTF-8 bytes
checkEqual(
  "maxStackBytes: counted in UTF-8 bytes, cut on a character boundary",
  [
    serializeError(multibyteStack, { maxStackBytes: 20 }).stack,
    serializeError(multibyteStack, { maxStackBytes: 9 }).stack,
  ],
  ["é".repeat(10), `${"é".repeat(4)}\n… (stack truncated)`],
);
checkEqual(
  "maxStackBytes: passed down to causes",
  causeTruncated.cause?.stack,
  "xxxx\n… (stack truncated)",
);

const restored = deserializeError(
  serializeError(new Error("query failed", { cause: coded })),
);
const restoredCause = restored.cause as Error & {
  code?: string;
  jobId?: string;
};
checkEqual(
  "deserializeError: a real Error with the original name, not the original class",
  [
    restored instanceof Error,
    restoredCause instanceof Error,
    restoredCause instanceof TypeError,
    restoredCause.name,
  ],
  [true, true, false, "TypeError"],
);
checkEqual(
  "deserializeError: message, stack, code, cause and data restored",
  [
    restored.message,
    restoredCause.stack === flat.stack,
    restoredCause.code,
    restoredCause.jobId,
  ],
  ["query failed", true, "ERR_BAD", "j1"],
);
const minimal = deserializeError({ name: "Plain", message: "m" });
checkEqual(
  "deserializeError: absent fields stay absent",
  ["code" in minimal, minimal.cause],
  [false, undefined],
);

/* ------------------------------------------------------------------ */
step("parseXmlToObject");

checkEqual(
  "defaults: attributes under @_, primitives coerced, siblings to arrays",
  parseXmlToObject(
    `<order id="7" paid="true"><item>a</item><item>b</item><item>c</item><total>9.5</total></order>`,
  ),
  { order: { "@_id": 7, "@_paid": true, item: ["a", "b", "c"], total: 9.5 } },
);
checkEqual(
  "text beside attributes or children goes under #text; blank text is dropped",
  [
    parseXmlToObject(`<p class="lead">hello</p>`),
    parseXmlToObject(`<p>a<b>1</b>c</p>`),
    parseXmlToObject(`<r>\n  <x>1</x>\n</r>`),
    parseXmlToObject(`<a x="1">   </a>`),
  ],
  [
    { p: { "@_class": "lead", "#text": "hello" } },
    { p: { b: 1, "#text": "ac" } },
    { r: { x: 1 } },
    { a: { "@_x": 1 } },
  ],
);
checkEqual(
  "empty and self-closing elements",
  [
    parseXmlToObject(`<a></a>`),
    parseXmlToObject(`<a/>`),
    parseXmlToObject(`<a>   </a>`),
    parseXmlToObject(`<r><br/><img src="x" /></r>`),
  ],
  [{ a: "" }, { a: "" }, { a: "" }, { r: { br: "", img: { "@_src": "x" } } }],
);
checkEqual(
  "attribute forms: single quotes, unquoted, valueless, entities",
  parseXmlToObject(`<a s='q' n=5 disabled t="x &amp; y">v</a>`),
  {
    a: { "@_s": "q", "@_n": 5, "@_disabled": "", "@_t": "x & y", "#text": "v" },
  },
);
checkEqual(
  "entities, CDATA, comments, processing instructions, prolog, namespaced names",
  parseXmlToObject(
    `<?xml version="1.0"?><!DOCTYPE r><!-- c --><ns:r><?pi x?><m>a &amp; b &lt; c &#65;&#x42;</m><!-- c --><d><![CDATA[<b>raw</b> &amp;]]></d></ns:r>`,
  ),
  { "ns:r": { m: "a & b < c AB", d: "<b>raw</b> &amp;" } },
);
checkEqual(
  "parsePrimitives (default true): what looks numeric becomes a number",
  parseXmlToObject(
    `<v><zip>007</zip><hex>0x1F</hex><exp>1e3</exp><inf>Infinity</inf><caps>TRUE</caps><f>false</f><pad> 42 </pad></v>`,
  ),
  {
    v: {
      zip: 7,
      hex: 31,
      exp: 1_000,
      inf: "Infinity",
      caps: "TRUE",
      f: false,
      pad: 42,
    },
  },
);
checkEqual(
  "parsePrimitives false: text and attributes stay (trimmed) strings",
  parseXmlToObject(`<v n="5"><zip> 007 </zip><f>false</f></v>`, {
    parsePrimitives: false,
  }),
  { v: { "@_n": "5", zip: "007", f: "false" } },
);
checkEqual(
  "attributeNamePrefix and textNodeName",
  [
    parseXmlToObject(`<a x="1">t</a>`, {
      attributeNamePrefix: "$",
      textNodeName: "_",
    }),
    parseXmlToObject(`<a x="1">t</a>`, { attributeNamePrefix: "" }),
  ],
  [{ a: { $x: 1, _: "t" } }, { a: { x: 1, "#text": "t" } }],
);
checkEqual(
  "ignoreAttributes: defaults to false (attributes kept); true drops them",
  [
    parseXmlToObject(`<a x="1"><b>2</b></a>`),
    parseXmlToObject(`<a x="1"><b>2</b></a>`, { ignoreAttributes: true }),
    parseXmlToObject(`<a x="1"><b>2</b></a>`, { ignoreAttributes: false }),
  ],
  [{ a: { "@_x": 1, b: 2 } }, { a: { b: 2 } }, { a: { "@_x": 1, b: 2 } }],
);
await checkRejects(
  "no element: throws",
  () => parseXmlToObject("<!-- only a comment -->"),
  { message: /^No XML element found$/ },
);
await checkRejects("plain text: throws", () => parseXmlToObject("just text"), {
  message: /^No XML element found$/,
});

checkEqual(
  "decodeXmlEntities: predefined and numeric references; unknown left alone; one pass",
  [
    decodeXmlEntities("&amp; &lt; &gt; &quot; &apos;"),
    decodeXmlEntities("&#65;&#x42;&#X43;&#x1F600;"),
    decodeXmlEntities("&nbsp; &copy; & alone &;"),
    decodeXmlEntities("&amp;lt;"),
    decodeXmlEntities("no entities"),
  ],
  [`& < > " '`, "ABC😀", "&nbsp; &copy; & alone &;", "&lt;", "no entities"],
);
checkEqual(
  "decodeXmlEntities: names are matched case-insensitively (XML's are case-sensitive)",
  decodeXmlEntities("&AMP;&Lt;"),
  "&<",
);
checkEqual(
  "decodeXmlEntities: an out-of-range numeric reference is left untouched",
  [
    outcome(() => decodeXmlEntities("&#1114112;")),
    outcome(() => parseXmlToObject("<m>&#x110000;</m>")),
  ],
  ["&#1114112;", { m: "&#x110000;" }],
);

checkEqual(
  "coerceXmlPrimitive",
  [
    coerceXmlPrimitive(" true ", true),
    coerceXmlPrimitive("false", true),
    coerceXmlPrimitive("-3.5", true),
    coerceXmlPrimitive("", true),
    coerceXmlPrimitive("  word ", true),
    coerceXmlPrimitive(" true ", false),
    coerceXmlPrimitive(" 42 ", false),
  ],
  [true, false, -3.5, "", "word", "true", "42"],
);
checkEqual(
  "isXmlWhitespace: space, tab, LF, CR only",
  [32, 9, 10, 13, 12, 11, 160, 65].map((code) => isXmlWhitespace(code)),
  [true, true, true, true, false, false, false, false],
);

/* ------------------------------------------------------------------ */
step("randomBytes, getUniqueFilename, pathExists, streamToBuffer");

const bytes = await randomBytes(16);
check(
  "randomBytes: a Buffer of the requested size",
  Buffer.isBuffer(bytes) && bytes.length === 16,
);
checkEqual("randomBytes(0)", (await randomBytes(0)).length, 0);
check(
  "randomBytes: different each time",
  !(await randomBytes(16)).equals(bytes),
);

const names = [
  await getUniqueFilename("photo.png"),
  await getUniqueFilename("photo.png"),
  await getUniqueFilename("backup.tar.gz"),
  await getUniqueFilename("Makefile"),
  await getUniqueFilename(".env"),
];
check(
  "getUniqueFilename: 32 hex characters plus the last extension, unique",
  /^[0-9a-f]{32}\.png$/.test(names[0]!) &&
    names[0] !== names[1] &&
    /^[0-9a-f]{32}\.gz$/.test(names[2]!) &&
    /^[0-9a-f]{32}$/.test(names[3]!) &&
    /^[0-9a-f]{32}$/.test(names[4]!),
  names,
);

const dir = await mkdtemp(join(tmpdir(), "bun-common-native-tour-"));
const file = join(dir, "exists.txt");
checkEqual("pathExists: missing", await pathExists(file), false);
await Bun.write(file, "x");
checkEqual(
  "pathExists: a file and a directory",
  [await pathExists(file), await pathExists(dir)],
  [true, true],
);

checkEqual(
  "streamToBuffer: collects every chunk",
  (
    await streamToBuffer(
      Readable.from([
        Buffer.from("hello, "),
        new Uint8Array([119, 111, 114, 108, 100]),
      ]),
    )
  ).toString(),
  "hello, world",
);
checkEqual(
  "streamToBuffer: an empty stream",
  (await streamToBuffer(Readable.from([]))).length,
  0,
);
checkEqual(
  "streamToBuffer: a file stream",
  (
    await streamToBuffer((await import("node:fs")).createReadStream(file))
  ).toString(),
  "x",
);
await checkRejects(
  "streamToBuffer: a stream error rejects",
  () => {
    return streamToBuffer(
      new Readable({
        read() {
          this.destroy(new Error("disk went away"));
        },
      }),
    );
  },
  { message: /^disk went away$/ },
);
const notAStream = thrown(() => {
  void streamToBuffer({} as Readable);
});
checkEqual(
  "streamToBuffer: not readable — throws synchronously rather than rejecting",
  (notAStream as Error | undefined)?.message,
  "Stream is not readable",
);
const drained = Readable.from([Buffer.from("once")]);
await streamToBuffer(drained);
await checkRejects(
  "streamToBuffer: an already-consumed stream is not readable",
  () => streamToBuffer(drained),
  {
    message: /^Stream is not readable$/,
  },
);

await rm(dir, { recursive: true, force: true });
checkEqual("temporary directory removed", await pathExists(dir), false);

clearInterval(keepAlive);
summary();
