/**
 * Option tour: every `BunRequest` option, and every public `BunRequest`
 * property, method and event, each asserted.
 *
 * ```bash
 * bun 12-options/request-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Requests here are built directly with `BunRequest.init()`, the way the
 *   adapter builds them. `FETCH_STUB_SERVER` stands in for `Bun.serve` (no
 *   peer, no upgrades); a small fake server supplies a peer address where one
 *   is needed.
 * - `init()` returns the request itself — not a promise — when no parsing was
 *   scheduled, and a promise otherwise.
 * - `parseQueryOpts` accepts picoquery's own options plus `decode` and
 *   `decodeURIComponent`. It **replaces** `DEFAULT_PARSE_QUERY_OPTS` rather
 *   than merging into it — spread the defaults in to keep bracket nesting
 *   (picoquery's own default nesting syntax reads dots only).
 * - `parseXmlOpts`, `parseMultiPartFormDataOpts` and `allowedContentTypes` are
 *   deprecated in favour of `parseBody.contentTypes`, but still honoured.
 * - Checks marked `Known issue` assert what the library documents where it
 *   currently does something else; they fail until the library is fixed.
 */
import type {
  BunRequestOptions,
  BunServer,
  DefaultRequestBody,
  MemoryStorageFile,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  BunRouter,
  compressionDictionaryHash,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  DEFAULT_PARSE_QUERY_OPTS,
  dictionaryCompressedHeader,
  FETCH_STUB_SERVER,
  noopLogger,
  PayloadTooLargeError,
  signCookie,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";

title("Option tour: BunRequest options, properties, methods and events");

/** Options for one request; `parseBody` defaults to `false` here. */
type Options = Partial<NonNullable<BunRequestOptions>>;

/** The two server members a request uses: its peer, and upgrades (refused). */
const peerStub: Pick<BunServer, "requestIP" | "upgrade"> = {
  requestIP: () => ({ address: "203.0.113.7", port: 51234, family: "IPv4" }),
  upgrade: () => false,
};
/**
 * A server that reports a peer, so `ip`, `socketAddress` and `socket` have
 * values. Only the members a request touches exist, as `FETCH_STUB_SERVER`.
 */
const peerServer = peerStub as BunServer;

/** Builds and initialises a request. */
async function make(
  url: string,
  init: RequestInit = {},
  options: Options = {},
  server: BunServer = FETCH_STUB_SERVER,
): Promise<BunRequest> {
  return await BunRequest.init(new Request(url, init), server, {
    parseBody: false,
    ...options,
  });
}

/** A POST with a body and Content-Type. */
function postInit(
  body: string | Uint8Array,
  contentType?: string,
): RequestInit {
  const headers: Record<string, string> = {};
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  return { method: "POST", headers, body };
}

/* ------------------------------------------------------------------ */
step("init(), ready(): synchronous when nothing is scheduled");

const bare = BunRequest.init(
  new Request("http://localhost/"),
  FETCH_STUB_SERVER,
  {
    parseBody: false,
    parseCookies: false,
    parseQuery: false,
  },
);
check("init() returns the instance itself", bare instanceof BunRequest);
const scheduled = BunRequest.init(
  new Request("http://localhost/?a=1"),
  FETCH_STUB_SERVER,
  { parseBody: true },
);
check(
  "…and a promise when parsing was scheduled",
  scheduled instanceof Promise,
);
checkEqual(
  "ready() with nothing scheduled answers []",
  await (bare as BunRequest).ready(),
  [],
);
checkEqual(
  "ready() settles every scheduled step",
  (await (await scheduled).ready()).length,
  3,
);

/* ------------------------------------------------------------------ */
step("parseQuery and parseQueryOpts");

checkEqual("DEFAULT_PARSE_QUERY_OPTS", DEFAULT_PARSE_QUERY_OPTS, {
  nesting: true,
  nestingSyntax: "js",
  arrayRepeat: true,
  arrayRepeatSyntax: "repeat",
});
check("…is frozen", Object.isFrozen(DEFAULT_PARSE_QUERY_OPTS));

const query = "a.b=1&c[d]=2&ids[0]=x&ids[1]=y&tag=p&tag=q";
checkEqual(
  "default: dotted, bracketed, indexed and repeated keys",
  (await make(`http://localhost/?${query}`)).query,
  {
    a: { b: "1" },
    c: { d: "2" },
    ids: ["x", "y"],
    tag: ["p", "q"],
  },
);
checkEqual(
  "parseQuery: false leaves query empty",
  (await make(`http://localhost/?${query}`, {}, { parseQuery: false })).query,
  {},
);
checkEqual(
  "nesting: false keeps keys literal",
  (
    await make(
      "http://localhost/?a.b=1&c[d]=2",
      {},
      { parseQueryOpts: { nesting: false } },
    )
  ).query,
  {
    "a.b": "1",
    "c[d]": "2",
  },
);
checkEqual(
  "nestingSyntax: dot reads only dots",
  (
    await make(
      "http://localhost/?a.b=1&c[d]=2",
      {},
      { parseQueryOpts: { nestingSyntax: "dot" } },
    )
  ).query,
  {
    a: { b: "1" },
    "c[d]": "2",
  },
);
checkEqual(
  "nestingSyntax: index reads only brackets",
  (
    await make(
      "http://localhost/?a.b=1&c[d]=2",
      {},
      { parseQueryOpts: { nestingSyntax: "index" } },
    )
  ).query,
  {
    "a.b": "1",
    c: { d: "2" },
  },
);
checkEqual(
  "arrayRepeat: false keeps the last value",
  (
    await make(
      "http://localhost/?tag=p&tag=q",
      {},
      { parseQueryOpts: { arrayRepeat: false } },
    )
  ).query,
  {
    tag: "q",
  },
);
checkEqual(
  "arrayRepeatSyntax: bracket collects tag[]",
  (
    await make(
      "http://localhost/?tag[]=p&tag[]=q",
      {},
      { parseQueryOpts: { arrayRepeat: true, arrayRepeatSyntax: "bracket" } },
    )
  ).query,
  {
    tag: ["p", "q"],
  },
);
checkEqual(
  "delimiter",
  (
    await make(
      "http://localhost/?a=1;b=2",
      {},
      { parseQueryOpts: { delimiter: ";" } },
    )
  ).query,
  {
    a: "1",
    b: "2",
  },
);
checkEqual(
  "valueDeserializer",
  (
    await make(
      "http://localhost/?n=5&s=x",
      {},
      {
        parseQueryOpts: {
          valueDeserializer: (value) => {
            return /^\d+$/.test(value) ? Number(value) : value;
          },
        },
      },
    )
  ).query,
  { n: 5, s: "x" },
);
checkEqual(
  "keyDeserializer",
  (
    await make(
      "http://localhost/?Page=2",
      {},
      {
        parseQueryOpts: { keyDeserializer: (key) => key.toLowerCase() },
      },
    )
  ).query,
  { page: "2" },
);
checkEqual(
  "encoded brackets still nest by default",
  (await make("http://localhost/?ids%5B0%5D=1&ids%5B1%5D=2")).query,
  {
    ids: ["1", "2"],
  },
);
checkEqual(
  "default keeps an encoded delimiter inside a value",
  (await make("http://localhost/?q=a%26b")).query,
  {
    q: "a&b",
  },
);
checkEqual(
  "decodeURIComponent: true decodes the delimiters too",
  (
    await make(
      "http://localhost/?q=a%26b",
      {},
      {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decodeURIComponent: true,
        },
      },
    )
  ).query,
  {
    q: "a",
    b: "",
  },
);
checkEqual(
  "decode takes full control",
  (
    await make(
      "http://localhost/?a=1~b=2",
      {},
      {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decode: (q) => q.replace(/~/g, "&"),
        },
      },
    )
  ).query,
  {
    a: "1",
    b: "2",
  },
);
checkEqual(
  "a throwing decode falls back to the bracket decode",
  (
    await make(
      "http://localhost/?ids%5B0%5D=1",
      {},
      {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decode: () => {
            throw new Error("boom");
          },
        },
      },
    )
  ).query,
  { ids: ["1"] },
);

const reparsed = await make(
  "http://localhost/?a.b=1",
  {},
  { parseQuery: false },
);
reparsed.setQueryParserOptions({ nesting: false });
checkEqual(
  "setQueryParserOptions() + parseQuery() re-parses",
  reparsed.parseQuery(),
  { "a.b": "1" },
);
checkEqual(
  "parseQuery(opts) uses the options given",
  reparsed.parseQuery({ ...DEFAULT_PARSE_QUERY_OPTS }),
  { a: { b: "1" } },
);
checkEqual("…and assigns req.query", reparsed.query, { a: { b: "1" } });

/* ------------------------------------------------------------------ */
step("parseCookies, cookieParseOptions and secrets");

const SECRET = "tour secret";
const signedValue = `s:${signCookie("user-42", SECRET)}`;
const cookieHeader = `theme=dark; prefs=${encodeURIComponent('j:{"lang":"en"}')}; session=${encodeURIComponent(signedValue)}`;

const withCookies = await make(
  "http://localhost/",
  { headers: { Cookie: cookieHeader } },
  {
    cookieParseOptions: { decode: (value) => value },
  },
);
checkEqual(
  "cookies parsed at init; j: values expanded; signed still raw",
  withCookies.cookies,
  {
    theme: "dark",
    prefs: { lang: "en" },
    session: signedValue,
  },
);
checkEqual(
  "parseCookies: false leaves cookies empty",
  (
    await make(
      "http://localhost/",
      { headers: { Cookie: cookieHeader } },
      { parseCookies: false },
    )
  ).cookies,
  {},
);

withCookies.secret = SECRET;
const returned = withCookies.parseCookies();
checkEqual("parseCookies() verifies with req.secret", returned.signedCookies, {
  session: "user-42",
});
checkEqual(
  "…without forceUpdateRequest, req.signedCookies is unchanged",
  withCookies.signedCookies,
  {},
);
withCookies.parseCookies({ forceUpdateRequest: true });
checkEqual(
  "forceUpdateRequest: true writes signedCookies",
  withCookies.signedCookies,
  { session: "user-42" },
);
checkEqual(
  "…and removes verified ones from cookies",
  Object.keys(withCookies.cookies).sort(),
  ["prefs", "theme"],
);

const rotated = await make("http://localhost/", {
  headers: { Cookie: cookieHeader },
});
const rotatedResult = rotated.parseCookies({
  secret: ["newer", SECRET],
  forceUpdateRequest: true,
});
checkEqual(
  "secret: [newest, older] verifies against each",
  rotatedResult.signedCookies,
  { session: "user-42" },
);
checkEqual("…and the first becomes req.secret", rotated.secret, "newer");
checkEqual(
  "no Cookie header: empty result",
  (await make("http://localhost/")).parseCookies(),
  { cookies: {}, signedCookies: {} },
);

/* ------------------------------------------------------------------ */
step("parseBody: boolean forms and every kind");

checkEqual(
  "parseBody: false leaves body undefined",
  (await make("http://localhost/", postInit('{"a":1}', "application/json")))
    .body,
  undefined,
);
const kinds: [string, RequestInit, DefaultRequestBody][] = [
  ["json", postInit('{"a":1}', "application/json"), { a: 1 }],
  ["+json", postInit('{"a":1}', "application/problem+json"), { a: 1 }],
  [
    "urlencoded",
    postInit("a=1&b[c]=2", "application/x-www-form-urlencoded"),
    { a: "1", b: { c: "2" } },
  ],
  ["text", postInit("words", "text/plain"), "words"],
  [
    "xml",
    postInit('<a x="1"><b>2</b></a>', "text/xml"),
    { a: { "@_x": 1, b: 2 } },
  ],
  [
    "+xml",
    postInit("<rss><c>n</c></rss>", "application/rss+xml"),
    { rss: { c: "n" } },
  ],
  ["auto: json", postInit(new TextEncoder().encode('{"a":1}')), { a: 1 }],
  ["auto: xml", postInit(new TextEncoder().encode("<a>1</a>")), { a: 1 }],
  ["auto: urlencoded", postInit(new TextEncoder().encode("a=1")), { a: "1" }],
];
for (const [label, init, expected] of kinds) {
  checkEqual(
    `parseBody: true — ${label}`,
    (await make("http://localhost/", init, { parseBody: true })).body,
    expected,
  );
}
const raw = await make(
  "http://localhost/",
  postInit(new Uint8Array([1, 2, 3]), "application/octet-stream"),
  { parseBody: true },
);
check("raw: a Buffer", Buffer.isBuffer(raw.body) && raw.buffer?.length === 3);
const unknownType = await make(
  "http://localhost/",
  postInit("line", "application/x-ndjson"),
  { parseBody: true },
);
check("an unknown media type: a Buffer", Buffer.isBuffer(unknownType.body));
checkEqual(
  "…with the Content-Type kept as the client sent it",
  unknownType.get("Content-Type"),
  "application/x-ndjson",
);
const noBody = await make("http://localhost/", {}, { parseBody: true });
checkEqual(
  "a GET with no body: body undefined, no Content-Type written",
  [noBody.body, noBody.get("Content-Type")],
  [undefined, null],
);
check(
  "parseBody: true is uncapped",
  !(
    await make(
      "http://localhost/",
      postInit("x".repeat(300 * 1024), "text/plain"),
      { parseBody: true },
    )
  ).isPayloadTooLarge,
);

/* ------------------------------------------------------------------ */
step("parseBody object form: maxContentLength and the defaults");

checkEqual(
  "DEFAULT_MAX_CONTENT_LENGTH is 100kb",
  DEFAULT_MAX_CONTENT_LENGTH,
  102_400,
);
checkEqual(
  "DEFAULT_MAX_CONTENT_LENGTH_BY_KIND",
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  { multipart: 10_485_760, raw: 10_485_760 },
);

const overDefault = await make(
  "http://localhost/",
  postInit("x".repeat(101 * 1024), "text/plain"),
  { parseBody: {} },
);
checkEqual(
  "object form defaults to 100kb",
  overDefault.payloadTooLarge?.limit,
  102_400,
);
check(
  "rawUnderItsDefault: raw may be 200kb",
  !(
    await make(
      "http://localhost/",
      postInit(new Uint8Array(200 * 1024), "application/octet-stream"),
      { parseBody: {} },
    )
  ).isPayloadTooLarge,
);
const human = await make(
  "http://localhost/",
  postInit("x".repeat(2_000), "text/plain"),
  { parseBody: { maxContentLength: "1kb" } },
);
checkEqual(
  "maxContentLength as a human string",
  [human.isPayloadTooLarge, human.payloadTooLarge?.limit, human.body],
  [true, 1024, undefined],
);
const perKind = await make(
  "http://localhost/",
  postInit('{"a":1}', "application/json"),
  {
    parseBody: {
      maxContentLength: "10mb",
      contentTypes: { json: { maxContentLength: 5 } },
    },
  },
);
checkEqual(
  "a kind's own maxContentLength wins",
  perKind.payloadTooLarge?.limit,
  5,
);
const within = await make(
  "http://localhost/",
  postInit('{"a":1}', "application/json"),
  { parseBody: { maxContentLength: 1024 } },
);
checkEqual(
  "within the cap: parsed, not flagged",
  [within.isPayloadTooLarge, within.payloadTooLarge, within.body],
  [false, undefined, { a: 1 }],
);

const stream = new ReadableStream<Uint8Array>({
  start(controller) {
    for (let chunk = 0; chunk < 8; chunk++) {
      controller.enqueue(new Uint8Array(1024));
    }
    controller.close();
  },
});
const streamed = await BunRequest.init(
  new Request("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: stream,
    duplex: "half",
  } as RequestInit),
  FETCH_STUB_SERVER,
  { parseBody: { maxContentLength: "2kb" } },
);
check(
  "a streamed body with no Content-Length is cut off at the cap",
  streamed.isPayloadTooLarge && streamed.payloadTooLarge?.limit === 2048,
  streamed.payloadTooLarge,
);

const tooLarge = BunRequest.payloadTooLargeResponse(human);
checkEqual(
  "payloadTooLargeResponse()",
  [tooLarge.status, tooLarge.statusText, await tooLarge.json()],
  [
    413,
    "Payload Too Large",
    {
      statusCode: 413,
      error: "Payload Too Large",
      message: "Request body exceeds the maximum allowed size of 1024 bytes",
    },
  ],
);
const error = new PayloadTooLargeError(100, 250);
checkEqual(
  "PayloadTooLargeError fields",
  [error.name, error.statusCode, error.limit, error.length, error.message],
  [
    "PayloadTooLargeError",
    413,
    100,
    250,
    "Request body exceeds the maximum allowed size of 100 bytes (received 250 bytes)",
  ],
);

/* ------------------------------------------------------------------ */
step("parseBody.contentTypes: allowlist and per-kind opts");

const allowlisted = await make(
  "http://localhost/",
  postInit("<a>1</a>", "application/xml"),
  { parseBody: { contentTypes: { json: true, xml: false } } },
);
check(
  "a kind set to false (or omitted) stays a Buffer",
  Buffer.isBuffer(allowlisted.body),
);
checkEqual(
  "…its Content-Type kept",
  allowlisted.get("Content-Type"),
  "application/xml",
);
checkEqual(
  "contentTypes: 'all' parses every kind",
  (
    await make("http://localhost/", postInit("<a>1</a>", "application/xml"), {
      parseBody: { contentTypes: "all" },
    })
  ).body,
  { a: 1 },
);
checkEqual(
  "json.opts.reviver",
  (
    await make("http://localhost/", postInit('{"a":1}', "application/json"), {
      parseBody: {
        contentTypes: {
          json: {
            opts: {
              reviver: (_key, value) => {
                return typeof value === "number" ? value * 10 : value;
              },
            },
          },
        },
      },
    })
  ).body,
  { a: 10 },
);
checkEqual(
  "urlencoded.opts (picoquery)",
  (
    await make(
      "http://localhost/",
      postInit("a[b]=1", "application/x-www-form-urlencoded"),
      {
        parseBody: {
          contentTypes: { urlencoded: { opts: { nesting: false } } },
        },
      },
    )
  ).body,
  { "a[b]": "1" },
);
checkEqual(
  "text.opts.encoding",
  (
    await make(
      "http://localhost/",
      postInit(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain"),
      {
        parseBody: { contentTypes: { text: { opts: { encoding: "latin1" } } } },
      },
    )
  ).body,
  "café",
);
checkEqual(
  "xml.opts: attributeNamePrefix, textNodeName, parsePrimitives",
  (
    await make(
      "http://localhost/",
      postInit('<p c="EUR">9.50</p>', "application/xml"),
      {
        parseBody: {
          contentTypes: {
            xml: {
              opts: {
                attributeNamePrefix: "$",
                textNodeName: "_",
                parsePrimitives: false,
              },
            },
          },
        },
      },
    )
  ).body,
  { p: { $c: "EUR", _: "9.50" } },
);
checkEqual(
  "xml.opts.ignoreAttributes: true drops attributes (the default is false)",
  (
    await make(
      "http://localhost/",
      postInit('<a x="1"><b>2</b></a>', "application/xml"),
      {
        parseBody: {
          contentTypes: { xml: { opts: { ignoreAttributes: true } } },
        },
      },
    )
  ).body,
  { a: { b: 2 } },
);

const form = new FormData();
form.append("name", "ada");
form.append("meta", '{"n":1}');
form.append("file", new Blob(["file body"]), "a.txt");
const multipart = await make(
  "http://localhost/",
  { method: "POST", body: form },
  { parseBody: { contentTypes: { multipart: { opts: { inflate: false } } } } },
);
const parsedMultipart = await multipart.parseBody();
checkEqual(
  "multipart.opts.inflate: false keeps field strings",
  parsedMultipart.multipart?.fields,
  { name: "ada", meta: '{"n":1}' },
);
checkEqual(
  "…the parser kind is multipart, and body is not set",
  [parsedMultipart.contentType, multipart.body, multipart.isFormDataParsed],
  ["multipart", undefined, true],
);
const [uploaded] = [...(parsedMultipart.multipart?.files.keys() ?? [])];
checkEqual(
  "…files carry fieldname, filename and bytes",
  [uploaded?.fieldname, uploaded?.originalFilename, uploaded?.file.toString()],
  ["file", "a.txt", "file body"],
);
checkEqual(
  "getMultiParts() answers the cached parse",
  await multipart.getMultiParts({}),
  parsedMultipart.multipart!,
);

/* ------------------------------------------------------------------ */
step("Deprecated options and their setters");

checkEqual(
  "allowedContentTypes",
  Buffer.isBuffer(
    (
      await make("http://localhost/", postInit('{"a":1}', "application/json"), {
        parseBody: true,
        allowedContentTypes: ["xml"],
      })
    ).body,
  ),
  true,
);
checkEqual(
  "…an allowlist of nothing valid means no restriction",
  (
    await make("http://localhost/", postInit('{"a":1}', "application/json"), {
      parseBody: true,
      allowedContentTypes: [],
    })
  ).body,
  { a: 1 },
);
checkEqual(
  "parseXmlOpts",
  (
    await make("http://localhost/", postInit("<a>1</a>", "application/xml"), {
      parseBody: true,
      parseXmlOpts: { parsePrimitives: false },
    })
  ).body,
  { a: "1" },
);
checkEqual(
  "parseMultiPartFormDataOpts",
  (
    await (
      await make(
        "http://localhost/",
        { method: "POST", body: form },
        { parseBody: true, parseMultiPartFormDataOpts: { inflate: false } },
      )
    ).parseBody()
  ).multipart?.fields.meta,
  '{"n":1}',
);

const later = await make(
  "http://localhost/",
  postInit('{"a":1}', "application/json"),
);
check(
  "setAllowedContentTypes() returns the request",
  later.setAllowedContentTypes(["xml"]) === later,
);
await later.parseBody();
check("…and restricts the next parse", Buffer.isBuffer(later.body));
later.setAllowedContentTypes(undefined);
await later.parseBody(true);
checkEqual(
  "undefined lifts it; parseBody(true) re-parses the cached buffer",
  later.body,
  { a: 1 },
);

const xmlLater = await make(
  "http://localhost/",
  postInit("<a>1</a>", "application/xml"),
);
xmlLater.setXmlParserOptions({ parsePrimitives: false });
await xmlLater.parseBody();
checkEqual("setXmlParserOptions()", xmlLater.body, { a: "1" });
const formLater = await make("http://localhost/", {
  method: "POST",
  body: form,
});
formLater.setMultipartParserOptions({ inflate: false });
checkEqual(
  "setMultipartParserOptions()",
  (await formLater.parseBody()).multipart?.fields.meta,
  '{"n":1}',
);

/* ------------------------------------------------------------------ */
step(
  "Runtime body options: setParseBodyOptions, parseBodyWithOptions, handleBodyParsing",
);

const deferred = await make(
  "http://localhost/",
  postInit('{"a":1}', "application/json"),
);
check(
  "setParseBodyOptions() returns the request",
  deferred.setParseBodyOptions({ contentTypes: { xml: true } }) === deferred,
);
const first = await deferred.parseBody();
checkEqual(
  "parseBody() applies them",
  [first.contentType, Buffer.isBuffer(first.body)],
  ["buffer", true],
);
const cached = await deferred.parseBody();
checkEqual(
  "a second parseBody() answers the cached result",
  cached.buffer,
  first.buffer,
);
const again = await deferred.parseBodyWithOptions(
  { contentTypes: "all" },
  true,
);
checkEqual(
  "parseBodyWithOptions(opts, true) re-parses",
  [again.contentType, deferred.body, deferred.isBodyParsed],
  ["json", { a: 1 }, true],
);

const capLater = await make(
  "http://localhost/",
  postInit("x".repeat(5_000), "text/plain"),
);
await checkRejects(
  "parseBodyWithOptions() on an unread body over the cap",
  () => capLater.parseBodyWithOptions({ maxContentLength: "1kb" }),
  {
    name: "PayloadTooLargeError",
  },
);
check("…flags isPayloadTooLarge", capLater.isPayloadTooLarge);

const handled = await make("http://localhost/", postInit("abc", "text/plain"), {
  parseBody: true,
});
checkEqual(
  "handleBodyParsing(true) answers the buffer",
  (await handled.handleBodyParsing(true))?.toString(),
  "abc",
);
checkEqual(
  "handleBodyParsing(true) answers undefined when type does not match",
  await handled.handleBodyParsing(true, { type: "application/json" }),
  undefined,
);
checkEqual(
  "handleBodyParsing() answers nothing",
  await handled.handleBodyParsing(),
  undefined,
);
await checkRejects(
  "parseBody() of an already-consumed body",
  async () => {
    const consumed = await make(
      "http://localhost/",
      postInit("abc", "text/plain"),
    );
    await consumed.request.text();
    await consumed.parseBody();
  },
  { message: /Invalid body sent/ },
);

/* ------------------------------------------------------------------ */
step("Content-Encoding: inflation, decompressionFastPathLimit, bombs");

/** A POST of `body`, sent as JSON with `Content-Encoding: encoding`. */
function encodedInit(body: Uint8Array, encoding: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": encoding,
    },
    body,
  };
}

const zippedJson = gzipSync(Buffer.from('{"zipped":true}'));
checkEqual(
  "a gzip body is inflated before it is parsed",
  (
    await make("http://localhost/", encodedInit(zippedJson, "gzip"), {
      parseBody: true,
    })
  ).body,
  { zipped: true },
);

// 8 MiB of zeros: a few KB on the wire, far past the cap once inflated.
const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));
const bombed = await make("http://localhost/", encodedInit(bomb, "gzip"), {
  parseBody: { maxContentLength: "64kb" },
});
checkEqual(
  "a gzip bomb: the cap applies to the inflated size — 413",
  [
    bomb.length < 64 * 1024,
    bombed.isPayloadTooLarge,
    BunRequest.payloadTooLargeResponse(bombed).status,
  ],
  [true, true, 413],
);

// Set in the `parseBody` object, the decoding options reach the parse `init`
// runs — the one an adapter runs before any middleware.
const zlibAtInit = await make("http://localhost/", encodedInit(bomb, "gzip"), {
  parseBody: { maxContentLength: "64kb", decompressionFastPathLimit: 0 },
});
checkEqual(
  "parseBody.decompressionFastPathLimit: 0 — node:zlib stops the bomb at init, 413",
  [zlibAtInit.isPayloadTooLarge, zlibAtInit.payloadTooLarge?.limit],
  [true, 64 * 1024],
);
await checkRejects(
  "…and is read at init: a negative one is a RangeError",
  () =>
    make("http://localhost/", encodedInit(zippedJson, "gzip"), {
      parseBody: { decompressionFastPathLimit: -1 },
    }),
  { name: "RangeError", message: /decompressionFastPathLimit/ },
);
const refusedAtInit = await make(
  "http://localhost/",
  encodedInit(zippedJson, "gzip"),
  { parseBody: { inflate: false } },
);
checkEqual(
  "parseBody.inflate: false refuses a gzip body at init: no body, bodyDecodingError 415",
  [refusedAtInit.body, refusedAtInit.bodyDecodingError?.statusCode],
  [undefined, 415],
);
checkEqual(
  "…an identity body still parses, with no bodyDecodingError",
  await make("http://localhost/", postInit('{"a":1}', "application/json"), {
    parseBody: { inflate: false },
  }).then((req) => [req.body, req.bodyDecodingError]),
  [{ a: 1 }, undefined],
);
const identityOnly = new BunHttpAdapter(0, {
  request: { parseBody: { inflate: false } },
  logger: noopLogger,
});
identityOnly.post("/echo", (_req, res) => res.send("routed"));
checkEqual(
  "an adapter with parseBody.inflate: false answers 415 before routing",
  (await identityOnly.fetch("/echo", encodedInit(zippedJson, "gzip"))).status,
  415,
);
checkEqual(
  "…and the default adapter still inflates",
  await (
    await (() => {
      const inflating = new BunHttpAdapter(0);
      inflating.post("/echo", (req, res) => res.json(req.body ?? null));
      return inflating.fetch("/echo", encodedInit(zippedJson, "gzip"));
    })()
  ).json(),
  { zipped: true },
);

// From middleware, `handleBodyParsing`'s options apply to a body not read yet.
const bombLater = await make("http://localhost/", encodedInit(bomb, "gzip"));
bombLater.setParseBodyOptions(true);
await checkRejects(
  "decompressionFastPathLimit: 0 — node:zlib decodes, stopping at the limit",
  () =>
    bombLater.handleBodyParsing(true, {
      limit: "64kb",
      decompressionFastPathLimit: 0,
    }),
  { name: "PayloadTooLargeError" },
);

const compressed = await make(
  "http://localhost/",
  encodedInit(zippedJson, "compress"),
);
compressed.setParseBodyOptions(true);
await checkRejects(
  "an unsupported Content-Encoding (compress) is a 415",
  () => compressed.handleBodyParsing(true),
  { message: /unsupported content encoding "compress"/ },
);

/* ------------------------------------------------------------------ */
step(
  "Content-Encoding: zstd, stacked codings, encodings, maxContentCodings, compressionDictionaries",
);

const zstdJson = Bun.zstdCompressSync(Buffer.from('{"zipped":true}'));
checkEqual(
  "a zstd body is decoded before it is parsed",
  (
    await make("http://localhost/", encodedInit(zstdJson, "zstd"), {
      parseBody: true,
    })
  ).body,
  { zipped: true },
);
checkEqual(
  "stacked codings decode last to first: `gzip, br` is br, then gzip",
  (
    await make(
      "http://localhost/",
      encodedInit(brotliCompressSync(zippedJson), "gzip, br"),
      { parseBody: true },
    )
  ).body,
  { zipped: true },
);
checkEqual(
  "…with case, whitespace, empty elements and identity ignored",
  (
    await make(
      "http://localhost/",
      encodedInit(brotliCompressSync(zippedJson), " GZIP , identity,, Br"),
      { parseBody: true },
    )
  ).body,
  { zipped: true },
);
const zstdTruncated = await make(
  "http://localhost/",
  encodedInit(zstdJson.subarray(0, zstdJson.length - 1), "zstd"),
  { parseBody: {} },
);
checkEqual(
  "truncated zstd is a 400 at init — never an empty or partial body",
  [zstdTruncated.body, zstdTruncated.bodyDecodingError?.statusCode],
  [undefined, 400],
);
const zstdBomb = Bun.zstdCompressSync(Buffer.alloc(8 * 1024 * 1024));
const zstdBombed = await make(
  "http://localhost/",
  encodedInit(zstdBomb, "zstd"),
  { parseBody: { maxContentLength: "64kb" } },
);
checkEqual(
  "a zstd bomb declaring 8 MiB is a 413, refused before decoding",
  [zstdBomb.length < 1024, zstdBombed.isPayloadTooLarge],
  [true, true],
);

const onlyGzip = { parseBody: { encodings: ["gzip"] } } satisfies Options;
checkEqual(
  "parseBody.encodings: a listed coding decodes, and gzip admits x-gzip",
  [
    (await make("http://localhost/", encodedInit(zippedJson, "gzip"), onlyGzip))
      .body,
    (
      await make(
        "http://localhost/",
        encodedInit(zippedJson, "x-gzip"),
        onlyGzip,
      )
    ).body,
  ],
  [{ zipped: true }, { zipped: true }],
);
const zstdOutsideList = await make(
  "http://localhost/",
  encodedInit(zstdJson, "zstd"),
  onlyGzip,
);
const brLayerOutsideList = await make(
  "http://localhost/",
  encodedInit(brotliCompressSync(zippedJson), "gzip, br"),
  onlyGzip,
);
checkEqual(
  "…a coding outside it is a 415, in any layer of a stack",
  [
    zstdOutsideList.bodyDecodingError?.statusCode,
    brLayerOutsideList.bodyDecodingError?.statusCode,
  ],
  [415, 415],
);
checkEqual(
  '…a `*` sent as a coding is not a wildcard, even with encodings: "*"',
  (
    await make("http://localhost/", encodedInit(zippedJson, "*"), {
      parseBody: { encodings: "*" },
    })
  ).bodyDecodingError?.statusCode,
  415,
);
await checkRejects(
  "…and a misspelt coding is a RangeError",
  () =>
    make("http://localhost/", encodedInit(zippedJson, "gzip"), {
      parseBody: { encodings: ["gzpi" as never] },
    }),
  { name: "RangeError", message: /gzpi/ },
);

let sixLayers: Buffer = Buffer.from('{"deep":true}');
for (let layer = 0; layer < 6; layer++) {
  sixLayers = gzipSync(sixLayers);
}
const sixCodings = Array.from({ length: 6 }).fill("gzip").join(", ");
checkEqual(
  "maxContentCodings (default 5): six stacked codings are a 415",
  (
    await make("http://localhost/", encodedInit(sixLayers, sixCodings), {
      parseBody: {},
    })
  ).bodyDecodingError?.message,
  "too many content encodings (6, at most 5)",
);
checkEqual(
  "…raised to 6, they decode",
  (
    await make("http://localhost/", encodedInit(sixLayers, sixCodings), {
      parseBody: { maxContentCodings: 6 },
    })
  ).body,
  { deep: true },
);
const codingsLater = await make(
  "http://localhost/",
  encodedInit(sixLayers, sixCodings),
);
codingsLater.setParseBodyOptions(true);
await checkRejects(
  "…and handleBodyParsing takes the option too",
  () => codingsLater.handleBodyParsing(true, { maxContentCodings: 3 }),
  { message: /too many content encodings \(6, at most 3\)/ },
);

// dcz (RFC 9842 §5): the dictionary's SHA-256 in a 40-byte header, then zstd
// compressed against the dictionary. `@types/node` does not declare zstd's
// `dictionary` option, which Bun honours.
const sharedDictionary = Buffer.from('{"zipped":true,"shared":true}');
const zstdWithDictionary: (
  bytes: Uint8Array,
  options: { dictionary: Uint8Array; maxOutputLength?: number },
) => Buffer = zstdCompressSync;
const dczJson = Buffer.concat([
  dictionaryCompressedHeader(
    "dcz",
    compressionDictionaryHash(sharedDictionary),
  ),
  zstdWithDictionary(Buffer.from('{"zipped":true}'), {
    dictionary: sharedDictionary,
  }),
]);
checkEqual(
  "compressionDictionaries: a dcz body naming a provided dictionary decodes",
  (
    await make("http://localhost/", encodedInit(dczJson, "dcz"), {
      parseBody: { compressionDictionaries: [sharedDictionary] },
    })
  ).body,
  { zipped: true },
);
checkEqual(
  "…as it does through a resolver keyed by SHA-256",
  (
    await make("http://localhost/", encodedInit(dczJson, "dcz"), {
      parseBody: {
        compressionDictionaries: (hash) =>
          hash.equals(compressionDictionaryHash(sharedDictionary))
            ? sharedDictionary
            : undefined,
      },
    })
  ).body,
  { zipped: true },
);
checkEqual(
  "…a dictionary not provided is a 400; with no dictionaries, dcz is a 415",
  [
    (
      await make("http://localhost/", encodedInit(dczJson, "dcz"), {
        parseBody: { compressionDictionaries: [Buffer.from("another")] },
      })
    ).bodyDecodingError?.message,
    (
      await make("http://localhost/", encodedInit(dczJson, "dcz"), {
        parseBody: {},
      })
    ).bodyDecodingError?.statusCode,
  ],
  ["unknown compression dictionary", 415],
);

/* ------------------------------------------------------------------ */
step("get('set-cookie'): an array, as Node's req.headers");

const cookieHeaders = await make("http://localhost/", {
  headers: [
    ["Set-Cookie", "a=1"],
    ["Set-Cookie", "b=2"],
    ["X-Many", "x"],
    ["X-Many", "y"],
  ],
});
checkEqual(
  "get('Set-Cookie') answers every line",
  cookieHeaders.get("Set-Cookie"),
  ["a=1", "b=2"],
);
checkEqual(
  "…any other repeated header is one string",
  cookieHeaders.get("x-many"),
  "x, y",
);
checkEqual("…and absent, null", handled.get("set-cookie"), null);

/* ------------------------------------------------------------------ */
step("URL, method and headers");

const full = await make(
  "https://user:pw@api.staging.example.com:8443/a/b?x=1&y=2#frag",
  {
    method: "patch",
    headers: { "X-Test": "1", "X-Requested-With": "XMLHttpRequest" },
  },
  {},
  peerServer,
);
checkEqual(
  "url is the path, query and fragment (Express's req.url); baseUrl is ''",
  [full.url, full.baseUrl],
  ["/a/b?x=1&y=2#frag", ""],
);
checkEqual(
  "the absolute URL is request.url",
  full.request.url,
  "https://user:pw@api.staging.example.com:8443/a/b?x=1&y=2#frag",
);
checkEqual("method is upper-cased", full.method, "PATCH");
checkEqual(
  "path, search, querystring, hash",
  [full.path, full.search, full.querystring, full.hash],
  ["/a/b", "?x=1&y=2", "x=1&y=2", "#frag"],
);
checkEqual("originalUrl", full.originalUrl, "/a/b?x=1&y=2#frag");
checkEqual(
  "host (userinfo dropped), hostname",
  [full.host, full.hostname],
  ["api.staging.example.com:8443", "api.staging.example.com"],
);
check(
  "parsedUrl is a URL",
  full.parsedUrl instanceof URL && full.parsedUrl.port === "8443",
);
checkEqual("protocol, secure", [full.protocol, full.secure], ["https", true]);
checkEqual("subdomains (read directly)", full.subdomains, ["api", "staging"]);
checkEqual("xhr", full.xhr, true);
checkEqual(
  "httpVersion, major, minor",
  [full.httpVersion, full.httpVersionMajor, full.httpVersionMinor],
  ["1.1", "1", "1"],
);
checkEqual(
  "maxHeadersCount, reusedSocket",
  [full.maxHeadersCount, full.reusedSocket],
  [0, false],
);

const proxied = await make("http://shop.example.com/", {
  headers: {
    "X-Forwarded-Proto": "https, http",
    "X-Forwarded-For": "203.0.113.9, 10.0.0.2",
  },
});
checkEqual(
  "protocol from X-Forwarded-Proto (first entry)",
  [proxied.protocol, proxied.secure],
  ["https", true],
);
checkEqual("ips from X-Forwarded-For", proxied.ips, [
  "203.0.113.9",
  "10.0.0.2",
]);

checkEqual(
  "getHeader, get, get with a default",
  [
    full.getHeader("x-test"),
    full.get("X-Test"),
    full.get("X-None", "fallback"),
  ],
  ["1", "1", "fallback"],
);
checkEqual(
  "hasHeader",
  [full.hasHeader("X-TEST"), full.hasHeader("x-none")],
  [true, false],
);
checkEqual(
  "getHeaderNames / getRawHeaderNames",
  [full.getHeaderNames(), full.getRawHeaderNames()],
  [
    ["x-requested-with", "x-test"],
    ["X-Requested-With", "X-Test"],
  ],
);
checkEqual(
  "headers, getHeaders",
  [full.headers, full.getHeaders()],
  [
    { "x-requested-with": "XMLHttpRequest", "x-test": "1" },
    { "x-requested-with": "XMLHttpRequest", "x-test": "1" },
  ],
);
checkEqual("headersDistinct", full.headersDistinct, {
  "x-requested-with": ["XMLHttpRequest"],
  "x-test": ["1"],
});
checkEqual("rawHeaders", full.rawHeaders, [
  "x-requested-with",
  "XMLHttpRequest",
  "x-test",
  "1",
]);
full.setHeader("X-Added", ["a", "b"]);
full.setHeader("X-Added", "c", false);
checkEqual(
  "setHeader: array, then append",
  full.getHeader("X-Added"),
  "a, b, c",
);
full.removeHeader("X-Added");
checkEqual("removeHeader", full.hasHeader("X-Added"), false);
full.headers = { replaced: "yes" };
checkEqual("headers is assignable", full.headers, { replaced: "yes" });
check(
  "headersObj is the native Headers",
  full.headersObj === full.request.headers,
);

/* ------------------------------------------------------------------ */
step("Peer: socketAddress, ip, socket shim");

checkEqual("socketAddress from the server", full.socketAddress, {
  address: "203.0.113.7",
  port: 51234,
  family: "IPv4",
});
checkEqual("ip", full.ip, "203.0.113.7");
checkEqual(
  "socket.localAddress / localPort / localFamily",
  [full.socket.localAddress, full.socket.localPort, full.socket.localFamily],
  ["203.0.113.7", 51234, "IPv4"],
);
check(
  "setNoDelay / setTimeout return the socket, as Node's do",
  full.socket.setNoDelay(true) === full.socket &&
    full.socket.setTimeout(0) === full.socket,
);
check(
  "the socket is an emitter (NestJS @Sse waits on once('close'))",
  full.socket.once("close", () => {}) === full.socket &&
    full.socket.listenerCount("close") === 1,
);
check("isKeepAlive is false until setKeepAlive(true)", !full.isKeepAlive);
full.socket.setKeepAlive(true);
check("…then true", full.isKeepAlive && full.socket.keepAlive);
const noPeer = await make("http://localhost/");
checkEqual(
  "with the fetch stub: no peer",
  [noPeer.socketAddress, noPeer.ip],
  [null, ""],
);

/* ------------------------------------------------------------------ */
step("Content negotiation: is(), accepts*, range()");

const negotiating = await make("http://localhost/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": "2",
    Accept: "text/html, application/json;q=0.9",
    "Accept-Encoding": "gzip, br;q=0.5",
    "Accept-Charset": "utf-8, iso-8859-1;q=0.5",
    "Accept-Language": "en-GB, fr;q=0.8",
    Range: "bytes=0-9,5-19,-10",
  },
  body: "{}",
});
checkEqual(
  "is()",
  [
    negotiating.is("json"),
    negotiating.is("application/*"),
    negotiating.is(["html", "json"]),
    negotiating.is("html"),
  ],
  ["json", "application/json", "json", false],
);
checkEqual(
  "is() without a body is null",
  (await make("http://localhost/")).is("json"),
  null,
);
checkEqual("accepts()", negotiating.accepts(), [
  "text/html",
  "application/json",
]);
checkEqual(
  "accepts(...types) picks the preferred",
  negotiating.accepts("json", "html"),
  "html",
);
checkEqual(
  "accepts([types]) and acceptsTypes / acceptsType",
  [
    negotiating.accepts(["json"]),
    negotiating.acceptsTypes("xml"),
    negotiating.acceptsType("json"),
  ],
  ["json", false, "json"],
);
checkEqual("acceptsEncodings()", negotiating.acceptsEncodings(), [
  "gzip",
  "br",
  "identity",
]);
checkEqual(
  "acceptsEncodings(...) and acceptsEncoding",
  [
    negotiating.acceptsEncodings("br", "gzip"),
    negotiating.acceptsEncoding(["deflate"]),
  ],
  ["gzip", false],
);
checkEqual(
  "acceptsCharsets() / (...) / acceptsCharset",
  [
    negotiating.acceptsCharsets(),
    negotiating.acceptsCharsets("iso-8859-1"),
    negotiating.acceptsCharset("utf-16"),
  ],
  [["utf-8", "iso-8859-1"], "iso-8859-1", false],
);
checkEqual(
  "acceptsLanguages() / (...) / acceptsLanguage",
  [
    negotiating.acceptsLanguages(),
    negotiating.acceptsLanguages("fr", "en-GB"),
    negotiating.acceptsLanguage("de"),
  ],
  [["en-GB", "fr"], "en-GB", false],
);

const ranges = negotiating.range(100, undefined);
checkEqual(
  "range(size)",
  ranges === -1 || ranges === -2 || ranges === undefined
    ? ranges
    : [ranges.type, [...ranges]],
  [
    "bytes",
    [
      { start: 0, end: 9 },
      { start: 5, end: 19 },
      { start: 90, end: 99 },
    ],
  ],
);
const combined = negotiating.range(100, { combine: true });
checkEqual(
  "range(size, { combine: true })",
  combined === -1 || combined === -2 || combined === undefined
    ? combined
    : [...combined],
  [
    { start: 0, end: 19 },
    { start: 90, end: 99 },
  ],
);
checkEqual(
  "unsatisfiable: -1",
  (
    await make("http://localhost/", { headers: { Range: "bytes=500-600" } })
  ).range(100, undefined),
  -1,
);
checkEqual(
  "malformed: -2",
  (await make("http://localhost/", { headers: { Range: "garbage" } })).range(
    100,
    undefined,
  ),
  -2,
);
checkEqual(
  "no Range header: undefined",
  noPeer.range(100, undefined),
  undefined,
);

/* ------------------------------------------------------------------ */
step("fresh and stale, setResponse()");

const conditional = await make("http://localhost/", {
  headers: { "If-None-Match": '"v1"' },
});
checkEqual(
  "no response bound: not fresh",
  [conditional.fresh, conditional.stale],
  [false, true],
);
const conditionalRes = new BunResponse(conditional).set("ETag", '"v1"');
check(
  "setResponse() returns the request",
  conditional.setResponse(conditionalRes) === conditional,
);
checkEqual(
  "a matching ETag: fresh",
  [conditional.fresh, conditional.stale],
  [true, false],
);
conditionalRes.status(500);
checkEqual("…but not for a non-2xx status", conditional.fresh, false);

/* ------------------------------------------------------------------ */
step("params, query, body, cookies, route and subdomains are assignable");

const assignable = await make("http://localhost/");
assignable.params = { id: "7" };
assignable.query = { page: "2" };
assignable.body = { set: true };
assignable.cookies = { a: "1" };
assignable.signedCookies = { b: "2" };
assignable.subdomains = ["x"];
assignable.parsedUrl = new URL("http://other.test/");
checkEqual(
  "each reads back",
  [
    assignable.params,
    assignable.query,
    assignable.body,
    assignable.cookies,
    assignable.signedCookies,
    assignable.subdomains,
    assignable.parsedUrl.host,
  ],
  [
    { id: "7" },
    { page: "2" },
    { set: true },
    { a: "1" },
    { b: "2" },
    ["x"],
    "other.test",
  ],
);

const routed = new BunRouter();
let seen: Pick<BunRequest, "params" | "subdomains" | "route"> | undefined;
routed.get("/users/:id", (req, res) => {
  seen = { params: req.params, subdomains: req.subdomains, route: req.route };
  res.send("ok");
});
await routed.fetch("http://api.example.com/users/42");
checkEqual("the router binds params", seen?.params, { id: "42" });
// Known issue: `subdomains` is documented (and typed) as `string[]` that "the
// router may override with the matched route's subdomains"; the router assigns
// an empty object `{}` for a route without a subdomain pattern.
check(
  "the router leaves subdomains an array (as documented)",
  Array.isArray(seen?.subdomains),
  seen?.subdomains,
);

/* ------------------------------------------------------------------ */
step("Uploaded files: setStorageFiles, files/file, storageFiles/storageFile");

const uploads = await make("http://localhost/");
checkEqual(
  "no files: [] and undefined",
  [uploads.files, uploads.file],
  [[], undefined],
);
/** An `avatar` upload named `originalFilename`, as `MemoryStorage` stores it. */
function storedAvatar(originalFilename: string): MemoryStorageFile {
  return {
    type: "memory",
    buffer: Buffer.from(originalFilename),
    size: originalFilename.length,
    mimetype: "image/png",
    encoding: "7bit",
    fieldname: "avatar",
    originalFilename,
    validatedMimeType: undefined,
  };
}
const one = storedAvatar("a.png");
const two = storedAvatar("b.png");
uploads.setStorageFiles([one, two]);
check(
  "an array: file is the first",
  uploads.file === one &&
    uploads.storageFile === one &&
    uploads.files.length === 2,
);
uploads.storageFiles = { avatar: [two, one] };
check("a record: file is the first of the first field", uploads.file === two);

/* ------------------------------------------------------------------ */
step("Events: data/end, error, aborted/close, abort, and the emitter API");

const bodied = await make(
  "http://localhost/",
  postInit("hello body", "text/plain"),
  { parseBody: true },
);
const chunks: string[] = [];
let ended = false;
bodied.on("data", (chunk) => {
  chunks.push(chunk.toString());
});
bodied.once("end", () => {
  ended = true;
});
await waitFor("data and end", () => ended);
checkEqual(
  "data carries the body; end follows; complete is true",
  [chunks.join(""), bodied.complete],
  ["hello body", true],
);

const errored = await make(
  "http://localhost/",
  postInit("x".repeat(2_000), "text/plain"),
  { parseBody: { maxContentLength: 10 } },
);
// `unknown`, as the `error` event types it: whatever the body parse threw.
let bodyError: unknown;
errored.on("error", (caught) => {
  bodyError = caught;
});
await waitFor("error", () => bodyError !== undefined);
check(
  "error carries the parse failure",
  bodyError instanceof PayloadTooLargeError,
);
check("…and complete stays false", !errored.complete);

const controller = new AbortController();
const abortable = await BunRequest.init(
  new Request("http://localhost/", { signal: controller.signal }),
  FETCH_STUB_SERVER,
  { parseBody: false, parseCookies: false, parseQuery: false },
);
const lifecycle: string[] = [];
abortable.on("aborted", () => lifecycle.push("aborted"));
abortable.addListener("close", () => lifecycle.push("close"));
controller.abort();
await waitFor("close", () => lifecycle.includes("close"));
checkEqual(
  "an abort before a response: aborted, then close",
  [lifecycle, abortable.aborted],
  [["aborted", "close"], true],
);

const responded = new AbortController();
const answered = await BunRequest.init(
  new Request("http://localhost/", { signal: responded.signal }),
  FETCH_STUB_SERVER,
  { parseBody: false },
);
const afterResponse: string[] = [];
answered.on("aborted", () => afterResponse.push("aborted"));
answered.on("close", () => afterResponse.push("close"));
check(
  "markResponded() returns the request",
  answered.markResponded() === answered,
);
responded.abort();
await waitFor("close", () => afterResponse.includes("close"));
checkEqual(
  "after a response: close only, aborted false",
  [afterResponse, answered.aborted],
  [["close"], false],
);

const cancelled = await make("http://localhost/");
const cancelledRes = new BunResponse(cancelled);
// `unknown`, as the `abort` event types it: whatever the consumer cancelled with.
let abortReason: unknown;
cancelled.on("abort", (reason) => {
  abortReason = reason;
});
cancelledRes.write("data");
await cancelledRes.getWritable().abort("client gone");
checkEqual(
  "abort: a streaming response was cancelled",
  abortReason,
  "client gone",
);

const api = await make("http://localhost/");
checkEqual("emit() with no emitter answers false", api.emit("close"), false);
checkEqual("getMaxListeners() before an emitter", api.getMaxListeners(), 10);
const order: string[] = [];
const listener = (): void => {
  order.push("on");
};
api.on("close", listener);
api.prependListener("close", () => order.push("prepended"));
api.prependOnceListener("close", () => order.push("prepended once"));
checkEqual(
  "listenerCount / listeners / eventNames",
  [api.listenerCount("close"), api.listeners("close").length, api.eventNames()],
  [3, 3, ["close"]],
);
api.emit("close");
api.emit("close");
checkEqual("prepend order, and once fires once", order, [
  "prepended once",
  "prepended",
  "on",
  "prepended",
  "on",
]);
api.off("close", listener);
api.removeListener("close", listener);
checkEqual("off / removeListener", api.listenerCount("close"), 1);
check("setMaxListeners() returns the request", api.setMaxListeners(3) === api);
checkEqual("getMaxListeners()", api.getMaxListeners(), 3);
api.on("end", () => {});
api.removeAllListeners("close");
checkEqual("removeAllListeners(event)", api.eventNames(), ["end"]);
api.removeAllListeners();
checkEqual("removeAllListeners()", api.eventNames(), []);
checkEqual("end() is a no-op", api.end(), undefined);

summary();
