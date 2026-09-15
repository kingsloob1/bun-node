/**
 * Compile-time assertions for the native utilities' generics, type guards and
 * overloads.
 *
 * `native.ts` replaced lodash and friends with helpers whose results used to
 * be `unknown` or a caller-asserted `T`. What they infer now is part of the
 * public API (consumers compile our source), so it is asserted by `tsc`
 * rather than at runtime. Checked by `bun scripts/typecheck.ts`, not by
 * `bun test`.
 *
 * Every `@ts-expect-error` below is a negative control: if the error ever
 * stops appearing, the build fails on the unused directive.
 *
 * Values below exist only so `typeof` can inspect them, which the unused-vars
 * rule cannot see.
 */
/* eslint-disable unused-imports/no-unused-vars */
import type { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { BunRequest } from "../lib/BunRequest";
import type { BodyDecodingOptions } from "../lib/types/general";
import type {
  ContentEncodingAllowlist,
  DeserializedError,
  DictionaryContentEncoding,
  Jsonify,
  JsonValue,
  PathSegments,
  SerializedError,
  XmlElement,
  XmlPrimitive,
} from "../lib/utils/native";
import { accepts, typeIs } from "../lib/index";
import { isNodeReadableStream } from "../lib/utils/general";
import {
  coerceXmlPrimitive,
  createDeferred,
  decompressBody,
  DEFAULT_DECOMPRESS_FAST_PATH_LIMIT,
  DEFAULT_MAX_CONTENT_CODINGS,
  deserializeError,
  each,
  flattenDeep,
  get,
  isDateValid,
  isError,
  isFunction,
  isString,
  jsonClone,
  jsonCookies,
  lastIndexOf,
  merge,
  omit,
  parseXmlToObject,
  pick,
  values,
  waitUntil,
} from "../lib/utils/native";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- type guards narrow ------------------------------------------- */

declare const mixed: string | number | (() => boolean) | Error | undefined;

if (isString(mixed)) {
  type _narrowString = Expect<Equal<typeof mixed, string>>;
}
if (isFunction(mixed)) {
  type _narrowFunction = Expect<Equal<typeof mixed, () => boolean>>;
}
if (isError(mixed)) {
  type _narrowError = Expect<Equal<typeof mixed, Error>>;
}

declare const maybeStream: Readable | string;
if (isNodeReadableStream(maybeStream)) {
  type _narrowStream = Expect<Equal<typeof maybeStream, Readable>>;
}

/* --- get: the type at the path ------------------------------------- */

declare const config: {
  server: {
    port: number;
    tls: { cert: string } | null;
    hosts: { name: string }[];
    pair: [string, number];
    label?: string;
  };
};

type _segments = Expect<Equal<PathSegments<"a.b[0].c">, ["a", "b", "0", "c"]>>;

const port = get(config, "server.port");
type _port = Expect<Equal<typeof port, number>>;

const pairSecond = get(config, "server.pair[1]");
type _tuple = Expect<Equal<typeof pairSecond, number>>;

const arrayPath = get(config, ["server", "pair", 0]);
type _arrayPath = Expect<Equal<typeof arrayPath, string>>;

// An array index may be out of range, and a null in the way stops the walk.
const hostName = get(config, "server.hosts[1].name");
type _hostName = Expect<Equal<typeof hostName, string | undefined>>;
const cert = get(config, "server.tls.cert");
type _cert = Expect<Equal<typeof cert, string | undefined>>;

// A default replaces only `undefined`, so `null` survives.
const tls = get(config, "server.tls", "none");
type _tls = Expect<Equal<typeof tls, { cert: string } | null | "none">>;
const label = get(config, "server.label", "anon");
type _label = Expect<Equal<typeof label, string>>;

// A key the type does not declare, or a path not known statically, is unknown.
const extra = get(config, "server.extra");
type _extra = Expect<Equal<typeof extra, unknown>>;
declare const dynamicPath: string;
const dynamic = get(config, dynamicPath);
type _dynamic = Expect<Equal<typeof dynamic, unknown>>;

// Stating the type explicitly still works — without a default it may be missing.
const stated = get<number>({} as unknown, "a.b");
type _stated = Expect<Equal<typeof stated, number | undefined>>;
const statedDefault = get<number>({} as unknown, "a.b", 0);
type _statedDefault = Expect<Equal<typeof statedDefault, number>>;

/* --- pick / omit ---------------------------------------------------- */

declare const user: { id: number; name: string; password: string };

const picked = pick(user, ["id", "name"]);
type _picked = Expect<Equal<typeof picked, Pick<typeof user, "id" | "name">>>;

declare const maybeUser: typeof user | undefined;
const pickedMaybe = pick(maybeUser, ["id"]);
type _pickedMaybe = Expect<Equal<typeof pickedMaybe, { id?: number }>>;

// A key the type does not declare falls back to `Partial<T>`.
const pickedLoose = pick(user, ["id", "missing"]);
type _pickedLoose = Expect<Equal<typeof pickedLoose, Partial<typeof user>>>;

const omitted = omit(user, ["password"]);
type _omitted = Expect<Equal<keyof typeof omitted, "id" | "name">>;

declare const shapes:
  | { kind: "a"; a: number; secret: string }
  | { kind: "b"; b: string; secret: string };
const omittedUnion = omit(shapes, ["secret"]);
type _omitDistributes = Expect<
  Equal<
    typeof omittedUnion,
    | Omit<{ kind: "a"; a: number; secret: string }, "secret">
    | Omit<{ kind: "b"; b: string; secret: string }, "secret">
  >
>;

declare const dynamicKeys: string[];
const omittedDynamic = omit(user, dynamicKeys);
type _omitDynamic = Expect<Equal<typeof omittedDynamic, Partial<typeof user>>>;

/* --- values / each / flattenDeep / lastIndexOf ----------------------- */

const recordValues = values({ a: 1, b: 2 });
type _recordValues = Expect<Equal<typeof recordValues, number[]>>;
const arrayValues = values(["x", "y"]);
type _arrayValues = Expect<Equal<typeof arrayValues, string[]>>;
const nullValues = values(null);
type _nullValues = Expect<Equal<typeof nullValues, never[]>>;

each(["x", "y"], (value, index) => {
  type _eachArrayValue = Expect<Equal<typeof value, string>>;
  type _eachArrayKey = Expect<Equal<typeof index, number>>;
});
each({ a: 1, b: "two" }, (value, key) => {
  type _eachObjectValue = Expect<Equal<typeof value, number | string>>;
  type _eachObjectKey = Expect<Equal<typeof key, "a" | "b">>;
});
each({} as Record<string, boolean>, (value, key) => {
  type _eachRecordValue = Expect<Equal<typeof value, boolean>>;
  type _eachRecordKey = Expect<Equal<typeof key, string>>;
});

const flat = flattenDeep([1, [2, [3, [4]]]]);
type _flat = Expect<Equal<typeof flat, number[]>>;
const flatStated = flattenDeep<string>([
  ["a", "b"],
  ["c", ["d"]],
]);
type _flatStated = Expect<Equal<typeof flatStated, string[]>>;
// @ts-expect-error a stated leaf type must match every leaf
flattenDeep<string>([["a"], [1]]);

lastIndexOf("a.b.c", ".");
lastIndexOf([1, 2, 1], 1);
// @ts-expect-error a string is searched for a substring, not a number
lastIndexOf("a.b.c", 1);

/* --- merge ---------------------------------------------------------- */

const merged = merge(
  {
    retries: 3,
    tags: ["a"],
    http: { timeout: 1000, headers: { accept: "json" } },
  },
  { http: { headers: { "x-id": "1" } } },
  { tags: [undefined, "b"], retries: undefined, at: new Date(0) },
);
type _mergedRetries = Expect<Equal<typeof merged.retries, number>>;
type _mergedTags = Expect<Equal<typeof merged.tags, string[]>>;
type _mergedHeaders = Expect<
  Equal<typeof merged.http.headers, { accept: string; "x-id": string }>
>;
type _mergedTimeout = Expect<Equal<typeof merged.http.timeout, number>>;
type _mergedDate = Expect<Equal<typeof merged.at, Date>>;

// A nullish source changes nothing; stating the result type still works.
const unchanged = merge({ a: 1 }, null, undefined);
type _unchanged = Expect<Equal<typeof unchanged, { a: number }>>;
const statedMerge = merge<{ when?: Date }>({}, { when: new Date(0) });
type _statedMerge = Expect<Equal<typeof statedMerge, { when?: Date }>>;

// @ts-expect-error a source must be an object (or nullish)
merge({ a: 1 }, 5);

/* --- cookies, async, XML, errors ----------------------------------- */

const cookies = jsonCookies({ prefs: 'j:{"lang":"en"}', sid: "abc" });
type _cookies = Expect<
  Equal<typeof cookies, { prefs: string | JsonValue; sid: string | JsonValue }>
>;

const signal = createDeferred();
type _deferredDefault = Expect<Equal<typeof signal.promise, Promise<void>>>;
signal.resolve();

declare function currentServer(): { port: number } | undefined;
const server = waitUntil(currentServer, (value) => value !== undefined);
type _waitUntilGuard = Expect<Equal<typeof server, Promise<{ port: number }>>>;
const anyServer = waitUntil(currentServer, () => true);
type _waitUntilPlain = Expect<
  Equal<typeof anyServer, Promise<{ port: number } | undefined>>
>;

const coercedText = coerceXmlPrimitive(" 42 ", false);
type _coercedText = Expect<Equal<typeof coercedText, string>>;
declare const parsePrimitives: boolean;
const coercedAny = coerceXmlPrimitive(" 42 ", parsePrimitives);
type _coercedAny = Expect<Equal<typeof coercedAny, XmlPrimitive>>;

const xmlText = parseXmlToObject("<a>1</a>", { parsePrimitives: false });
type _xmlText = Expect<
  Equal<typeof xmlText, Record<string, string | XmlElement<string>>>
>;
const xmlDefault = parseXmlToObject("<a>1</a>");
type _xmlDefault = Expect<
  Equal<typeof xmlDefault, Record<string, XmlPrimitive | XmlElement>>
>;

declare const wire: SerializedError;
const rebuilt = deserializeError(wire);
type _rebuiltPlain = Expect<
  Equal<typeof rebuilt, DeserializedError<Record<string, JsonValue>>>
>;
type _rebuiltCause = Expect<
  Equal<typeof rebuilt.cause, DeserializedError | undefined>
>;
const rebuiltCode: string | number | undefined = rebuilt.code;

declare const typedWire: SerializedError<{ jobId: string }>;
const typedRebuilt = deserializeError(typedWire);
type _rebuiltData = Expect<
  Equal<typeof typedRebuilt.jobId, string | undefined>
>;
// @ts-expect-error without a declared data shape, no extra property is known
void rebuilt.jobId;

// `data` keys that collide with the error's own fields are dropped at runtime,
// so they cannot retype those fields either; the other keys still come through.
declare const collidingWire: SerializedError<{
  name: number;
  message: boolean;
  stack: string[];
  code: boolean;
  ms: number;
}>;
const collidingRebuilt = deserializeError(collidingWire);
type _collidingName = Expect<Equal<typeof collidingRebuilt.name, string>>;
type _collidingMessage = Expect<Equal<typeof collidingRebuilt.message, string>>;
type _collidingStack = Expect<
  Equal<typeof collidingRebuilt.stack, string | undefined>
>;
type _collidingCode = Expect<
  Equal<typeof collidingRebuilt.code, string | number | undefined>
>;
type _collidingKept = Expect<
  Equal<typeof collidingRebuilt.ms, number | undefined>
>;

/* --- decompressBody: a known encoding cannot come back undefined --- */

declare const compressedBody: Uint8Array;
declare const contentEncodingHeader: string;

const knownEncoding = decompressBody(compressedBody, "gzip", {
  maxOutputLength: 1024,
});
type _knownEncoding = Expect<Equal<typeof knownEncoding, Buffer>>;

const headerEncoding = decompressBody(compressedBody, contentEncodingHeader);
type _headerEncoding = Expect<Equal<typeof headerEncoding, Buffer | undefined>>;

// @ts-expect-error — an arbitrary header value may be unsupported.
const _notNarrowed: Buffer = decompressBody(
  compressedBody,
  contentEncodingHeader,
);

// @ts-expect-error — the limit is a byte count, not a human string.
decompressBody(compressedBody, "br", { maxOutputLength: "100kb" });

const withFastPath = decompressBody(compressedBody, "deflate", {
  maxOutputLength: 1024,
  fastPathLimit: DEFAULT_DECOMPRESS_FAST_PATH_LIMIT,
});
type _withFastPath = Expect<Equal<typeof withFastPath, Buffer>>;
type _fastPathDefault = Expect<
  Equal<typeof DEFAULT_DECOMPRESS_FAST_PATH_LIMIT, number>
>;

// @ts-expect-error — the fast-path budget is a byte count too.
decompressBody(compressedBody, "gzip", { fastPathLimit: "32mb" });

/* --- decompressBody: encodings, maxCodings, dictionaries ------------ */

// zstd is a known coding: with every coding admitted it cannot be refused.
const zstdDecoded = decompressBody(compressedBody, "zstd", { encodings: "*" });
type _zstdDecoded = Expect<Equal<typeof zstdDecoded, Buffer>>;

// A list may leave the coding out, so the result may be undefined.
const listedDecoded = decompressBody(compressedBody, "gzip", {
  encodings: ["gzip", "br"],
});
type _listedDecoded = Expect<Equal<typeof listedDecoded, Buffer | undefined>>;

const listWithWildcard: ContentEncodingAllowlist = ["zstd", "*"];
const everyCoding: ContentEncodingAllowlist = "*";

// @ts-expect-error — a misspelt coding is a compile error.
decompressBody(compressedBody, "gzip", { encodings: ["gzpi"] });

// @ts-expect-error — `"*"` is the only bare value; a single coding is a list.
decompressBody(compressedBody, "gzip", { encodings: "gzip" });

// @ts-expect-error — `compress` is registered, but not a coding decoded here.
const _compressAllowed: ContentEncodingAllowlist = ["compress"];

// dcb/dcz need dictionaries, so they may come back undefined.
const dictionaryDecoded = decompressBody(compressedBody, "dcz", {
  dictionaries: [compressedBody],
});
type _dictionaryDecoded = Expect<
  Equal<typeof dictionaryDecoded, Buffer | undefined>
>;

decompressBody(compressedBody, "dcb", {
  maxCodings: DEFAULT_MAX_CONTENT_CODINGS,
  dictionaries: (hash, encoding) => {
    type _hash = Expect<Equal<typeof hash, Buffer>>;
    type _encoding = Expect<Equal<typeof encoding, DictionaryContentEncoding>>;
    return undefined;
  },
});
type _maxCodingsDefault = Expect<
  Equal<typeof DEFAULT_MAX_CONTENT_CODINGS, number>
>;

// @ts-expect-error — the coding cap is a count.
decompressBody(compressedBody, "gzip", { maxCodings: "5" });

// @ts-expect-error — a resolver answers bytes, not text.
decompressBody(compressedBody, "dcz", { dictionaries: () => "dictionary" });

// The request's decoding options take the same types.
const requestDecoding: BodyDecodingOptions = {
  encodings: ["gzip", "zstd", "*"],
  maxContentCodings: 2,
  compressionDictionaries: [compressedBody],
};
const resolvedDecoding: BodyDecodingOptions = {
  compressionDictionaries: (hash) =>
    hash.length === 32 ? compressedBody : undefined,
};

// @ts-expect-error — the allowlist is checked on request options too.
const _badRequestDecoding: BodyDecodingOptions = { encodings: ["zip"] };

// @ts-expect-error — so is the coding cap.
const _badCodingCap: BodyDecodingOptions = { maxContentCodings: "5" };

/* --- isDateValid: a guard for anything not already a Date ---------- */

declare const maybeDate: Date | string | undefined;
if (isDateValid(maybeDate)) {
  type _dateFromUnion = Expect<Equal<typeof maybeDate, Date>>;
}

declare const anything: unknown;
if (isDateValid(anything)) {
  type _dateFromUnknown = Expect<Equal<typeof anything, Date>>;
}

// A `Date` is only checked, never narrowed: an invalid `Date` is still a
// `Date`, so the `false` branch must not collapse to `never`.
declare const knownDate: Date;
const knownValidity = isDateValid(knownDate);
type _plainBoolean = Expect<Equal<typeof knownValidity, boolean>>;
if (!isDateValid(knownDate)) {
  type _stillDate = Expect<Equal<typeof knownDate, Date>>;
}

/* --- jsonClone / Jsonify: the type of what JSON gives back ---------- */

declare const secret: unique symbol;

/** Every kind of value JSON changes, loses or keeps. */
interface RichRecord {
  id: number;
  at: Date;
  tags: readonly string[];
  note?: string;
  maybe: string | undefined;
  onClick: () => void;
  handlerOrName: (() => void) | string;
  lookup: Map<string, number>;
  seen: Set<number>;
  nested: { when: Date; list: Array<Date | undefined | (() => void)> };
  payload: unknown;
  [secret]: string;
}

declare const richRecord: RichRecord;
const richClone = jsonClone(richRecord);
type _richClone = Expect<
  Equal<
    typeof richClone,
    {
      id: number;
      at: string;
      tags: string[];
      note?: string;
      maybe: string | undefined;
      handlerOrName: string | undefined;
      lookup: Record<string, never>;
      seen: Record<string, never>;
      nested: { when: string; list: (string | null)[] };
      payload: JsonValue | undefined;
    }
  >
>;

type _jsonDate = Expect<Equal<Jsonify<Date>, string>>;
type _jsonUndefined = Expect<Equal<Jsonify<undefined>, undefined>>;
type _jsonFunction = Expect<Equal<Jsonify<() => number>, undefined>>;
type _jsonSymbol = Expect<Equal<Jsonify<symbol>, undefined>>;
type _jsonBigint = Expect<Equal<Jsonify<bigint>, never>>;
type _jsonUnknown = Expect<Equal<Jsonify<unknown>, JsonValue | undefined>>;
type _jsonAny = Expect<Equal<Jsonify<any>, any>>;
type _jsonValue = Expect<Equal<Jsonify<JsonValue>, JsonValue>>;
type _jsonTuple = Expect<
  Equal<
    Jsonify<[Date, undefined, () => void, number]>,
    [string, null, null, number]
  >
>;
type _jsonToJson = Expect<
  Equal<Jsonify<{ toJSON: () => { at: Date } }>, { at: string }>
>;
type _jsonMap = Expect<Equal<Jsonify<Map<string, 1>>, Record<string, never>>>;
type _jsonUnion = Expect<Equal<Jsonify<Date | number>, string | number>>;

// @ts-expect-error — a Date property comes back a string.
const _stillADate: Date = jsonClone({ at: new Date() }).at;
// @ts-expect-error — a function property is gone.
jsonClone({ run: () => 1 }).run();

// Code written against `jsonClone<T>(value: T): T` still compiles: a generic
// wrapper may claim the input type through its return type...
function _keepInputType<T>(value: T): T {
  return jsonClone(value);
}
// ...but nothing other than the input type or its JSON form.
// @ts-expect-error — `number` is neither `{ a: number }` nor its JSON form.
const _unrelated: number = jsonClone({ a: 1 });

/* --- accepts / typeIs: anything with headers ----------------------- */

const plainNegotiation = accepts({
  headers: { accept: "text/html, application/json;q=0.9" },
});
const plainTypes = plainNegotiation.types(["json", "html"]);
type _acceptsTypes = Expect<
  Equal<typeof plainTypes, string[] | string | false>
>;
const plainLanguages = plainNegotiation.languages(["en"]);
type _acceptsLanguages = Expect<Equal<typeof plainLanguages, string | false>>;

const plainMatch = typeIs(
  { headers: { "content-type": "application/json", "content-length": "2" } },
  ["json"],
);
type _typeIsResult = Expect<Equal<typeof plainMatch, string | false | null>>;
const spreadMatch = typeIs({ headers: {} }, "json", "html");
type _typeIsSpread = Expect<Equal<typeof spreadMatch, string | false | null>>;
const plainHasBody = typeIs.hasBody({
  headers: { "transfer-encoding": "chunked" },
});
type _hasBody = Expect<Equal<typeof plainHasBody, boolean>>;
const repeated = accepts({
  headers: { accept: ["text/html", "application/json"] },
});

declare const bunRequest: BunRequest;
accepts(bunRequest).encodings(["br"]);
typeIs(bunRequest, ["json"]);
typeIs.hasBody(bunRequest);

declare const nodeRequest: IncomingMessage;
accepts(nodeRequest).charsets();
typeIs(nodeRequest, ["json"]);

// @ts-expect-error — the headers are what both read, so they are required.
accepts({});
// @ts-expect-error — a header value is a string, not a number.
typeIs.hasBody({ headers: { "content-length": 2 } });

export { rebuiltCode, repeated };
