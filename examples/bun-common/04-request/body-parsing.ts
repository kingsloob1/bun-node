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
 * - A kind left out of a `contentTypes` allowlist is not parsed: `req.body`
 *   is the raw `Buffer`, and the `Content-Type` header is kept.
 * - A media type no parser knows (`application/x-ndjson`, say) is kept as a
 *   `Buffer` too, but its `Content-Type` is **rewritten** to
 *   `application/octet-stream` — so a custom parser should run with
 *   `parseBody: false` and look at the header before parsing anything.
 * - Multipart bodies land in `parseBody()`'s `multipart` result, not in
 *   `req.body`.
 * - `req.buffer` always holds the exact bytes received — the "raw body" a
 *   webhook signature is computed over.
 */
import type {
  BunRequest,
  BunRequestOptions,
  DefaultRequestBody,
  JsonValue,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import {
  brotliCompressSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import {
  BunHttpAdapter,
  compressionDictionaryHash,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_CONTENT_LENGTH_BY_KIND,
  dictionaryCompressedHeader,
  parseXmlToObject,
  PayloadTooLargeError,
} from "@kingsleyweb/bun-common";
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
step("Cleaning up");

for (const adapter of adapters) {
  await adapter.close();
}
show("done");
