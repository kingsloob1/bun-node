/**
 * HTTP helpers — ETags, freshness, ranges, `Vary`, URL encoding, dates, byte
 * sizes, cookies, content negotiation and MIME types.
 *
 * ```bash
 * bun 11-utilities/http-helpers.ts
 * ```
 *
 * These are what `BunResponse` and `BunRequest` are built from, exported for
 * a handler that needs to do the same by hand — a conditional GET, a partial
 * download, a signed session cookie.
 *
 * The points worth knowing:
 *
 * - **Cookies go through Bun's `CookieMap` and `Cookie`.** So `Path=/` and
 *   `SameSite=Lax` are defaults, and the `decode`/`encode` options are kept
 *   only for signature compatibility — they are not applied.
 * - **`rangeParser` returns `-2` only when there is no `=`.** A range it
 *   cannot read is skipped, and when none is left the answer is `-1`.
 * - **`accepts` and `typeIs` are the `accepts` and `type-is` packages'
 *   functions**, retyped to take anything with `headers` — both read nothing
 *   else — so a plain header object or a `BunRequest` needs no cast.
 *   `mime` is the `mime` package's frozen default instance.
 * - The compatibility names — `cookie`, `cookieSignature`, `cookieParser`,
 *   `vary`, `eTag` — are the same functions under the old packages' names.
 */
import { Buffer } from "node:buffer";
import {
  accepts,
  appendVary,
  combineRanges,
  cookie,
  cookieParser,
  cookieSignature,
  encodeUrl,
  eTag,
  etag,
  extractSignedCookies,
  fresh,
  getMimeFromStr,
  isDateValid,
  isMime,
  jsonCookies,
  mime,
  parseByteSize,
  parseCookie,
  rangeParser,
  serializeCookie,
  signCookie,
  toHttpDate,
  typeIs,
  ucwords,
  unsignCookie,
  vary,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("HTTP helpers");

/* ------------------------------------------------------------------ */
step("etag + fresh: a conditional GET, answered with 304");

const body = JSON.stringify({ id: 1, name: "Ada" });
const tag = etag(body);
const lastModified = toHttpDate(new Date("2026-01-01T00:00:00Z"));
show("etag (byte length in hex, then a hash)", tag);
show("same bytes, same tag, whatever holds them", [
  etag(Buffer.from(body)) === tag,
  etag(new TextEncoder().encode(body)) === tag,
  eTag === etag,
]);
show("the empty body has a fixed tag", etag(""));

/** The response headers a cache compares against. */
const responseHeaders = { etag: tag, "last-modified": lastModified };
show(
  "If-None-Match matches: fresh, send 304",
  fresh({ "if-none-match": tag }, responseHeaders),
);
show(
  "a weak validator matches too",
  fresh({ "if-none-match": `W/${tag}` }, responseHeaders),
);
show("If-None-Match: * matches anything", fresh({ "if-none-match": "*" }, {}));
show(
  "a stale tag: not fresh",
  fresh({ "if-none-match": '"0-old"' }, responseHeaders),
);
show(
  "If-Modified-Since at or after Last-Modified: fresh",
  fresh(
    { "if-modified-since": "Fri, 02 Jan 2026 00:00:00 GMT" },
    responseHeaders,
  ),
);
show(
  "Cache-Control: no-cache always refetches",
  fresh(
    { "if-none-match": tag, "cache-control": "max-age=0, no-cache" },
    responseHeaders,
  ),
);
show("no conditional headers: never fresh", fresh({}, responseHeaders));

/* ------------------------------------------------------------------ */
step("rangeParser + combineRanges: partial downloads");

const size = 1_000;
for (const header of [
  "bytes=0-99",
  "bytes=-100", // the last 100 bytes
  "bytes=900-", // from 900 to the end
  "bytes=0-5000", // the end is clamped to the size
  "bytes=0-9,20-29",
  "bytes=900-100", // unsatisfiable
  "bytes=5000-", // starts past the end
  "nonsense", // no "=": malformed
]) {
  const result = rangeParser(size, header);
  show(
    header.padEnd(16),
    Array.isArray(result) ? { type: result.type, ranges: [...result] } : result,
  );
}

const overlapping = rangeParser(size, "bytes=20-29,0-4,3-9,10-12", {
  combine: true,
});
show(
  "combine: overlapping and adjacent ranges merge, request order kept",
  Array.isArray(overlapping) ? [...overlapping] : overlapping,
);
show("combineRanges directly", [
  ...combineRanges(
    Object.assign(
      [
        { start: 0, end: 5 },
        { start: 6, end: 8 },
      ],
      { type: "bytes" },
    ),
  ),
]);

/* ------------------------------------------------------------------ */
step("appendVary: building a Vary header");

let varyHeader = "";
varyHeader = appendVary(varyHeader, "Accept");
varyHeader = appendVary(varyHeader, ["Accept-Encoding", "accept"]); // case-insensitive duplicate
varyHeader = vary(varyHeader, "Origin, Accept-Language");
show("Vary", varyHeader);
show("* swallows everything", appendVary(varyHeader, "*"));
try {
  appendVary("", "not a header");
} catch (error) {
  show(
    "an invalid field name throws",
    `${(error as Error).name}: ${(error as Error).message}`,
  );
}

/* ------------------------------------------------------------------ */
step("encodeUrl, toHttpDate, isDateValid, ucwords, parseByteSize");

show("encodeUrl leaves existing escapes alone", [
  encodeUrl("/files/my report.pdf"),
  encodeUrl("/files/my%20report.pdf"),
  encodeUrl("/100%/café?q=a b#top"),
]);
show("toHttpDate", toHttpDate(new Date(0)));
show("isDateValid", [isDateValid(new Date()), isDateValid(new Date("nope"))]);
show("ucwords (header-style names)", [
  ucwords("content-type"),
  ucwords("x-request-id"),
  ucwords("hello world"),
]);
show("parseByteSize", {
  "100kb": parseByteSize("100kb"),
  "1.5 MB": parseByteSize("1.5 MB"),
  "512": parseByteSize("512"),
  "2048 (number)": parseByteSize(2_048),
  "-1": parseByteSize(-1),
  "10 kib": parseByteSize("10 kib"),
});

/* ------------------------------------------------------------------ */
step("Cookies: parse, serialize with every option, sign and verify");

show(
  "parseCookie decodes values",
  parseCookie("theme=dark; greeting=hello%20world"),
);
show("an empty header is an empty record", parseCookie(""));

show("serializeCookie, defaults only", serializeCookie("theme", "dark"));
show(
  "serializeCookie, every option",
  serializeCookie("session", "abc", {
    domain: "example.com",
    path: "/app",
    expires: new Date("2030-01-01T00:00:00Z"),
    maxAge: 3_600.9, // floored to whole seconds
    httpOnly: true,
    secure: true,
    partitioned: true,
    sameSite: "none",
    priority: "high",
  }),
);
show(
  "sameSite: true means Strict",
  serializeCookie("a", "1", { sameSite: true }),
);

const secret = "keyboard cat";
const signed = signCookie("user-42", secret);
show("signCookie", signed);
show("unsignCookie", {
  right: unsignCookie(signed, secret),
  wrongSecret: unsignCookie(signed, "other"),
  tampered: unsignCookie(signed.replace("42", "43"), secret),
});

// Express's cookie-parser prefixes: "s:" for signed, "j:" for JSON.
const jar = parseCookie(
  `sid=${encodeURIComponent(`s:${signed}`)}; forged=s%3Aadmin.bad; prefs=${encodeURIComponent('j:{"lang":"en"}')}`,
);
show("jsonCookies parses j: values", jsonCookies(jar));
const verified = extractSignedCookies(jar, ["old secret", secret]);
show("extractSignedCookies returns the verified ones", verified);
show("and removes them from the jar; forgeries stay", jar);

show("the compatibility names are the same functions", [
  cookie.parse === parseCookie,
  cookie.serialize === serializeCookie,
  cookieSignature.sign === signCookie,
  cookieSignature.unsign === unsignCookie,
  cookieParser.JSONCookies === jsonCookies,
  cookieParser.signedCookies === extractSignedCookies,
]);

/* ------------------------------------------------------------------ */
step("accepts and typeIs: content negotiation");

// Both packages read only `headers`, and bun-common types them that way
// (`RequestHeadersLike`): a plain header object — or a `BunRequest` — needs
// no cast.
const request = accepts({
  headers: {
    accept: "text/html, application/json;q=0.9, */*;q=0.1",
    "accept-encoding": "gzip, br;q=0.8",
    "accept-charset": "utf-8, iso-8859-1;q=0.2",
    "accept-language": "en;q=0.8, es, pt",
  },
});
show("types(['json', 'html'])", request.types(["json", "html"]));
show("types() — everything, best first", request.types());
show("encodings(['br', 'deflate'])", request.encodings(["br", "deflate"]));
show("charsets()", request.charsets());
show("languages(['en', 'fr'])", request.languages(["en", "fr"]));

const jsonPost = {
  headers: {
    "content-type": "application/json; charset=utf-8",
    "content-length": "2",
  },
};
show(
  "typeIs(request, ['urlencoded', 'json'])",
  typeIs(jsonPost, ["urlencoded", "json"]),
);
show(
  "no body: null",
  typeIs({ headers: { "content-type": "application/json" } }, ["json"]),
);
show(
  "typeIs.is with a wildcard returns the actual type",
  typeIs.is("text/html; charset=utf-8", ["text/*"]),
);
show(
  "typeIs.is with a +suffix",
  typeIs.is("application/vnd.api+json", ["+json"]),
);
show(
  "typeIs.normalize",
  ["json", "urlencoded", "multipart", "+json"].map((type) =>
    typeIs.normalize(type),
  ),
);
show("typeIs.match", typeIs.match("*/*+json", "application/ld+json"));
show("typeIs.hasBody", [
  typeIs.hasBody(jsonPost),
  typeIs.hasBody({ headers: { "transfer-encoding": "chunked" } }),
  typeIs.hasBody({ headers: {} }),
]);

/* ------------------------------------------------------------------ */
step("mime, getMimeFromStr, isMime");

show("mime.getType", [
  mime.getType("report.PDF"),
  mime.getType("json"),
  mime.getType("dir/no-extension"),
]);
show(
  "mime.getExtension ignores parameters",
  mime.getExtension("text/html; charset=utf-8"),
);
show("mime.getAllExtensions", [...(mime.getAllExtensions("image/jpeg") ?? [])]);
try {
  mime.define({ "application/x-mine": ["mine"] });
} catch (error) {
  show(
    "the default instance is frozen",
    (error as Error).message.split(".")[0],
  );
}

show("isMime: a type with a known extension", [
  isMime("application/json"),
  isMime("json"),
  isMime("application/x-unheard-of"),
]);
show("getMimeFromStr: a type passes through, anything else is looked up", [
  getMimeFromStr("image/png"),
  getMimeFromStr("png"),
  getMimeFromStr("archive.tar.gz"),
  getMimeFromStr("nothing-known"),
]);
