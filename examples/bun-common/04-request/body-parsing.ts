/**
 * Body parsing — every `parseBody` form, every content kind and its options,
 * size caps and the 413 they produce, custom parsers and the raw body.
 *
 * ```bash
 * bun 04-request/body-parsing.ts
 * ```
 *
 * Request options belong to the adapter — `new BunHttpAdapter(timeout,
 * { request })` — so this example uses `adapter.fetch()`, which runs the very
 * handler `Bun.serve` would, 413 guard included. (`BunRouter.fetch()` always
 * parses with `parseBody: true`.)
 *
 * Worth knowing before reading it:
 *
 * - `parseBody: true` is **uncapped**. Only the object form caps sizes, and it
 *   defaults to `DEFAULT_MAX_CONTENT_LENGTH` (100kb) — 10mb for `multipart`
 *   and `raw` (`DEFAULT_MAX_CONTENT_LENGTH_BY_KIND`).
 * - A body over its cap is refused with 413 **before** any middleware runs.
 * - A `gzip`/`deflate`/`br`/`zstd` body is decoded first, and the cap applies
 *   to the **decoded** size — a decompression bomb is a 413 too. Codings may
 *   be stacked (`gzip, br`, decoded last to first), which body-parser refuses.
 *   The object form also takes `inflate` (`false` refuses an encoded body with
 *   415), `decompressionFastPathLimit`, `encodings` (an allowlist),
 *   `maxContentCodings` and `compressionDictionaries` (for `dcb`/`dcz`); they
 *   apply to the parse the adapter runs while building the request, before
 *   any middleware.
 * - An invalid size or decoding option — a `maxContentLength` (top-level or
 *   per kind) that does not parse or is negative, NaN or Infinity, an unknown
 *   coding in `encodings`, a `maxContentCodings` that is not a non-negative
 *   integer or Infinity, a `compressionDictionaries` of the wrong shape —
 *   throws where it is configured: the adapter's constructor,
 *   `setRequestOpts()` (which then keeps its previous options) and
 *   `requestParsing()`. A bodiless request never resolves `parseBody`, so
 *   nothing would catch it later. `validateParseBodyOption()` runs the same
 *   check on options built elsewhere, such as from a config file.
 * - A kind left out of a `contentTypes` allowlist is not parsed: `req.body`
 *   is the raw `Buffer`, and the `Content-Type` header is kept.
 * - A media type no parser knows (`application/x-ndjson`, say) is kept as a
 *   `Buffer` too, but its `Content-Type` is **rewritten** to
 *   `application/octet-stream` — so a custom parser should run with
 *   `parseBody: false` and look at the header before parsing anything.
 * - Multipart bodies land in `parseBody()`'s `multipart` result, not in
 *   `req.body`.
 * - `req.setParseBodyOptions()`, `setQueryParserOptions()`,
 *   `setMultipartParserOptions()`, `setXmlParserOptions()` and
 *   `setAllowedContentTypes()` tailor **that request only**: the adapter hands
 *   every request the same options object, and a setter copies it before its
 *   first write, so raising the cap on one route never raises it for the
 *   requests after it. `requestParsing()` wraps these as middleware, and the
 *   adapter's `deferBody` lets a route raise its cap before the body is read:
 *   see `per-route-parsing.ts`.
 * - A body with no cap, or with a `Content-Length` within its cap and no
 *   `Transfer-Encoding`, is read in one native call and parsed
 *   synchronously; a chunked body under a cap streams under it. Either way
 *   the decoded length is checked after the read, so a `Content-Length` that
 *   understates the body is still a 413, and a served request and
 *   `adapter.fetch()` answer alike.
 * - Invalid JSON in a body declared JSON (`application/json`, `+json`) is a
 *   400, as body-parser answers it: a `SyntaxError` carrying `status` and
 *   `statusCode` 400, `expose: true`, `type: "entity.parse.failed"` and the
 *   text in `err.body`, recorded as `req.bodyDecodingError`. Unhandled, the
 *   adapter answers it with its HTML error page (`Bad Request`). Read while the
 *   request is built, it fails before routing and reaches `setErrorHandler`;
 *   read inside the pipeline (`deferBody` with `requestParsing()`), it goes
 *   to `next(err)`. A body with no `Content-Type` is only *tried* as JSON.
 * - The final handler logs a 4xx at `warn` and a 5xx at `error` (nothing
 *   under `NODE_ENV=test`); `err.req` is attached non-enumerable.
 * - A body-parser middleware (`useBodyParser`, `registerParserMiddleware`,
 *   what Nest's body parser calls) passes a request without a body
 *   (`req.hasBody`) straight on, before its type or encoding is looked at,
 *   and leaves `req.rawBody` unset for it.
 * - A declared empty body (`Content-Length: 0`) parses as before: `{}` for
 *   JSON. A GET or HEAD with no body stream reads no header while it is
 *   built, so with a refused `Content-Encoding` it is routed: the refusal
 *   lands in `req.bodyDecodingError` when the body is read, and a body
 *   parser or `parseBody()` rejects with it (415), so `next(err)` answers.
 *   Any other method checks first and is refused before routing.
 * - Every body keeps its exact bytes by default (`retainBuffer` defaults to
 *   `true`). Dropping them is opt-in: with `retainBuffer: false` (a request
 *   option, `requestParsing({ retainBuffer })`, or per kind with
 *   `parseBody.contentTypes.<kind>.retainBuffer`) a JSON body with a
 *   Content-Length is parsed with one native `request.json()` call, and text,
 *   urlencoded and xml with `request.text()`: `req.body` is the same, but
 *   `req.buffer` and `req.rawBody` are absent, a `data` listener gets only
 *   `end`, and an invalid body's 400 has no `err.body`. Raw and multipart
 *   always keep their bytes. Under a cap, `adapter.fetch()` still reads as
 *   bytes.
 * - With the default, `req.buffer` holds the exact bytes received — the "raw body" a
 *   webhook signature is computed over.
 */
import type {
  BunRequestOptions,
  DefaultRequestBody,
  JsonValue,
  ParseBodyOption,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import {
  BunHttpAdapter,
  BunRequest,
  compressionDictionaryHash,
  createTestLogger,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  dictionaryCompressedHeader,
  FETCH_STUB_SERVER,
  parseXmlToObject,
  PayloadTooLargeError,
  requestParsing,
  validateParseBodyOption,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Body parsing");

/** Every adapter made here, closed at the end. */
const adapters: BunHttpAdapter[] = [];

/** A JSON-safe picture of whatever `req.body` holds: a Buffer shown as its text. */
function describeBody(
  req: BunRequest,
): Exclude<DefaultRequestBody, undefined> | { buffer: string } {
  const body = req.body;
  if (Buffer.isBuffer(body)) {
    return { buffer: body.toString("utf8") };
  }
  return body ?? null;
}

/** An adapter with the given request options and a `POST /echo` route. */
function echoAdapter(request: BunRequestOptions): BunHttpAdapter {
  const adapter = new BunHttpAdapter(0, { request });
  adapter.post("/echo", (req, res) => {
    res.json({
      body: describeBody(req),
      contentType: req.get("Content-Type") ?? null,
    });
  });
  adapters.push(adapter);
  return adapter;
}

/**
 * POSTs `body` to `/echo` with an optional Content-Type; answers the JSON —
 * wrapped with the status when it is not a 200.
 */
async function post(
  adapter: BunHttpAdapter,
  body: string | Uint8Array,
  contentType?: string,
): Promise<JsonValue> {
  const response = await adapter.fetch({
    url: "/echo",
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : {},
    body,
  });
  // `JSON.parse` output is exactly a `JsonValue`.
  const json: JsonValue = JSON.parse(await response.text());
  return response.status === 200
    ? json
    : { status: response.status, body: json };
}

/* ------------------------------------------------------------------ */
step("parseBody: true — every kind, by Content-Type");

const everything = echoAdapter({ parseBody: true });

show(
  "json",
  await post(everything, '{"title":"hello","n":1}', "application/json"),
);
show(
  "+json suffix",
  await post(everything, '{"ok":true}', "application/vnd.api+json"),
);
show(
  "urlencoded",
  await post(
    everything,
    "name=ada&tags=a&tags=b&address[city]=Lagos",
    "application/x-www-form-urlencoded",
  ),
);
show("text", await post(everything, "just words", "text/plain"));
show(
  "xml (attributes prefixed @_, numbers coerced)",
  await post(
    everything,
    '<order id="7"><item>book</item><qty>2</qty></order>',
    "application/xml",
  ),
);
show(
  "raw",
  await post(
    everything,
    new Uint8Array([104, 105]),
    "application/octet-stream",
  ),
);

/* ------------------------------------------------------------------ */
step("Without a Content-Type: JSON, then XML, then urlencoded is tried");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
show("looks like JSON", await post(everything, bytes('{"guessed":"json"}')));
show("looks like XML", await post(everything, bytes("<ping><n>1</n></ping>")));
show(
  "anything else parses as urlencoded",
  await post(everything, bytes("a=1&b=2")),
);

/* ------------------------------------------------------------------ */
step("parseBody object form: caps and their defaults");

show("DEFAULT_MAX_CONTENT_LENGTH", DEFAULT_MAX_CONTENT_LENGTH);
show("DEFAULT_MAX_CONTENT_LENGTH_BY_KIND", DEFAULT_MAX_CONTENT_LENGTH_BY_KIND);

const capped = echoAdapter({
  parseBody: {
    maxContentLength: "1kb",
    contentTypes: {
      json: true,
      text: { maxContentLength: 16 },
      raw: true,
    },
  },
});

show(
  "a small JSON body",
  await post(capped, '{"fits":true}', "application/json"),
);
show(
  "JSON over the 1kb config-level cap",
  await post(
    capped,
    JSON.stringify({ pad: "x".repeat(2_000) }),
    "application/json",
  ),
);
show(
  "text over its own 16-byte cap",
  await post(
    capped,
    "this sentence is longer than sixteen bytes",
    "text/plain",
  ),
);

/* ------------------------------------------------------------------ */
step("contentTypes allowlist: a kind left out stays a Buffer, header kept");

show(
  "xml is not in the allowlist",
  await post(capped, "<a>1</a>", "application/xml"),
);

/* ------------------------------------------------------------------ */
step("Per-kind parser options: json, urlencoded, xml, text, multipart");

const tuned = echoAdapter({
  parseBody: {
    contentTypes: {
      json: {
        opts: {
          // Revive ISO dates into a marker, to show the reviver ran.
          reviver: (_key, value) => {
            return typeof value === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(value)
              ? `date(${value})`
              : value;
          },
        },
      },
      // picoquery options: no nesting — brackets stay part of the key.
      urlencoded: { opts: { nesting: false } },
      xml: {
        opts: {
          attributeNamePrefix: "$",
          textNodeName: "_",
          parsePrimitives: false,
        },
      },
      text: { opts: { encoding: "latin1" } },
      multipart: { opts: { inflate: true, limits: { fileSize: 1024 } } },
    },
  },
});

show(
  "json reviver",
  await post(tuned, '{"due":"2031-01-28"}', "application/json"),
);
show(
  "urlencoded { nesting: false }",
  await post(tuned, "a[b]=1", "application/x-www-form-urlencoded"),
);
show(
  "xml { attributeNamePrefix, textNodeName, parsePrimitives }",
  await post(tuned, '<price currency="EUR">9.50</price>', "application/xml"),
);
show(
  "text { encoding: latin1 }",
  await post(tuned, new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain"),
);

tuned.post("/form", async (req, res) => {
  // Multipart is parsed into the `multipart` result, not `req.body`.
  const { multipart, contentType } = await req.parseBody();
  res.json({
    contentType,
    fields: multipart?.fields ?? null,
    files: [...(multipart?.files.keys() ?? [])].map((file) => {
      return {
        field: file.fieldname,
        name: file.originalFilename,
        bytes: file.file.length,
      };
    }),
    isFormDataParsed: req.isFormDataParsed,
  });
});

const form = new FormData();
form.append("name", "ada");
form.append("profile", '{"langs":["ts","go"]}');
form.append("avatar", new Blob(["pretend image"]), "avatar.png");
show(
  "multipart (inflate: JSON field values expanded)",
  await (
    await tuned.fetch({ url: "/form", method: "POST", body: form })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("parseXmlToObject: the XML parser, on its own");

show(
  "defaults",
  parseXmlToObject('<feed version="2"><entry>a</entry><entry>b</entry></feed>'),
);
show(
  "ignoreAttributes: true",
  parseXmlToObject('<feed version="2"><entry>a</entry></feed>', {
    ignoreAttributes: true,
  }),
);

/* ------------------------------------------------------------------ */
step("parseBody: false, then a custom parser and a per-route cap");

const custom = new BunHttpAdapter(0, { request: { parseBody: false } });
adapters.push(custom);

custom.use(async (req, _res, next) => {
  if (req.is("application/x-ndjson")) {
    // A kind the library does not know: read and parse it ourselves.
    const text = await req.request.text();
    req.body = text
      .split("\n")
      .filter(Boolean)
      .map((line): JsonValue => JSON.parse(line));
  } else if (req.method === "POST") {
    // Everything else: parse now, with a tight cap for this app.
    await req.parseBodyWithOptions({
      maxContentLength: 64,
      contentTypes: "all",
    });
  }
  next();
});

custom.post("/echo", (req, res) => {
  res.json({
    body: describeBody(req),
    isPayloadTooLarge: req.isPayloadTooLarge,
  });
});

custom.use(((error, req, res, _next) => {
  if (error instanceof PayloadTooLargeError) {
    res.status(error.statusCode).json({
      limit: error.limit,
      length: error.length ?? null,
      flagged: req.payloadTooLarge ?? null,
    });
    return;
  }
  res.status(500).json({ error: String(error) });
}) satisfies RouterErrorMiddlewareHandler);

const ndjson = '{"n":1}\n{"n":2}\n';
show(
  "application/x-ndjson, parsed by our middleware",
  await (
    await custom.fetch({
      url: "/echo",
      method: "POST",
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Length": String(ndjson.length),
      },
      body: ndjson,
    })
  ).json(),
);
show(
  "JSON within the 64-byte route cap",
  await (
    await custom.fetch({
      url: "/echo",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"ok":1}',
    })
  ).json(),
);
const tooBig = await custom.fetch({
  url: "/echo",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pad: "y".repeat(100) }),
});
show(
  `JSON over it: ${tooBig.status}, PayloadTooLargeError caught`,
  await tooBig.json(),
);

/* ------------------------------------------------------------------ */
step("Compressed bodies: inflated first, capped after inflation");

const gzipHeaders = {
  "Content-Type": "application/json",
  "Content-Encoding": "gzip",
};
// 8 MiB of zeros: a few KB on the wire, far past any cap once inflated.
const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024));

const zipped = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: "64kb" } },
});
adapters.push(zipped);
zipped.post("/echo", (req, res) => {
  res.json({ body: describeBody(req) });
});

show(
  "gzip JSON, inflated before parsing",
  await (
    await zipped.fetch({
      url: "/echo",
      method: "POST",
      headers: gzipHeaders,
      body: gzipSync(JSON.stringify({ zipped: true })),
    })
  ).json(),
);
const bombed = await zipped.fetch({
  url: "/echo",
  method: "POST",
  headers: gzipHeaders,
  body: bomb,
});
show(
  `a gzip bomb (${bomb.length} bytes sent, 8 MiB inflated): ${bombed.status}`,
  await bombed.json(),
);

// The decoding options sit in the same `parseBody` object as the caps, so they
// reach the parse the adapter runs while building the request.
// `decompressionFastPathLimit: 0` skips Bun's uncapped decoder: node:zlib
// stops at the limit instead of inflating all 8 MiB first.
const zlibOnly = new BunHttpAdapter(0, {
  request: {
    parseBody: { maxContentLength: "64kb", decompressionFastPathLimit: 0 },
  },
});
adapters.push(zlibOnly);
zlibOnly.post("/echo", (req, res) => {
  res.json({ body: describeBody(req) });
});

const zlibBombed = await zlibOnly.fetch({
  url: "/echo",
  method: "POST",
  headers: gzipHeaders,
  body: bomb,
});
show(
  `decompressionFastPathLimit: 0, the same bomb: ${zlibBombed.status}`,
  await zlibBombed.json(),
);

// `inflate: false` refuses any encoded body with 415, before a route runs —
// through the adapter's error handling, as body-parser's `next(err)`.
const identityOnly = new BunHttpAdapter(0, {
  request: { parseBody: { inflate: false } },
});
adapters.push(identityOnly);
identityOnly.post("/echo", (req, res) => {
  res.json({ body: describeBody(req) });
});
identityOnly.setErrorHandler(((error, _req, res, _next) => {
  const status =
    error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 500;
  res.status(status).json({
    status,
    message: error instanceof Error ? error.message : String(error),
  });
  return res;
}) satisfies RouterErrorMiddlewareHandler);

const refusedGzip = await identityOnly.fetch({
  url: "/echo",
  method: "POST",
  headers: gzipHeaders,
  body: gzipSync(JSON.stringify({ zipped: true })),
});
show(
  `inflate: false, a gzip body: ${refusedGzip.status}`,
  await refusedGzip.json(),
);
show(
  "…an identity body still parses",
  await post(identityOnly, '{"plain":true}', "application/json"),
);

/* ------------------------------------------------------------------ */
step("zstd, stacked codings, an encodings allowlist and dictionaries");

// A dictionary client and server share by arrangement — browsers do not send
// dictionary-compressed request bodies.
const sharedDictionary = Buffer.from(
  JSON.stringify({ zipped: true, dictionary: "shared by arrangement" }),
);

const decoding = new BunHttpAdapter(0, {
  request: {
    parseBody: {
      maxContentLength: "64kb",
      // Every coding but deflate (and dcb), at most three stacked.
      encodings: ["gzip", "br", "zstd", "dcz"],
      maxContentCodings: 3,
      compressionDictionaries: [sharedDictionary],
    },
  },
});
adapters.push(decoding);
decoding.post("/echo", (req, res) => {
  res.json({ body: describeBody(req) });
});
decoding.setErrorHandler(((error, _req, res, _next) => {
  const status =
    error instanceof Error && "statusCode" in error
      ? Number(error.statusCode)
      : 500;
  res.status(status).json({
    status,
    message: error instanceof Error ? error.message : String(error),
  });
  return res;
}) satisfies RouterErrorMiddlewareHandler);

/** POSTs `body` as JSON with `Content-Encoding: encoding`; answers status and JSON. */
async function sendEncoded(
  body: Uint8Array,
  encoding: string,
): Promise<JsonValue> {
  const response = await decoding.fetch({
    url: "/echo",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": encoding,
    },
    body,
  });
  const json: JsonValue = JSON.parse(await response.text());
  return { status: response.status, json };
}

const payload = Buffer.from(JSON.stringify({ zipped: true }));
show("zstd JSON", await sendEncoded(Bun.zstdCompressSync(payload), "zstd"));
show(
  "gzip, br: gzip was applied first, so br is decoded first",
  await sendEncoded(brotliCompressSync(gzipSync(payload)), "gzip, br"),
);
const zstdBomb = Bun.zstdCompressSync(Buffer.alloc(8 * 1024 * 1024));
show(
  `a zstd bomb (${zstdBomb.length} bytes, 8 MiB declared), refused undecoded`,
  await sendEncoded(zstdBomb, "zstd"),
);
show(
  "deflate is outside encodings",
  await sendEncoded(deflateSync(payload), "deflate"),
);
show(
  "four stacked codings, over maxContentCodings: 3",
  await sendEncoded(
    gzipSync(gzipSync(gzipSync(gzipSync(payload)))),
    "gzip, gzip, gzip, gzip",
  ),
);
show(
  "Content-Encoding: * is not a wildcard, just an unknown coding",
  await sendEncoded(payload, "*"),
);

// dcz (RFC 9842): a 40-byte header naming the dictionary by SHA-256, then zstd
// compressed against it. `@types/node` does not declare zstd's `dictionary`
// option, which Bun honours.
const zstdWithDictionary: (
  bytes: Uint8Array,
  options: { dictionary: Uint8Array; maxOutputLength?: number },
) => Buffer = zstdCompressSync;
const dczHeader = dictionaryCompressedHeader(
  "dcz",
  compressionDictionaryHash(sharedDictionary),
);
show(
  "dcz, compressed against the shared dictionary",
  await sendEncoded(
    Buffer.concat([
      dczHeader,
      zstdWithDictionary(payload, { dictionary: sharedDictionary }),
    ]),
    "dcz",
  ),
);
const otherDictionary = Buffer.from("a dictionary the server does not have");
show(
  "dcz naming a dictionary the server lacks",
  await sendEncoded(
    Buffer.concat([
      dictionaryCompressedHeader(
        "dcz",
        compressionDictionaryHash(otherDictionary),
      ),
      zstdWithDictionary(payload, { dictionary: otherDictionary }),
    ]),
    "dcz",
  ),
);

/* ------------------------------------------------------------------ */
step("The raw body: verify a webhook signature over req.buffer");

const webhookSecret = "whsec_example";
const hooks = new BunHttpAdapter(0, { request: { parseBody: true } });
adapters.push(hooks);

hooks.post("/webhook", async (req, res) => {
  // `req.buffer` is the bytes as received; `handleBodyParsing(true)` hands
  // back the same buffer, parsing first if nothing has yet — or `undefined`
  // when there is nothing to hand back (a consumed body), so fall back to "".
  const raw = req.buffer ?? (await req.handleBodyParsing(true)) ?? "";
  const expected = createHmac("sha256", webhookSecret)
    .update(raw)
    .digest("hex");
  const valid = req.get("X-Signature") === expected;
  res.status(valid ? 200 : 401).json({ valid, event: describeBody(req) });
});

const event = JSON.stringify({ type: "invoice.paid", id: "in_1" });
const signature = createHmac("sha256", webhookSecret)
  .update(event)
  .digest("hex");
for (const [label, sig] of [
  ["correct signature", signature],
  ["forged signature", "0".repeat(64)],
] as const) {
  const response = await hooks.fetch({
    url: "/webhook",
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": sig },
    body: event,
  });
  show(`${label}: ${response.status}`, await response.json());
}

/* ------------------------------------------------------------------ */
step("Per-request options: a setter changes its own request only");

const shared = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 16 }, parseQuery: true },
});
adapters.push(shared);
const sharedBefore = structuredClone(shared.requestOpts);

// One route tailors everything it can: the body cap (lifted entirely), the
// query parser, the multipart and XML options and the allowed content types.
shared.post("/tailor", (req, res) => {
  req
    .setParseBodyOptions(true)
    .setQueryParserOptions({ nesting: false })
    .setMultipartParserOptions({ limits: { files: 1 } })
    .setXmlParserOptions({ parsePrimitives: false })
    .setAllowedContentTypes(["json"]);
  res.json({ query: req.parseQuery() });
});
// Another uses whatever the adapter says.
shared.post("/plain", (req, res) => {
  res.json({ query: req.query, body: describeBody(req) });
});

/** POSTs `body` as text to `path` on the shared adapter. */
function postText(path: string, body: string): Promise<Response> {
  return shared.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
}

const oversized = "x".repeat(64);
checkEqual(
  "before: 64 bytes is over the 16-byte cap",
  (await postText("/plain", oversized)).status,
  413,
);
const tailored = await postText("/tailor?a[b]=1", "tiny");
checkEqual(
  "the tailoring route re-parses its query flat",
  await tailored.json(),
  { query: { "a[b]": "1" } },
);
checkEqual(
  "after: still a 413 — the lifted cap stayed on its own request",
  (await postText("/plain", oversized)).status,
  413,
);
const plain = await postText("/plain?a[b]=1", "short text");
checkEqual(
  "…the query still nests and text is still parsed",
  await plain.json(),
  { query: { a: { b: "1" } }, body: "short text" },
);
check(
  "adapter.requestOpts is exactly as it was",
  Bun.deepEquals(shared.requestOpts, sharedBefore, true),
  { before: sharedBefore, after: shared.requestOpts },
);

/* ------------------------------------------------------------------ */
step("Body-parser middleware passes a request with no body straight on");

// useBodyParser / registerParserMiddleware are what Nest's body parser
// calls. As body-parser's read() does, a request without a body (no
// Content-Length, no Transfer-Encoding, no body stream: `req.hasBody`) is
// passed on synchronously, before its type or encoding is looked at.
const parsers = new BunHttpAdapter(0);
adapters.push(parsers);
parsers.setLogger(createTestLogger().logger);
parsers.useBodyParser("json", true, { inflate: false, limit: 32 });
parsers.all("/echo", (req, res) => {
  res.json({
    hasBody: req.hasBody,
    body: describeBody(req),
    rawBody: req.rawBody === undefined ? "undefined" : req.rawBody.toString(),
  });
});
const bodilessGzip = await parsers.fetch("/echo", {
  headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
});
checkEqual(
  "a GET claiming gzip with inflate: false — no body, so 200, not 415",
  [bodilessGzip.status, await bodilessGzip.json()],
  [200, { hasBody: false, body: null, rawBody: "undefined" }],
);
checkEqual(
  "a POST: parsed, and rawBody holds its bytes",
  await (
    await parsers.fetch("/echo", bodyInit("application/json", '{"a":1}'))
  ).json(),
  { hasBody: true, body: { a: 1 }, rawBody: '{"a":1}' },
);
checkEqual(
  "a gzip POST with inflate: false: 415",
  (
    await parsers.fetch(
      "/echo",
      bodyInit("application/json", gzipSync('{"a":1}'), {
        "Content-Encoding": "gzip",
      }),
    )
  ).status,
  415,
);
checkEqual(
  "a POST over its limit of 32: 413",
  (
    await parsers.fetch(
      "/echo",
      bodyInit("application/json", JSON.stringify({ pad: "x".repeat(60) })),
    )
  ).status,
  413,
);
const inProcess = (await BunRequest.init(
  new Request("http://localhost/", { method: "POST", body: "x" }),
  FETCH_STUB_SERVER,
  { parseBody: false },
)) as BunRequest;
checkEqual(
  "req.hasBody: true for an in-process Request with a body stream, false without",
  [
    inProcess.hasBody,
    (
      BunRequest.init(new Request("http://localhost/"), FETCH_STUB_SERVER, {
        parseBody: false,
      }) as BunRequest
    ).hasBody,
  ],
  [true, false],
);

/* ------------------------------------------------------------------ */
step("A declared empty body: Content-Length: 0 and no body stream");

// A GET or HEAD with no body stream reads no header while it is built; the
// first read of the body's state checks Content-Length/Transfer-Encoding.
// Every other method reads them first, as reading `request.body` on a
// request that has one would slow its read. (In process, `body: ""`
// creates a stream; headers alone, with no `body`, are the no-stream case.)
const emptyJson = { "Content-Type": "application/json", "Content-Length": "0" };
const empty = new BunHttpAdapter(0);
adapters.push(empty);
empty.all("/echo", (req, res) => res.json({ body: req.body ?? null }));
await empty.listen(0);
for (const method of ["POST", "GET"]) {
  checkEqual(
    `an empty JSON ${method}: req.body is {}, served and through fetch()`,
    [
      await (
        await fetch(`${empty.url}/echo`, { method, headers: emptyJson })
      ).json(),
      await (await empty.fetch("/echo", { method, headers: emptyJson })).json(),
    ],
    [{ body: {} }, { body: {} }],
  );
}

// With a refused Content-Encoding (inflate: false), the two halves part.
const refusing = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64, inflate: false } },
});
adapters.push(refusing);
refusing.setLogger(createTestLogger().logger);
/** Paths whose handler ran. */
const handled: string[] = [];
refusing.all("/ignores-body", (req, res) => {
  handled.push(`${req.method} ${req.path}`);
  res.send("handler answered");
});
refusing.all("/reads-body", (req, res) => {
  res.json({
    body: req.body ?? null,
    refusal: req.bodyDecodingError?.status ?? null,
  });
});
// Middleware ahead of /parsed that reads the body, and passes on its error.
refusing.use("/parsed", (req, _res, next) => {
  req.parseBody().then(
    () => next(),
    (error: unknown) => next(error as Error),
  );
});
refusing.all("/parsed", (req, res) => res.json({ body: req.body ?? null }));
await refusing.listen(0);
const gzipEmpty = { ...emptyJson, "Content-Encoding": "gzip" };

/** `"<status> <text>"` of `method path`, served and through fetch(). */
async function emptyBothWays(method: string, path: string) {
  const init = { method, headers: gzipEmpty };
  const served = await fetch(`${refusing.url}${path}`, init);
  const offline = await refusing.fetch(path, init);
  return [
    `${served.status} ${served.status < 400 ? await served.text() : ""}`,
    `${offline.status} ${offline.status < 400 ? await offline.text() : ""}`,
  ];
}

// A POST (or PUT, PATCH, DELETE…) is refused before routing, as always.
checkEqual(
  "POST, gzip + Content-Length: 0: 415 before routing, both ways",
  await emptyBothWays("POST", "/ignores-body"),
  ["415 ", "415 "],
);
checkEqual("…the handler never ran", handled.splice(0), []);

// A GET or HEAD is routed; the refusal comes when the body is read.
checkEqual(
  "GET, gzip + Content-Length: 0: a handler that never reads the body answers",
  await emptyBothWays("GET", "/ignores-body"),
  ["200 handler answered", "200 handler answered"],
);
checkEqual("…it ran both times", handled.splice(0), [
  "GET /ignores-body",
  "GET /ignores-body",
]);
checkEqual(
  "…one that reads req.body finds the 415 in req.bodyDecodingError",
  await emptyBothWays("GET", "/reads-body"),
  ['200 {"body":null,"refusal":415}', '200 {"body":null,"refusal":415}'],
);
checkEqual(
  "…parseBody() in a middleware before the route rejects: next(err) answers 415",
  await emptyBothWays("GET", "/parsed"),
  ["415 ", "415 "],
);
const parserFirst = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64, inflate: false } },
});
adapters.push(parserFirst);
parserFirst.setLogger(createTestLogger().logger);
parserFirst.useBodyParser("json", false, { inflate: false });
parserFirst.all("/x", (req, res) => res.json({ body: req.body ?? null }));
await parserFirst.listen(0);
checkEqual(
  "…as does a json body parser registered before the route",
  [
    (await fetch(`${parserFirst.url}/x`, { headers: gzipEmpty })).status,
    (await parserFirst.fetch("/x", { headers: gzipEmpty })).status,
  ],
  [415, 415],
);
checkEqual(
  "a body with data and that encoding is refused before routing",
  (
    await fetch(`${refusing.url}/ignores-body`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: '{"a":1}',
    })
  ).status,
  415,
);

/* ------------------------------------------------------------------ */
step("One read, parsed at once: a served request and adapter.fetch() agree");

const fast = new BunHttpAdapter(0, {
  request: {
    parseBody: {
      maxContentLength: 64,
      contentTypes: {
        json: true,
        urlencoded: true,
        text: { opts: { encoding: "latin1" } },
      },
    },
  },
});
adapters.push(fast);
// A corrupt body is a client error: logged at warn (a 5xx would be error),
// recorded here so the step can assert it.
const { logger: fastLogger, events: fastEvents } = createTestLogger();
fast.setLogger(fastLogger);
// The final handler logs nothing under NODE_ENV=test; make sure it is on.
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = "development";
fast.post("/echo", (req, res) => {
  res.json({ body: describeBody(req), parsed: req.body !== undefined });
});
/** What `req.on("data"/"end")` delivered on `/events`. */
let delivered: { bytes: string; ended: boolean } | undefined;
fast.post("/events", (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    delivered = { bytes: Buffer.concat(chunks).toString(), ended: true };
    res.json({ body: describeBody(req) });
  });
});
await fast.listen(0);

/** A POST of `body` as `type`, with optional extra headers. */
function bodyInit(
  type: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": type, ...headers },
    body,
  };
}

/** `"<status> <body>"` for one response. */
async function statusAndBody(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

const fastCases: [string, RequestInit, number][] = [
  ["JSON", bodyInit("application/json", '{"a":1}'), 200],
  ["+json", bodyInit("application/vnd.api+json", '{"a":2}'), 200],
  ["urlencoded", bodyInit("application/x-www-form-urlencoded", "a=1&b=2"), 200],
  [
    "latin1 text",
    bodyInit("text/plain", new Uint8Array([0x63, 0x61, 0x66, 0xe9])),
    200,
  ],
  [
    "gzip JSON",
    bodyInit("application/json", gzipSync('{"z":1}'), {
      "Content-Encoding": "gzip",
    }),
    200,
  ],
  ["invalid JSON", bodyInit("application/json", '{"a":'), 400],
  ["invalid +json", bodyInit("application/vnd.api+json", '{"a":'), 400],
  [
    "corrupt gzip",
    bodyInit("application/json", new Uint8Array([1, 2, 3, 4, 5]), {
      "Content-Encoding": "gzip",
    }),
    400,
  ],
  [
    "a declared over-cap body",
    bodyInit("application/json", JSON.stringify({ pad: "x".repeat(100) })),
    413,
  ],
];
for (const [label, init, status] of fastCases) {
  const served = await statusAndBody(await fetch(`${fast.url}/echo`, init));
  const offline = await statusAndBody(await fast.fetch("/echo", init));
  show(label, served.replace(/\s+/g, " ").slice(0, 70));
  checkEqual(`${label}: ${status}`, Number(served.split(" ")[0]), status);
  checkEqual(`${label}: served and adapter.fetch() agree`, offline, served);
}
checkEqual(
  "the parsed bodies",
  await Promise.all(
    fastCases.slice(0, 5).map(async ([, init]) => {
      const response = await fetch(`${fast.url}/echo`, init);
      return ((await response.json()) as { body: unknown }).body;
    }),
  ),
  [{ a: 1 }, { a: 2 }, { a: "1", b: "2" }, "café", { z: 1 }],
);

const clientErrorLogs = fastEvents.filter(
  (event) => event.message === "Unhandled error while handling a request",
);
check(
  "every client error above was logged at warn, not error",
  clientErrorLogs.length > 0 &&
    clientErrorLogs.every((event) => event.level === "warn"),
  clientErrorLogs.map((event) => [event.level, event.error?.message]),
);
const logged = clientErrorLogs[0]?.error as
  | (Error & { req?: unknown })
  | undefined;
check(
  "…with err.req still readable, but hidden from Object.keys",
  logged?.req !== undefined && !Object.keys(logged ?? {}).includes("req"),
  logged === undefined ? "nothing logged" : Object.keys(logged),
);
fast.get("/fail", () => {
  throw new Error("a server fault");
});
fastEvents.length = 0;
await fast.fetch("/fail");
checkEqual(
  "a 5xx is logged at error",
  fastEvents.map((event) => event.level),
  ["error"],
);
process.env.NODE_ENV = nodeEnvBefore;

/** A chunked JSON body: a stream, so no Content-Length is sent. */
function chunked(padding: number): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ pad: "x".repeat(padding) }),
          ),
        );
        controller.close();
      },
    }),
  };
}
for (const [padding, status] of [
  [5, 200],
  [200, 413],
] as const) {
  checkEqual(
    `a chunked body of ~${padding + 10} bytes under the 64-byte cap: ${status}, both ways`,
    [
      (await fetch(`${fast.url}/echo`, chunked(padding))).status,
      (await fast.fetch("/echo", chunked(padding))).status,
    ],
    [status, status],
  );
}

// In process a Request can carry a Content-Length that understates its
// body; the length is checked again after the read.
const lying = new Request("http://localhost/echo", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": "10" },
  body: JSON.stringify({ pad: "x".repeat(100) }),
});
checkEqual(
  "a Content-Length of 10 on a ~110-byte body: still 413",
  (await fast.fetch(lying)).status,
  413,
);

const eventsResponse = await fetch(
  `${fast.url}/events`,
  bodyInit("application/json", '{"e":1}'),
);
checkEqual(
  "req.on('data'/'end') on a body read in one call",
  { response: await eventsResponse.json(), delivered },
  {
    response: { body: { e: 1 } },
    delivered: { bytes: '{"e":1}', ended: true },
  },
);

/* ------------------------------------------------------------------ */
step(
  "retainBuffer: false — a plain JSON body read with request.json(), no bytes kept",
);

// Bodies keep their bytes by default. With retainBuffer: false, a body
// declared JSON with no Content-Encoding, no reviver and a Content-Length is
// parsed in one native request.json() call, which gives no bytes back. A
// served request always has a Content-Length; an in-process Request needs
// one set explicitly, or it is read as bytes.

/** A JSON POST to `path` carrying an explicit Content-Length. */
function jsonRequest(path: string, text: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(text)),
    },
    body: text,
  });
}

/** An adapter whose `/echo` reports body, buffer and body events. */
function jsonApp(request: BunRequestOptions): BunHttpAdapter {
  const app = new BunHttpAdapter(0, { request });
  adapters.push(app);
  app.setLogger(createTestLogger().logger);
  app.post("/echo", (req, res) => {
    const events: string[] = [];
    req.on("data", () => events.push("data"));
    req.on("end", () => {
      events.push("end");
      res.json({
        body: req.body ?? null,
        buffer: req.buffer === undefined ? "undefined" : req.buffer.toString(),
        events,
      });
    });
  });
  app.setErrorHandler(((error, _req, res, _next) => {
    const parseError = error as Error & {
      status: number;
      type: string;
      body?: string;
    };
    res.status(parseError.status).json({
      type: parseError.type,
      body: parseError.body ?? null,
    });
  }) satisfies RouterErrorMiddlewareHandler);
  return app;
}

const nativeJson = jsonApp({ parseBody: true, retainBuffer: false });
await nativeJson.listen(0);
const viaJson = { body: { a: 1 }, buffer: "undefined", events: ["end"] };
checkEqual(
  "retainBuffer: false — parsed, no req.buffer, a data listener gets only end",
  [
    await (
      await fetch(
        `${nativeJson.url}/echo`,
        bodyInit("application/json", '{"a":1}'),
      )
    ).json(),
    await (await nativeJson.fetch(jsonRequest("/echo", '{"a":1}'))).json(),
  ],
  [viaJson, viaJson],
);
checkEqual(
  "…an in-process Request without a Content-Length is read as bytes",
  await (
    await nativeJson.fetch("/echo", bodyInit("application/json", '{"a":1}'))
  ).json(),
  { body: { a: 1 }, buffer: '{"a":1}', events: ["data", "end"] },
);
checkEqual(
  "…invalid JSON is still a 400 entity.parse.failed, without err.body",
  await (await nativeJson.fetch(jsonRequest("/echo", '{"a":'))).json(),
  { type: "entity.parse.failed", body: null },
);

const retained = jsonApp({ parseBody: true });
await retained.listen(0);
const viaBytes = { body: { a: 1 }, buffer: '{"a":1}', events: ["data", "end"] };
checkEqual(
  "by default — the exact bytes in req.buffer, and data events",
  [
    await (
      await fetch(
        `${retained.url}/echo`,
        bodyInit("application/json", '{"a":1}'),
      )
    ).json(),
    await (await retained.fetch(jsonRequest("/echo", '{"a":1}'))).json(),
  ],
  [viaBytes, viaBytes],
);
checkEqual(
  "…and invalid JSON carries its text in err.body",
  await (await retained.fetch(jsonRequest("/echo", '{"a":'))).json(),
  { type: "entity.parse.failed", body: '{"a":' },
);
const cappedJson = jsonApp({ parseBody: { maxContentLength: "1kb" } });
checkEqual(
  "under a cap, by default: read as bytes",
  (
    (await (
      await cappedJson.fetch(jsonRequest("/echo", '{"a":1}'))
    ).json()) as {
      buffer: string;
    }
  ).buffer,
  '{"a":1}',
);

// A deferred body, bytes off by default here: requestParsing() can ask for
// them, and its cap and a body parser's limit are checked against
// Content-Length.
const deferredJson = new BunHttpAdapter(0, {
  request: { parseBody: true, deferBody: true, retainBuffer: false },
});
adapters.push(deferredJson);
deferredJson.setLogger(createTestLogger().logger);
deferredJson.use(
  "/capped",
  requestParsing({ parseBody: { maxContentLength: 8 } }),
);
deferredJson.use(
  "/kept",
  requestParsing({ parseBody: true, retainBuffer: true }),
);
deferredJson.post("/*", (req, res) => {
  res.json({ body: req.body ?? null, buffer: req.buffer?.toString() ?? null });
});
deferredJson.use(((error, _req, res, _next) => {
  res.status((error as { status: number }).status).send("refused");
}) satisfies RouterErrorMiddlewareHandler);
const seventeen = '{"a":"123456789"}';
checkEqual(
  "requestParsing({ parseBody: { maxContentLength: 8 } }): 413 from Content-Length",
  (await deferredJson.fetch(jsonRequest("/capped", seventeen))).status,
  413,
);
checkEqual(
  "requestParsing({ retainBuffer: true }) on a deferred body: the bytes kept",
  await (await deferredJson.fetch(jsonRequest("/kept", seventeen))).json(),
  { body: { a: "123456789" }, buffer: seventeen },
);
checkEqual(
  "…elsewhere: parsed with no bytes",
  await (await deferredJson.fetch(jsonRequest("/plain", seventeen))).json(),
  { body: { a: "123456789" }, buffer: null },
);
const limited = new BunHttpAdapter(0, {
  request: { parseBody: true, deferBody: true, retainBuffer: false },
});
adapters.push(limited);
limited.setLogger(createTestLogger().logger);
limited.useBodyParser("json", false, { limit: 8 });
limited.post("/x", (req, res) => res.json({ body: req.body ?? null }));
checkEqual(
  "a body parser's limit of 8: 413 from Content-Length",
  (await limited.fetch(jsonRequest("/x", seventeen))).status,
  413,
);

// A body parser registered with rawBody turns retainBuffer on for good,
// unless the options said retainBuffer: false explicitly.
const raw = new BunHttpAdapter(0);
adapters.push(raw);
const retainBefore = raw.requestOpts.retainBuffer === true;
raw.useBodyParser("json", true, {});
const retainAfter = raw.requestOpts.retainBuffer === true;
raw.setRequestOpts({ parseBody: true });
checkEqual(
  "useBodyParser(type, rawBody: true) sets retainBuffer, kept after setRequestOpts()",
  [retainBefore, retainAfter, raw.requestOpts.retainBuffer === true],
  [false, true, true],
);
raw.post("/raw", (req, res) => {
  res.json({
    rawBody: req.rawBody?.toString() ?? null,
    body: req.body ?? null,
  });
});
checkEqual(
  "…so req.rawBody keeps working for a JSON body with a Content-Length",
  await (await raw.fetch(jsonRequest("/raw", '{"b":2}'))).json(),
  { rawBody: '{"b":2}', body: { b: 2 } },
);
const noBytes = new BunHttpAdapter(0, {
  request: { parseBody: true, retainBuffer: false },
});
adapters.push(noBytes);
noBytes.useBodyParser("json", true, {});
noBytes.post("/raw", (req, res) => {
  res.json({
    rawBody: req.rawBody?.toString() ?? null,
    buffer: req.buffer?.toString() ?? null,
    body: req.body ?? null,
  });
});
checkEqual(
  "explicit retainBuffer: false with a rawBody parser: parsed, no req.rawBody or req.buffer",
  await (await noBytes.fetch(jsonRequest("/raw", '{"b":2}'))).json(),
  { rawBody: null, buffer: null, body: { b: 2 } },
);

/* ------------------------------------------------------------------ */
step("retainBuffer per content type, and for every kind");

/** An adapter with `request`, whose `/echo` reports body and buffer. */
async function bufferApp(request: BunRequestOptions): Promise<BunHttpAdapter> {
  const app = new BunHttpAdapter(0, { request });
  adapters.push(app);
  app.setLogger(createTestLogger().logger);
  app.post("/echo", (req, res) => {
    res.json({
      body: describeBody(req),
      buffer: req.buffer === undefined ? "undefined" : req.buffer.toString(),
    });
  });
  await app.listen(0);
  return app;
}

/** A served POST of `text` as `type` (Bun sends its Content-Length). */
async function servedEcho(app: BunHttpAdapter, type: string, text: string) {
  const response = await fetch(`${app.url}/echo`, bodyInit(type, text));
  return (await response.json()) as { body: unknown; buffer: string };
}

const jsonOff = await bufferApp({
  parseBody: { contentTypes: { json: { retainBuffer: false } } },
  retainBuffer: true,
});
checkEqual(
  "global retainBuffer: true, json { retainBuffer: false }: JSON keeps no bytes",
  await servedEcho(jsonOff, "application/json", '{"a":1}'),
  { body: { a: 1 }, buffer: "undefined" },
);
const jsonOn = await bufferApp({
  parseBody: { contentTypes: { json: { retainBuffer: true } } },
  retainBuffer: false,
});
checkEqual(
  "global retainBuffer: false, json { retainBuffer: true }: JSON keeps its bytes",
  await servedEcho(jsonOn, "application/json", '{"a":1}'),
  { body: { a: 1 }, buffer: '{"a":1}' },
);

const keepNothing = await bufferApp({ parseBody: true, retainBuffer: false });
const keepAll = await bufferApp({ parseBody: true });
for (const [label, type, text] of [
  ["text", "text/plain", "hello"],
  ["urlencoded", "application/x-www-form-urlencoded", "a=1&b=2"],
  ["xml", "application/xml", "<a>1</a>"],
] as const) {
  const withoutBytes = await servedEcho(keepNothing, type, text);
  const withBytes = await servedEcho(keepAll, type, text);
  checkEqual(
    `${label}, retainBuffer: false: the same req.body as the byte path, no req.buffer`,
    [withoutBytes.body, withoutBytes.buffer, withBytes.buffer],
    [withBytes.body, "undefined", text],
  );
}
checkEqual(
  "raw, retainBuffer: false: raw always keeps its bytes",
  await servedEcho(keepNothing, "application/octet-stream", "raw bytes"),
  { body: { buffer: "raw bytes" }, buffer: "raw bytes" },
);

// Under a cap with retainBuffer: false, a served request whose
// Content-Length is within it is read without bytes; an in-process one
// (adapter.fetch()) is read as bytes.
const cappedBytes = await bufferApp({
  parseBody: { maxContentLength: 64 },
  retainBuffer: false,
});
checkEqual(
  "capped JSON, retainBuffer: false: served keeps no bytes, adapter.fetch() keeps them",
  [
    (await servedEcho(cappedBytes, "application/json", '{"a":1}')).buffer,
    (
      (await (
        await cappedBytes.fetch(jsonRequest("/echo", '{"a":1}'))
      ).json()) as { buffer: string }
    ).buffer,
  ],
  ["undefined", '{"a":1}'],
);
checkEqual(
  "…and a served body over the cap is still 413",
  (
    await fetch(
      `${cappedBytes.url}/echo`,
      bodyInit("application/json", JSON.stringify({ pad: "x".repeat(100) })),
    )
  ).status,
  413,
);

const notBoolean = {
  contentTypes: { json: { retainBuffer: "yes" } },
} as unknown as ParseBodyOption;
checkEqual(
  "a non-boolean contentTypes.<kind>.retainBuffer: TypeError at the constructor, setRequestOpts() and requestParsing()",
  [
    outcome(
      () => new BunHttpAdapter(0, { request: { parseBody: notBoolean } }),
    ),
    outcome(() =>
      new BunHttpAdapter(0).setRequestOpts({ parseBody: notBoolean }),
    ),
    outcome(() => requestParsing({ parseBody: notBoolean })),
  ],
  ["TypeError", "TypeError", "TypeError"],
);

/* ------------------------------------------------------------------ */
step("Invalid JSON is a 400, as body-parser answers it");

// Read while the request is built, the body fails before routing, so its
// error reaches setErrorHandler — never `use()` error middleware.
const strict = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64 } },
});
adapters.push(strict);
strict.setLogger(createTestLogger().logger);
const middlewareSaw: string[] = [];
strict.post("/echo", (req, res) => res.json({ body: describeBody(req) }));
strict.use(((error, _req, res, _next) => {
  middlewareSaw.push((error as Error).message);
  res.status(500).send("not reached for a body error");
}) satisfies RouterErrorMiddlewareHandler);
strict.setErrorHandler(((error, req, res, _next) => {
  const parseError = error as Error & {
    status: number;
    statusCode: number;
    expose: boolean;
    type: string;
    body: string;
  };
  res.status(parseError.status).json({
    name: parseError.name,
    syntaxError: parseError instanceof SyntaxError,
    status: parseError.status,
    statusCode: parseError.statusCode,
    expose: parseError.expose,
    type: parseError.type,
    body: parseError.body,
    recorded: req.bodyDecodingError === error,
  });
}) satisfies RouterErrorMiddlewareHandler);
await strict.listen(0);

const brokenJson = bodyInit("application/json", '{"a":');
const strictServed = await fetch(`${strict.url}/echo`, brokenJson);
const strictAnswer = await strictServed.json();
checkEqual(
  "setErrorHandler sees the parse error, a SyntaxError",
  strictAnswer,
  {
    name: "SyntaxError",
    syntaxError: true,
    status: 400,
    statusCode: 400,
    expose: true,
    type: "entity.parse.failed",
    body: '{"a":',
    recorded: true,
  },
);
checkEqual(
  "…the same through adapter.fetch()",
  await (await strict.fetch("/echo", brokenJson)).json(),
  strictAnswer,
);
checkEqual("…and use() error middleware never saw it", middlewareSaw, []);

// With no setErrorHandler, the adapter's final handler answers the 400 with
// bun-common's own error page, as Express's finalhandler does (bun-nest's
// adapter answers Nest's JSON instead).
const plainAdapter = new BunHttpAdapter(0);
adapters.push(plainAdapter);
plainAdapter.setLogger(createTestLogger().logger);
plainAdapter.post("/echo", (req, res) => res.json({ body: describeBody(req) }));
const plainAnswer = await plainAdapter.fetch("/echo", brokenJson);
checkEqual(
  "…and with no setErrorHandler: 400, the final handler's HTML page",
  [
    plainAnswer.status,
    plainAnswer.headers.get("Content-Type"),
    /<pre>Bad Request<\/pre>/.test(await plainAnswer.text()),
  ],
  [400, "text/html; charset=utf-8", true],
);

checkEqual(
  "no Content-Type: only tried as JSON, so a=1 parses as urlencoded",
  await (await strict.fetch("/echo", { method: "POST", body: "a=1" })).json(),
  { body: { a: "1" } },
);
const rawJson = new BunHttpAdapter(0, {
  request: {
    parseBody: { maxContentLength: 64, contentTypes: { urlencoded: true } },
  },
});
rawJson.post("/echo", (req, res) => res.json({ body: describeBody(req) }));
const rawAnswer = await rawJson.fetch("/echo", brokenJson);
checkEqual(
  "JSON left out of contentTypes: the body stays raw, 200",
  [rawAnswer.status, await rawAnswer.json()],
  [200, { body: { buffer: '{"a":' } }],
);

// With deferBody the body is read inside the pipeline, by requestParsing()
// here, so the error goes to next(err) and use() error middleware.
const lazy = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 64 }, deferBody: true },
});
lazy.use("/upload", requestParsing({ parseBody: { maxContentLength: "1mb" } }));
lazy.post("/upload", (req, res) => res.json({ body: describeBody(req) }));
lazy.use(((error, req, res, _next) => {
  const parseError = error as Error & { status: number; type: string };
  res.status(parseError.status).json({
    via: "next(err)",
    type: parseError.type,
    recorded: req.bodyDecodingError === error,
  });
}) satisfies RouterErrorMiddlewareHandler);
const lazyAnswer = await lazy.fetch("/upload", brokenJson);
checkEqual(
  "deferBody + requestParsing(): the 400 goes to next(err)",
  [lazyAnswer.status, await lazyAnswer.json()],
  [400, { via: "next(err)", type: "entity.parse.failed", recorded: true }],
);

/* ------------------------------------------------------------------ */
step("Invalid decoding options fail where they are configured");

/** Runs `configure` and answers the error's name, or `"ok"`. */
function outcome(configure: () => unknown): string {
  try {
    configure();
    return "ok";
  } catch (error) {
    return (error as Error).name;
  }
}

/** Each invalid `parseBody` and the error it is refused with. */
const invalidParseBody: [string, unknown, string][] = [
  [
    "an unknown coding in encodings",
    { encodings: ["gzip", "lzma"] },
    "RangeError",
  ],
  ["a negative maxContentCodings", { maxContentCodings: -1 }, "RangeError"],
  ["a fractional maxContentCodings", { maxContentCodings: 1.5 }, "RangeError"],
  ["maxContentLength: 'lots'", { maxContentLength: "lots" }, "RangeError"],
  ["maxContentLength: -5", { maxContentLength: -5 }, "RangeError"],
  ["maxContentLength: NaN", { maxContentLength: Number.NaN }, "RangeError"],
  [
    "maxContentLength: Infinity",
    { maxContentLength: Number.POSITIVE_INFINITY },
    "RangeError",
  ],
  [
    "a per-kind maxContentLength that does not parse",
    { contentTypes: { json: { maxContentLength: "lots" } } },
    "RangeError",
  ],
  [
    "compressionDictionaries as a string",
    { compressionDictionaries: "dictionary.bin" },
    "TypeError",
  ],
  [
    "compressionDictionaries holding strings",
    { compressionDictionaries: ["not bytes"] },
    "TypeError",
  ],
];
for (const [label, value, expected] of invalidParseBody) {
  const parseBody = value as ParseBodyOption;
  checkEqual(
    `${label}: the adapter constructor, setRequestOpts(), requestParsing() and validateParseBodyOption() all throw ${expected}`,
    [
      outcome(() => new BunHttpAdapter(0, { request: { parseBody } })),
      outcome(() => new BunHttpAdapter(0).setRequestOpts({ parseBody })),
      outcome(() => requestParsing({ parseBody })),
      outcome(() => validateParseBodyOption(parseBody)),
    ],
    [expected, expected, expected, expected],
  );
}

const kept = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: 16 } },
});
adapters.push(kept);
kept.post("/echo", (req, res) => res.json({ body: describeBody(req) }));
const keptBefore = structuredClone(kept.requestOpts);
checkEqual(
  "setRequestOpts() with a bad coding throws",
  outcome(() =>
    kept.setRequestOpts({
      parseBody: { maxContentLength: "1mb", encodings: ["gzip", "lzma"] },
    } as Partial<BunRequestOptions>),
  ),
  "RangeError",
);
checkEqual("…and keeps its previous options", kept.requestOpts, keptBefore);
checkEqual(
  "…so the old 16-byte cap still answers 413",
  (
    await kept.fetch("/echo", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(64),
    })
  ).status,
  413,
);

for (const [label, parseBody] of [
  ["true", true],
  ["false", false],
  ["undefined (the adapter default)", undefined],
  [
    "caps, every coding and a coding limit",
    {
      maxContentLength: "1mb",
      encodings: ["gzip", "deflate", "br", "zstd"],
      maxContentCodings: 2,
    },
  ],
  [
    "dictionaries as bytes",
    { compressionDictionaries: [new TextEncoder().encode("a dictionary")] },
  ],
  [
    "dictionaries from a resolver",
    { compressionDictionaries: () => undefined },
  ],
  [
    "maxContentCodings: Infinity, maxContentLength: 0",
    { maxContentCodings: Number.POSITIVE_INFINITY, maxContentLength: 0 },
  ],
] as [string, ParseBodyOption | undefined][]) {
  checkEqual(
    `validateParseBodyOption(${label}) accepts it`,
    outcome(() => validateParseBodyOption(parseBody)),
    "ok",
  );
}

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const adapter of adapters) {
  await adapter.close();
}
show("done");

summary();
