/**
 * Compile-time assertions for `BunRequest`'s and `BunResponse`'s types: the
 * request generics, the overloads whose return type follows the arguments,
 * the typed socket emitter, and the response body types.
 *
 * Checked by `bun scripts/typecheck.ts`, not by `bun test`; every
 * `@ts-expect-error` is a negative control that fails the build if the error
 * it expects ever disappears.
 */
import type { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import type {
  BunRequestCookies,
  BunResponseSentBody,
  BunServer,
  JsonValue,
  MultiPartParseResult,
  RangeParserResult,
  RawMultiPartFields,
} from "../lib";
import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const req: BunRequest;
declare const res: BunResponse;

/* --- request generics ----------------------------------------------- */

declare const typed: BunRequest<
  { id: string },
  { page: number },
  { name: string }
>;
type _params = Expect<Equal<typeof typed.params, { id: string }>>;
type _query = Expect<Equal<typeof typed.query, { page: number }>>;
type _body = Expect<Equal<typeof typed.body, { name: string }>>;
type _cookies = Expect<Equal<typeof req.cookies, Record<string, JsonValue>>>;
type _server = Expect<Equal<typeof req.server, BunServer | undefined>>;

async function _ready() {
  const _settled = await typed.ready();
  type _settledType = Expect<
    Equal<
      typeof _settled,
      PromiseSettledResult<{ page: number } | BunRequestCookies | void>[]
    >
  >;
}

/* --- req.get(): the default decides the return type ----------------- */

const _header = req.get("content-type");
type _headerType = Expect<Equal<typeof _header, string | null>>;
// `Set-Cookie`, in any letter case, is an array, as Node's `req.headers`.
const _setCookie = req.get("set-cookie");
type _setCookieType = Expect<Equal<typeof _setCookie, string[] | null>>;
const _setCookieCased = req.get("Set-Cookie");
type _setCookieCasedType = Expect<
  Equal<typeof _setCookieCased, string[] | null>
>;
const _setCookieDefault = req.get("set-cookie", []);
type _setCookieDefaultType = Expect<Equal<typeof _setCookieDefault, string[]>>;
// Negative control: any other header is still a string.
// @ts-expect-error `content-type` is not an array.
const _notCookie: string[] | null = req.get("content-type");
const _withDefault = req.get("x-missing", "fallback");
type _withDefaultType = Expect<Equal<typeof _withDefault, string>>;
const _withListDefault = req.get("x-missing", ["a", "b"]);
type _withListDefaultType = Expect<
  Equal<typeof _withListDefault, string | string[]>
>;

/* --- negotiation: no types lists them, types pick one ---------------- */

const _allTypes = req.accepts();
type _allTypesType = Expect<Equal<typeof _allTypes, string[]>>;
const _spreadTypes = req.accepts("json", "html");
type _spreadTypesType = Expect<Equal<typeof _spreadTypes, string | false>>;
const _listTypes = req.accepts(["json", "html"]);
type _listTypesType = Expect<Equal<typeof _listTypes, string | false>>;
const _allEncodings = req.acceptsEncoding();
type _allEncodingsType = Expect<Equal<typeof _allEncodings, string[]>>;
const _oneLanguage = req.acceptsLanguages("fr", "en");
type _oneLanguageType = Expect<Equal<typeof _oneLanguage, string | false>>;

const _ranges = req.range(1000);
type _rangesType = Expect<Equal<typeof _ranges, RangeParserResult | undefined>>;
const _combined = req.range(1000, { combine: true });
type _combinedType = Expect<
  Equal<typeof _combined, RangeParserResult | undefined>
>;

const _contentType = req.is(["json", "html"]);
type _contentTypeType = Expect<
  Equal<typeof _contentType, string | false | null>
>;

/* --- body parsing and multipart ------------------------------------- */

async function _bodyParsing() {
  // `undefined` for a request `type` does not match, or a consumed body.
  const _buffer = await req.handleBodyParsing(true);
  type _bufferType = Expect<Equal<typeof _buffer, Buffer | undefined>>;
  const _nothing = await req.handleBodyParsing(false);
  type _nothingType = Expect<Equal<typeof _nothing, undefined>>;

  const _raw = await req.getMultiParts({ inflate: false });
  type _rawType = Expect<
    Equal<typeof _raw, MultiPartParseResult<RawMultiPartFields>>
  >;
  type _rawFieldsType = Expect<
    Equal<(typeof _raw.fields)[string], string | string[]>
  >;

  const _inflated = await req.getMultiParts({});
  type _inflatedType = Expect<
    Equal<typeof _inflated.fields, Record<string, unknown>>
  >;
}

/* --- req.socket: known events are typed, others are unknown ---------- */

req.socket.on("close", (_hadError) => {
  type _hadErrorType = Expect<Equal<typeof _hadError, boolean>>;
});
req.socket.once("timeout", () => {});
req.socket.on("anything", (..._args) => {
  type _argsType = Expect<Equal<typeof _args, unknown[]>>;
});
req.socket.emit("close", false);
req.socket.emit("anything", 1, "two");

// @ts-expect-error `close` passes a boolean, not a string.
req.socket.on("close", (_reason: string) => {});
// @ts-expect-error `close` must be emitted with its `hadError` flag.
req.socket.emit("close", "nope");

/* --- request events -------------------------------------------------- */

req.on("data", (_chunk) => {
  type _chunkType = Expect<Equal<typeof _chunk, Buffer>>;
});

/* --- response bodies ------------------------------------------------- */

interface UserDto {
  id: string;
  roles: string[];
}
declare const user: UserDto;

// An interface (no index signature) and an array are both JSON bodies.
res.json(user);
res.json([1, 2, 3]);
res.json<UserDto>({ id: "1", roles: [] });
res.jsonp<UserDto>(user);

// @ts-expect-error the body does not match the declared response shape.
res.json<UserDto>({ id: 1, roles: [] });
// @ts-expect-error `JSON.stringify` cannot serialise a bigint.
res.json(10n);

type _getBody = Expect<
  Equal<ReturnType<BunResponse["getBody"]>, BunResponseSentBody>
>;

res.write("chunk");
res.write(new Uint8Array([1, 2]));
// @ts-expect-error a stream chunk is text or binary, not an object.
res.write({ not: "a chunk" });
type _writeResult = Expect<Equal<ReturnType<BunResponse["write"]>, boolean>>;

// `end(chunk)` takes a chunk, as Node's; an object goes through `json`.
void res.end();
void res.end("done");
void res.end(new Uint8Array([1]));
// @ts-expect-error `end` takes text or bytes, not an object.
void res.end({ not: "a chunk" });

/* --- res.get(): the default decides the return type ------------------ */

const _etag = res.get("ETag");
type _etagType = Expect<Equal<typeof _etag, string | undefined>>;
const _etagDefault = res.get("ETag", "");
type _etagDefaultType = Expect<Equal<typeof _etagDefault, string>>;
const _linkDefault = res.get("Link", ["</a>"]);
type _linkDefaultType = Expect<Equal<typeof _linkDefault, string | string[]>>;
// `Set-Cookie`, in any letter case, is an array.
const _resSetCookie = res.get("Set-Cookie");
type _resSetCookieType = Expect<
  Equal<typeof _resSetCookie, string[] | undefined>
>;
const _resSetCookieDefault = res.get("set-cookie", []);
type _resSetCookieDefaultType = Expect<
  Equal<typeof _resSetCookieDefault, string[]>
>;
// @ts-expect-error `ETag` is not an array.
const _notResCookie: string[] | undefined = res.get("ETag");

/* --- res.getHeader() / getHeaders(): Set-Cookie as Node's arrays ------- */

// A literal `Set-Cookie`, in any letter case, is the array of its lines.
const _getHeaderCookie = res.getHeader("Set-Cookie");
type _getHeaderCookieType = Expect<
  Equal<typeof _getHeaderCookie, string[] | undefined>
>;
const _getHeaderCookieLower = res.getHeader("set-cookie");
type _getHeaderCookieLowerType = Expect<
  Equal<typeof _getHeaderCookieLower, string[] | undefined>
>;
// Any other header is one string, `null` when absent.
const _getHeaderEtag = res.getHeader("ETag");
type _getHeaderEtagType = Expect<Equal<typeof _getHeaderEtag, string | null>>;
// @ts-expect-error `ETag` is not an array.
const _notGetHeaderCookie: string[] | undefined = res.getHeader("ETag");
// A name typed only as `string` cannot be told apart: one string.
declare const _dynamicName: string;
const _getHeaderDynamic = res.getHeader(_dynamicName);
type _getHeaderDynamicType = Expect<
  Equal<typeof _getHeaderDynamic, string | null>
>;

const _headers = res.getHeaders();
type _headersCookie = Expect<
  Equal<(typeof _headers)["set-cookie"], string[] | undefined>
>;
type _headersOther = Expect<
  Equal<(typeof _headers)["x-trace"], string | string[] | undefined>
>;
type _headerNames = Expect<
  Equal<ReturnType<BunResponse["getHeaderNames"]>, string[]>
>;

/* --- cookies and response events ------------------------------------- */

res.cookie("prefs", { theme: "dark" }, { maxAge: "1000", signed: false });
res.cookie("count", 3);

res.on("pipe", (_source) => {
  type _sourceType = Expect<Equal<typeof _source, Readable>>;
});

res.writeHead(200, "OK", { "X-A": "1" });
res.writeHead(200, ["X-A: 1"]);
// Node's `writeHead(statusCode[, statusMessage][, headers])`.
res.writeHead(404);
res.writeHead(404, "Nope");
// @ts-expect-error a status message alone needs headers.
res.writeHead("Nope");
