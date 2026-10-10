/**
 * Option tour: every `BunResponse` option, and every public `BunResponse`
 * property, method and event, each asserted — `SendFileOptions` and
 * `res.cookie()` options included.
 *
 * ```bash
 * bun 12-options/response-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Responses here are built directly — `new BunResponse(req, { etag })` —
 *   and read back with `getNativeResponse()`, the way the adapter does.
 * - The constructor's other option, `views`, is the `BunViews` that
 *   `render()` renders through. Without it a response renders through a
 *   default one, with no engine registered and no default engine. Both
 *   adapters, `router.fetch()` and a `BunWebSocket` dedicated server pass
 *   their application's one (`adapter.views` / `router.views`).
 *   `05-response/views.ts` covers views in full.
 * - `redirect()` is Express 5's (a body chosen by `Accept`, `Vary`,
 *   `Content-Length`, an encoded `Location`), and `clearCookie()` always
 *   expires the cookie at the epoch, dropping a `maxAge` or `expires`.
 * - The files `sendFile()` serves are written to a temporary directory and
 *   removed at the end. `sendFile(path)` resolves `path` under `root`.
 * - `res.cookie()`'s `maxAge` is milliseconds; the header gets seconds.
 * - A text body is `text/plain;charset=utf-8` and JSON is
 *   `application/json;charset=utf-8`. With no header set, `send(text)` and
 *   `json(value)` build the Response without a Headers object — text then has
 *   no `Content-Type` on the Response itself, which Bun writes on the wire
 *   and `fetch()` adds (see [docs/bun-bugs](../../../docs/bun-bugs/README.md)).
 * - Checks marked `Known issue` assert what the library documents where it
 *   currently does something else; they fail until the library is fixed.
 */
import type {
  BunServer,
  EtagOption,
  RenderCallback,
} from "@kingsleyweb/bun-common";
import type { Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  BunHttpAdapter,
  BunRequest,
  BunResponse,
  BunViews,
  compression,
  etag,
  FETCH_STUB_SERVER,
  signCookie,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title, waitFor } from "../shared/console";

title("Option tour: BunResponse options, properties, methods and events");

/** Builds a request for `url` with the given headers. */
async function makeReq(
  url = "http://localhost/",
  headers: Record<string, string> = {},
  server: BunServer = FETCH_STUB_SERVER,
): Promise<BunRequest> {
  return await BunRequest.init(new Request(url, { headers }), server, {
    parseBody: false,
  });
}

/** A fresh response on a fresh request. */
async function makeRes(
  headers: Record<string, string> = {},
  etagOption?: EtagOption,
): Promise<BunResponse> {
  return new BunResponse(
    await makeReq("http://localhost/", headers),
    etagOption === undefined ? undefined : { etag: etagOption },
  );
}

/** The native response, within a second. */
async function native(res: BunResponse): Promise<Response> {
  return await res.getNativeResponse(1000);
}

/* ------------------------------------------------------------------ */
step("Status: status(), statusCode, statusText(), option()");

const statusRes = await makeRes();
checkEqual("statusCode defaults to 200", statusRes.statusCode, 200);
check("status() returns the response", statusRes.status(201) === statusRes);
checkEqual("…and sets statusCode", statusRes.statusCode, 201);
statusRes.statusCode = 202;
statusRes.statusText("Accepted");
statusRes.option({ headers: undefined });
checkEqual(
  "statusCode setter and statusText()",
  [
    statusRes.nativeResponseOptions?.status,
    statusRes.nativeResponseOptions?.statusText,
  ],
  [202, "Accepted"],
);
statusRes.option({ status: 203, statusText: "Non-Authoritative" });
const statusNative = await native(statusRes.send("x"));
checkEqual(
  "option() merges a ResponseInit",
  [statusNative.status, statusNative.statusText],
  [203, "Non-Authoritative"],
);

/* ------------------------------------------------------------------ */
step("Headers");

const headerRes = await makeRes();
headerRes.set("X-A", "1");
headerRes.header("X-B", "2");
headerRes.setHeader("X-List", ["a", "b"]);
headerRes.set("X-List", "c", false);
headerRes.setHeader("X-List", "d", false);
headerRes.append("X-List", "e");
headerRes.appendHeader("X-List", ["f"]);
checkEqual(
  "set / header / setHeader(array) / replace=false / append / appendHeader",
  [headerRes.get("X-A"), headerRes.get("X-B"), headerRes.getHeader("X-List")],
  ["1", "2", "a, b, c, d, e, f"],
);
headerRes.set("X-List", "reset");
checkEqual("set() replaces by default", headerRes.get("X-List"), "reset");
checkEqual(
  "get() with a default",
  [headerRes.get("X-None", "fallback"), headerRes.get("X-None")],
  ["fallback", undefined],
);
headerRes.setHeaders({ "X-Record": "r", "X-Record-List": ["1", "2"] });
headerRes.setHeaders(["X-Line: l", "not a header line"]);
headerRes.setHeaders(new Map([["X-Map", "m"]]));
headerRes.setHeaders(new Headers({ "X-Headers": "h" }));
checkEqual(
  "setHeaders(record | lines | Map | Headers)",
  [
    headerRes.get("X-Record"),
    headerRes.get("X-Record-List"),
    headerRes.get("X-Line"),
    headerRes.get("X-Map"),
    headerRes.get("X-Headers"),
  ],
  ["r", "1, 2", "l", "m", "h"],
);
checkEqual(
  "hasHeader",
  [headerRes.hasHeader("x-a"), headerRes.hasHeader("x-nope")],
  [true, false],
);
check(
  "removeHeader() returns the response",
  headerRes.removeHeader("X-A") === headerRes,
);
checkEqual("…and removes it", headerRes.hasHeader("X-A"), false);
checkEqual("getHeaderNames()", headerRes.getHeaderNames(), [
  "x-b",
  "x-headers",
  "x-line",
  "x-list",
  "x-map",
  "x-record",
  "x-record-list",
]);
checkEqual("getHeaders()", headerRes.getHeaders()["x-record-list"], "1, 2");

// `Set-Cookie`, as Node's `OutgoingMessage`: the array of its lines, so a
// line whose `Expires` holds a comma is never split.
const cookieLinesSet = [
  "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  "b=2",
  "c=3",
];
headerRes.setHeader("Set-Cookie", cookieLinesSet.slice(0, 2));
headerRes.appendHeader("set-cookie", "c=3");
checkEqual(
  "getHeader('Set-Cookie') after setHeader([...]) and appendHeader: every line",
  headerRes.getHeader("Set-Cookie"),
  cookieLinesSet,
);
checkEqual(
  "…getHeaders()['set-cookie'] is the same array",
  headerRes.getHeaders()["set-cookie"],
  cookieLinesSet,
);
checkEqual(
  "…getHeaderNames() lists set-cookie once",
  headerRes.getHeaderNames().filter((name) => name === "set-cookie"),
  ["set-cookie"],
);
check(
  "getHeaders() has no prototype, as Node's",
  Object.getPrototypeOf(headerRes.getHeaders()) === null,
);
headerRes.setHeader("Set-Cookie", "only=1");
checkEqual(
  "setHeader('Set-Cookie', string) replaces every line",
  headerRes.getHeader("set-cookie"),
  ["only=1"],
);
headerRes.removeHeader("Set-Cookie");
checkEqual(
  "…removeHeader: getHeader answers undefined, hasHeader false",
  [headerRes.getHeader("Set-Cookie"), headerRes.hasHeader("set-cookie")],
  [undefined, false],
);
check(
  "type() / contentType() set Content-Type as given",
  headerRes.type("application/xml").get("Content-Type") === "application/xml" &&
    headerRes.contentType("text/csv").get("Content-Type") === "text/csv",
);

const writeHeadRes = await makeRes();
writeHeadRes.writeHead(201, "Created", { "X-One": "1" });
checkEqual(
  "writeHead(code, message, headers)",
  [
    writeHeadRes.statusCode,
    writeHeadRes.nativeResponseOptions?.statusText,
    writeHeadRes.get("X-One"),
  ],
  [201, "Created", "1"],
);
writeHeadRes.writeHead(202, ["X-Two: 2"]);
writeHeadRes.writeHead("Accepted", { "X-Three": "3" });
writeHeadRes.writeHead({ "X-Four": ["4a", "4b"] });
checkEqual(
  "writeHead(code, headers) / (message, headers) / (headers)",
  [
    writeHeadRes.statusCode,
    writeHeadRes.nativeResponseOptions?.statusText,
    writeHeadRes.get("X-Two"),
    writeHeadRes.get("X-Three"),
    writeHeadRes.get("X-Four"),
  ],
  [202, "Accepted", "2", "3", "4a, 4b"],
);
const bareWriteHead = await makeRes();
bareWriteHead.writeHead(404);
checkEqual(
  "writeHead(code) alone sets the status, as Node",
  bareWriteHead.statusCode,
  404,
);
bareWriteHead.writeHead(410, "Gone");
checkEqual(
  "writeHead(code, message)",
  [bareWriteHead.statusCode, bareWriteHead.nativeResponseOptions?.statusText],
  [410, "Gone"],
);

const cookieLines = await makeRes();
checkEqual(
  "get('set-cookie') with no cookie set",
  cookieLines.get("set-cookie"),
  undefined,
);
cookieLines.cookie("a", "1", { expires: new Date(0) });
cookieLines.cookie("b", "2");
checkEqual(
  "get('Set-Cookie') answers each line in an array, as Node's getHeader",
  cookieLines.get("Set-Cookie")?.map((line) => line.split(";")[0]),
  ["a=1", "b=2"],
);

const navRes = await makeRes({ Referrer: "/cart" });
navRes.location("/a path?q=ü");
checkEqual("location() encodes", navRes.get("Location"), "/a%20path?q=%C3%BC");
navRes.location("back");
checkEqual("location('back') uses Referrer", navRes.get("Location"), "/cart");
checkEqual(
  "…or / without one",
  (await makeRes()).location("back").get("Location"),
  "/",
);
navRes.links({ next: "/p/2" }).links({ last: "/p/9" });
checkEqual(
  "links() accumulates",
  navRes.get("Link"),
  '</p/2>; rel="next", </p/9>; rel="last"',
);
navRes.vary("Accept").vary(["accept", "Origin"]);
checkEqual(
  "vary() appends each field once",
  navRes.get("Vary"),
  "Accept, Origin",
);
navRes.vary("*");
checkEqual("vary('*')", navRes.get("Vary"), "*");

/* ------------------------------------------------------------------ */
step("send(): body types and their Content-Type");

/**
 * Sends `body` on a new response and answers its type and text. With no
 * header set, a text body is built without a Headers object (see the next
 * step), so the type then comes from `getHeader()`, as a served client gets it.
 */
async function sent(
  body: Parameters<BunResponse["send"]>[0],
  setup?: (res: BunResponse) => void,
): Promise<[string | null, string]> {
  const res = await makeRes();
  setup?.(res);
  const response = await native(res.send(body));
  // A body type of its own (Blob, FormData, …) is on the Response itself.
  const type =
    response.headers.get("Content-Type") ?? res.getHeader("Content-Type");
  return [typeof type === "string" ? type : null, await response.text()];
}

checkEqual("string: text/plain;charset=utf-8", await sent("hi"), [
  "text/plain;charset=utf-8",
  "hi",
]);
checkEqual(
  "string with a Content-Type already set keeps it",
  await sent("<b/>", (res) => res.type("text/html")),
  ["text/html", "<b/>"],
);
checkEqual("object: JSON", await sent({ a: 1 }), [
  "application/json;charset=utf-8",
  '{"a":1}',
]);
checkEqual("array: JSON", await sent([1, 2]), [
  "application/json;charset=utf-8",
  "[1,2]",
]);
// A number is sent as its string (Express 5 would send it as JSON).
checkEqual("number: its string", await sent(42), [
  "text/plain;charset=utf-8",
  "42",
]);
checkEqual(
  "the same types with another header set first",
  [
    (await sent("hi", (res) => res.set("X-A", "1")))[0],
    (await sent({ a: 1 }, (res) => res.set("X-A", "1")))[0],
  ],
  ["text/plain;charset=utf-8", "application/json;charset=utf-8"],
);
checkEqual(
  "null and undefined: empty",
  [(await sent(null))[1], (await sent(undefined))[1]],
  ["", ""],
);
checkEqual("Buffer: octet-stream", await sent(Buffer.from("buf")), [
  "application/octet-stream",
  "buf",
]);
checkEqual(
  "typed array: only its window",
  (await sent(new Uint8Array([0, 104, 105, 0]).subarray(1, 3)))[1],
  "hi",
);
checkEqual(
  "DataView",
  (await sent(new DataView(new TextEncoder().encode("dv").buffer)))[1],
  "dv",
);
checkEqual(
  "ArrayBuffer / SharedArrayBuffer",
  [
    (await sent(new TextEncoder().encode("ab").buffer))[1],
    (await sent(new SharedArrayBuffer(2)))[1].length,
  ],
  ["ab", 2],
);
checkEqual(
  "Blob: its own type",
  await sent(new Blob(["b"], { type: "image/svg+xml" })),
  ["image/svg+xml", "b"],
);
const formSent = await sent(
  (() => {
    const form = new FormData();
    form.append("k", "v");
    return form;
  })(),
);
check(
  "FormData: multipart with a boundary",
  formSent[0]?.startsWith("multipart/form-data; boundary=") === true,
  formSent[0],
);
checkEqual("URLSearchParams", await sent(new URLSearchParams({ q: "bun" })), [
  "application/x-www-form-urlencoded;charset=UTF-8",
  "q=bun",
]);
checkEqual(
  "ReadableStream",
  (
    await sent(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("web"));
          controller.close();
        },
      }),
    )
  )[1],
  "web",
);
checkEqual(
  "Node Readable",
  (await sent(Readable.from(["no", "de"])))[1],
  "node",
);
checkEqual(
  "async iterable",
  (
    await sent(
      (async function* gen() {
        yield "it";
        yield "er";
      })(),
    )
  )[1],
  "iter",
);
checkEqual(
  "async generator function",
  (
    await sent(async function* gen() {
      yield "fn";
    })
  )[1],
  "fn",
);
const passthrough = await makeRes();
const nativeGiven = new Response("native", { status: 299 });
check(
  "Response: passed through as-is",
  (await native(passthrough.send(nativeGiven))) === nativeGiven,
);
const outer = await makeRes();
const inner = new BunResponse(outer.req).status(203);
inner.json({ inner: true });
checkEqual(
  "BunResponse: its produced response",
  (await native(outer.send(inner))).status,
  203,
);

const twice = await makeRes();
checkEqual(
  "headersSent before and after",
  [twice.headersSent, twice.send("first").headersSent],
  [false, true],
);
twice.send("second");
checkEqual(
  "a second send() is ignored",
  await (await native(twice)).text(),
  "first",
);

const noContent = await makeRes();
noContent
  .status(204)
  .set("Content-Type", "text/plain")
  .set("Content-Length", "7");
const noContentNative = await native(noContent.send("ignored"));
checkEqual("204: empty body", await noContentNative.text(), "");
checkEqual(
  "204: Content-Type stripped",
  noContentNative.headers.get("Content-Type"),
  null,
);
const resetContent = await makeRes();
checkEqual(
  "205: empty body",
  await (await native(resetContent.status(205).send("ignored"))).text(),
  "",
);

const jsonRes = await makeRes();
jsonRes.json({ ok: true });
const jsonNative = await native(jsonRes);
checkEqual(
  "json()",
  [
    jsonNative.headers.get("Content-Type"),
    await jsonNative.json(),
    jsonRes.getBody(),
  ],
  ["application/json;charset=utf-8", { ok: true }, { ok: true }],
);

const statusOnly = await makeRes();
statusOnly.status(404).sendStatus(404);
const statusOnlyNative = await native(statusOnly);
checkEqual(
  "sendStatus(): the status, with its reason phrase as the body",
  [
    statusOnlyNative.status,
    await statusOnlyNative.text(),
    statusOnly.getBody(),
  ],
  [404, "Not Found", "Not Found"],
);
const movedStatus = await native((await makeRes()).sendStatus(301)!);
checkEqual("sendStatus(301) sets the status itself", movedStatus.status, 301);
checkEqual(
  "sendStatus() once sent answers undefined",
  statusOnly.sendStatus(500),
  undefined,
);

const ended = await makeRes();
await ended.end("the end");
checkEqual("end(body) sends it", await (await native(ended)).text(), "the end");

const objectEnd = await makeRes();
await checkRejects(
  "end(object) throws, as Node's end(chunk): text or bytes only",
  // `Reflect.apply`: plain JS can pass what the types rule out.
  () => Reflect.apply(objectEnd.end, objectEnd, [{ a: 1 }]),
  { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" },
);
check("…and sends nothing", !objectEnd.headersSent);

const sentArray = await makeRes();
const sentBody = [1, 2];
// `unknown`, as the `error` event types it: a stream may fail with anything.
const lateErrors: unknown[] = [];
sentArray.on("error", (error) => {
  lateErrors.push(error);
});
sentArray.send(sentBody);
checkEqual(
  "write() after send() answers false",
  sentArray.write("late"),
  false,
);
await new Promise((resolve) => setTimeout(resolve, 0));
checkEqual(
  "…emits ERR_STREAM_WRITE_AFTER_END on the next tick",
  lateErrors.map((error) =>
    error instanceof Error && "code" in error ? error.code : error,
  ),
  ["ERR_STREAM_WRITE_AFTER_END"],
);
checkEqual(
  "…and never touches the array that was sent",
  [sentBody, sentArray.getBody() === sentBody],
  [[1, 2], true],
);

/* ------------------------------------------------------------------ */
step("Text and JSON sent with no header: no Headers object, same type");

const bareText = await makeRes();
bareText.getHeader("X-Anything"); // reading a header first changes nothing
bareText.send("plain");
const bareTextNative = await native(bareText);
checkEqual(
  "send(text): the Response itself has no Content-Type",
  bareTextNative.headers.has("Content-Type"),
  false,
);
checkEqual(
  "…but getHeader() reports it after the send",
  bareText.getHeader("Content-Type"),
  "text/plain;charset=utf-8",
);
const bareJson = await makeRes();
bareJson.json({ a: 1 });
checkEqual(
  "json(value): the Response carries the JSON type",
  (await native(bareJson)).headers.get("Content-Type"),
  "application/json;charset=utf-8",
);
const plainJsonp = await makeRes();
plainJsonp.jsonp({ a: 1 });
checkEqual(
  "jsonp() without a callback: the JSON type",
  (await native(plainJsonp)).headers.get("Content-Type"),
  "application/json;charset=utf-8",
);
const withHeader = await makeRes();
withHeader.set("X-A", "1").send("plain");
checkEqual(
  "a header set first: the full path, the same type on the Response",
  (await native(withHeader)).headers.get("Content-Type"),
  "text/plain;charset=utf-8",
);
const withEtag = await makeRes();
withEtag.setEtag().send("plain");
const withEtagNative = await native(withEtag);
checkEqual(
  "setEtag(): the full path too",
  [
    withEtagNative.headers.get("Content-Type"),
    withEtagNative.headers.has("ETag"),
  ],
  ["text/plain;charset=utf-8", true],
);

// What a client gets: the same type whichever path built the Response.
const typed = new BunHttpAdapter(0);
typed.get("/text", (_req, res) => res.send("plain"));
typed.get("/json", (_req, res) => res.json({ a: 1 }));
typed.get("/header", (_req, res) => res.set("X-A", "1").send("plain"));
typed.get("/compressed", compression({ threshold: 0 }), (_req, res) => {
  res.send("plain ".repeat(50));
});
await typed.listen(0);
for (const [path, type] of [
  ["/text", "text/plain;charset=utf-8"],
  ["/json", "application/json;charset=utf-8"],
  ["/header", "text/plain;charset=utf-8"],
  ["/compressed", "text/plain;charset=utf-8"],
] as const) {
  const served = await fetch(`${typed.url}${path}`);
  const servedHead = await fetch(`${typed.url}${path}`, { method: "HEAD" });
  const fetched = await typed.fetch(path);
  checkEqual(
    `${path}: served, served HEAD and adapter.fetch() all carry it`,
    [
      served.headers.get("Content-Type"),
      servedHead.headers.get("Content-Type"),
      fetched.headers.get("Content-Type"),
    ],
    [type, type, type],
  );
}
await typed.close();

/* ------------------------------------------------------------------ */
step("Untouched stream state reads as its defaults");

const untouched = await makeRes();
checkEqual(
  "isStreamOpen, writableEnded, headersSent, destroyed: all false",
  [
    untouched.isStreamOpen,
    untouched.writableEnded,
    untouched.headersSent,
    untouched.destroyed,
  ],
  [false, false, false, false],
);
let endedAtOnce = false;
untouched.onceStreamEnded(() => {
  endedAtOnce = true;
});
check("onceStreamEnded() with no stream: called at once", endedAtOnce);

/* ------------------------------------------------------------------ */
step("getNativeResponse(), settledResponse, getBody()");

const pending = await makeRes();
checkEqual(
  "before a body: settledResponse and getBody are undefined",
  [pending.settledResponse, pending.getBody()],
  [undefined, undefined],
);
await checkRejects(
  "getNativeResponse(timeout) rejects when nothing arrives",
  () => pending.getNativeResponse(20),
  { message: /Timedout/ },
);
const waiting = pending.getNativeResponse(1000);
queueMicrotask(() => {
  pending.send("later");
});
checkEqual(
  "…and resolves once one is produced",
  await (await waiting).text(),
  "later",
);
check(
  "settledResponse is that Response",
  pending.settledResponse instanceof Response,
);

/* ------------------------------------------------------------------ */
step("etag option, setEtag(), and 304s");

checkEqual(
  "no ETag by default",
  (await native((await makeRes()).send("body"))).headers.get("ETag"),
  null,
);
checkEqual(
  "{ etag: true }: string",
  (await native((await makeRes({}, true)).send("body"))).headers.get("ETag"),
  etag("body"),
);
checkEqual(
  "setEtag(): JSON is tagged over its serialisation",
  (await native((await makeRes()).setEtag().send({ a: 1 }))).headers.get(
    "ETag",
  ),
  etag('{"a":1}'),
);
checkEqual(
  "…binary over its bytes",
  (
    await native((await makeRes()).setEtag(true).send(Buffer.from("bin")))
  ).headers.get("ETag"),
  etag(Buffer.from("bin")),
);
checkEqual(
  "…streams are never tagged",
  (
    await native((await makeRes()).setEtag().send(Readable.from(["s"])))
  ).headers.get("ETag"),
  null,
);
checkEqual(
  "setEtag(false) turns it off",
  (
    await native((await makeRes({}, true)).setEtag(false).send("body"))
  ).headers.get("ETag"),
  null,
);
checkEqual(
  "an ETag already set is kept",
  (
    await native((await makeRes({}, true)).set("ETag", '"mine"').send("body"))
  ).headers.get("ETag"),
  '"mine"',
);

const weakRes = await makeRes({}, "weak");
checkEqual('{ etag: "weak" }: res.etag reports it', weakRes.etag, "weak");
checkEqual(
  "…and the tag is weak",
  (await native(weakRes.send("body"))).headers.get("ETag"),
  `W/${etag("body")}`,
);
const strongRes = await makeRes({}, "weak");
strongRes.etag = "strong";
checkEqual(
  "the res.etag setter overrules the option: strong",
  (await native(strongRes.send("body"))).headers.get("ETag"),
  etag("body"),
);
const customRes = await makeRes();
checkEqual("res.etag defaults to false", customRes.etag, false);
customRes.setEtag((body) => `"custom-${body.length}"`);
checkEqual(
  "setEtag(fn): the function's tag",
  (await native(customRes.send("body"))).headers.get("ETag"),
  '"custom-4"',
);
const noneRes = await makeRes({}, true);
noneRes.setEtag(() => undefined);
checkEqual(
  "…a function answering undefined: no tag",
  (await native(noneRes.send("body"))).headers.get("ETag"),
  null,
);
const bareSetEtag = await makeRes();
bareSetEtag.setEtag();
checkEqual("setEtag() with no argument is true", bareSetEtag.etag, true);
const weakMatch = await makeRes({ "If-None-Match": `W/${etag("body")}` }, true);
checkEqual(
  "a strong tag matches a weak If-None-Match: 304",
  (await native(weakMatch.send("body"))).status,
  304,
);
await checkRejects(
  "res.etag = 'medium' throws",
  async () => {
    (await makeRes()).etag = "medium" as unknown as EtagOption;
  },
  { name: "TypeError" },
);
await checkRejects(
  "new BunResponse(req, { etag: 0 }) throws",
  async () => makeRes({}, 0 as unknown as EtagOption),
  { name: "TypeError" },
);

const fresh = await makeRes({ "If-None-Match": '"v1"' });
const freshNative = await native(fresh.set("ETag", '"v1"').send("full body"));
checkEqual(
  "a matching ETag set before send(): 304, empty",
  [freshNative.status, await freshNative.text()],
  [304, ""],
);
const modified = await makeRes({
  "If-Modified-Since": new Date(Date.UTC(2031, 5, 1)).toUTCString(),
});
checkEqual(
  "Last-Modified not after If-Modified-Since: 304",
  (
    await native(
      modified
        .set("Last-Modified", new Date(Date.UTC(2031, 0, 1)).toUTCString())
        .send("x"),
    )
  ).status,
  304,
);

/* ------------------------------------------------------------------ */
step("format()");

/** Runs format() for an Accept header; answers type, body, Vary, sent. */
async function formatted(
  accept: string,
  withDefault: boolean,
): Promise<[string | null, string | null, string | null, boolean]> {
  const res = await makeRes({ Accept: accept });
  res.format({
    "text/html": (_req, r) => {
      r.send("<p>html</p>");
    },
    json: (_req, r) => {
      r.json({ as: "json" });
    },
    ...(withDefault
      ? {
          default: (_req: BunRequest, r: BunResponse) => {
            r.status(406).send("none");
          },
        }
      : {}),
  });
  if (!res.headersSent) {
    return [null, null, res.getHeader("Vary"), false];
  }
  const response = await native(res);
  return [
    response.headers.get("Content-Type"),
    await response.text(),
    res.getHeader("Vary"),
    true,
  ];
}

checkEqual("a full media type key", await formatted("text/html", true), [
  "text/html",
  "<p>html</p>",
  "Accept",
  true,
]);
checkEqual("an extension key", await formatted("application/json", true), [
  "application/json;charset=utf-8",
  '{"as":"json"}',
  "Accept",
  true,
]);
checkEqual(
  "default when nothing matches",
  (await formatted("image/png", true))[1],
  "none",
);
checkEqual(
  "no match and no default: 406 (Express's next(406) without a pipeline)",
  [
    (await formatted("image/png", false))[3],
    (
      await native(
        (await makeRes({ Accept: "image/png" })).format({
          json: (_req, r) => r.json({}),
        }),
      )
    ).status,
  ],
  [true, 406],
);

/* ------------------------------------------------------------------ */
step("redirect()");

const redirected = await native(
  (await makeRes()).redirect("http://localhost/next"),
);
checkEqual(
  "defaults to 302",
  [redirected.status, redirected.headers.get("Location")],
  [302, "http://localhost/next"],
);
checkEqual(
  "a status after the URL (the older form)",
  (await native((await makeRes()).redirect("http://localhost/next", 301)))
    .status,
  301,
);
const statusFirst = await native(
  (await makeRes()).redirect(308, "http://localhost/next"),
);
checkEqual(
  "a status before the URL, as Express 5's redirect(status, url)",
  [statusFirst.status, statusFirst.headers.get("Location")],
  [308, "http://localhost/next"],
);
checkEqual(
  "a ResponseInit",
  (
    await native(
      (await makeRes()).redirect("http://localhost/next", { status: 308 }),
    )
  ).status,
  308,
);

/** The redirect of `url` for an `Accept`, read back as plain values. */
async function redirectFor(
  accept: string,
  url = "/next step",
  etagOption?: EtagOption,
): Promise<(string | number | null)[]> {
  const res = await makeRes({ Accept: accept }, etagOption);
  res.set("X-Earlier", "kept");
  const response = await native(res.redirect(url));
  return [
    response.status,
    response.headers.get("Location"),
    response.headers.get("Content-Type"),
    response.headers.get("Content-Length"),
    response.headers.get("Vary"),
    response.headers.get("X-Earlier"),
    await response.text(),
  ];
}

checkEqual(
  "Accept: text/plain — Express's text body, Vary and Content-Length",
  await redirectFor("text/plain"),
  [
    302,
    "/next%20step",
    "text/plain; charset=utf-8",
    String("Found. Redirecting to /next%20step".length),
    "Accept",
    "kept",
    "Found. Redirecting to /next%20step",
  ],
);
checkEqual(
  "Accept: text/html — the same in a <p>, the URL HTML-escaped",
  (await redirectFor("text/html", "/a?x=1&y=<2>")).slice(1),
  [
    "/a?x=1&y=%3C2%3E",
    "text/html; charset=utf-8",
    String("<p>Found. Redirecting to /a?x=1&amp;y=%3C2%3E</p>".length),
    "Accept",
    "kept",
    "<p>Found. Redirecting to /a?x=1&amp;y=%3C2%3E</p>",
  ],
);
checkEqual(
  "Accept: application/json — no body, Content-Length 0",
  (await redirectFor("application/json")).slice(2),
  [null, "0", "Accept", "kept", ""],
);
checkEqual(
  "raw characters are encoded, an existing escape is not encoded twice",
  (await redirectFor("text/plain", "/café?q=a%20b"))[1],
  "/caf%C3%A9?q=a%20b",
);
const taggedRedirect = await native(
  (await makeRes({}, true)).redirect("/next"),
);
checkEqual(
  "a body, but no ETag, even with etag: true",
  [taggedRedirect.headers.get("ETag"), await taggedRedirect.text()],
  [null, "Found. Redirecting to /next"],
);
const headRedirect = new BunResponse(
  await BunRequest.init(
    new Request("http://localhost/", { method: "HEAD" }),
    FETCH_STUB_SERVER,
    { parseBody: false },
  ),
);
const headNative = await native(headRedirect.redirect("/next"));
checkEqual(
  "HEAD: the GET's Content-Length, no body",
  [headNative.headers.get("Content-Length"), await headNative.text()],
  [String("Found. Redirecting to /next".length), ""],
);

/* ------------------------------------------------------------------ */
step("render() and the views option");

const viewDir = await mkdtemp(join(tmpdir(), "bun-common-response-views-"));
await Bun.write(join(viewDir, "card.tpl"), "<b>{{title}}</b> by {{by}}");

/** A one-line engine: `{{key}}` is replaced by the local `key`. */
function tplEngine(
  path: string,
  options: Record<string, unknown>,
  callback: RenderCallback,
): void {
  const fill = (_match: string, key: string): string =>
    String(options[key] ?? "");
  Bun.file(path)
    .text()
    .then((text) => callback(null, text.replace(/\{\{(\w+)\}\}/g, fill)))
    .catch((error: Error) => callback(error));
}

const views = new BunViews();
views.root = viewDir;
views.engine("tpl", tplEngine);
views.locals.by = "app.locals";

/** A response for a GET, rendering through `views`. */
async function viewRes(): Promise<BunResponse> {
  return new BunResponse(await makeReq(), { views });
}

const cardRes = await viewRes();
cardRes.locals.by = "res.locals";
cardRes.render("card.tpl", { title: "Hi" });
const card = await native(cardRes);
checkEqual(
  "views: render() renders through the views given — engine, root, locals",
  [card.status, card.headers.get("Content-Type"), await card.text()],
  [200, "text/html; charset=utf-8", "<b>Hi</b> by res.locals"],
);
const typedRes = await viewRes();
typedRes.type("text/plain").render("card.tpl", { title: "T" });
checkEqual(
  "a Content-Type set before render() is kept",
  (await native(typedRes)).headers.get("Content-Type"),
  "text/plain",
);
const quietRes = await viewRes();
const viaCallback = await new Promise<[string | null, string | undefined]>(
  (resolve) => {
    quietRes.render("card.tpl", { title: "Cb" }, (err, html) => {
      resolve([err?.message ?? null, html]);
    });
  },
);
checkEqual(
  "render(view, locals, callback): the HTML goes to the callback, nothing is sent",
  [...viaCallback, quietRes.headersSent],
  [null, "<b>Cb</b> by app.locals", false],
);
const lostRes = await viewRes();
lostRes.render("absent.tpl");
const lost = await native(lostRes);
checkEqual(
  "a missing view with no callback and no pipeline: 500",
  [lost.status, await lost.text()],
  [500, ""],
);
await checkRejects(
  "without views: a default BunViews, which has no default engine",
  async () => (await makeRes()).render("card"),
  {
    message:
      /^No default engine was specified and no extension was provided\.$/,
  },
);
await rm(viewDir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("cookie() and clearCookie(): every option");

/** Calls `res.cookie(...)` and answers the Set-Cookie line. */
async function cookieLine(
  ...args: Parameters<BunResponse["cookie"]>
): Promise<string> {
  const res = await makeRes();
  res.cookie(...args);
  return res.getHeader("Set-Cookie")?.[0] ?? "";
}

checkEqual(
  "defaults: Path=/ and Bun's SameSite=Lax",
  await cookieLine("a", "1"),
  "a=1; Path=/; SameSite=Lax",
);
const everyOption = await cookieLine("full", "on", {
  domain: "example.com",
  path: "/account",
  httpOnly: true,
  secure: true,
  partitioned: true,
  priority: "medium",
  sameSite: "strict",
});
for (const part of [
  "Domain=example.com",
  "Path=/account",
  "HttpOnly",
  "Secure",
  "Partitioned",
  "SameSite=Strict",
  "Priority=Medium",
]) {
  check(`option → ${part}`, everyOption.includes(part), everyOption);
}
checkEqual(
  "expires",
  await cookieLine("e", "1", { expires: new Date(Date.UTC(2031, 0, 28)) }),
  "e=1; Path=/; Expires=Tue, 28 Jan 2031 00:00:00 GMT; SameSite=Lax",
);
const before = Date.now();
const maxAgeLine = await cookieLine("m", "1", { maxAge: 90_000 });
const expiresAt = Date.parse(/Expires=([^;]+)/.exec(maxAgeLine)?.[1] ?? "");
check(
  "maxAge in ms → Max-Age in seconds, with a matching Expires",
  maxAgeLine.includes("Max-Age=90") &&
    expiresAt >= Math.floor(before / 1000) * 1000 + 89_000 &&
    expiresAt <= Date.now() + 91_000,
  maxAgeLine,
);
check(
  "maxAge as a numeric string",
  (await cookieLine("m", "1", { maxAge: "60000" })).includes("Max-Age=60"),
);
check(
  "sameSite: true is strict, 'none' and 'lax' as given",
  (await cookieLine("s", "1", { sameSite: true })).includes(
    "SameSite=Strict",
  ) &&
    (await cookieLine("s", "1", { sameSite: "none", secure: true })).includes(
      "SameSite=None",
    ) &&
    (await cookieLine("s", "1", { sameSite: "lax" })).includes("SameSite=Lax"),
);
checkEqual(
  "an object value is a j: JSON cookie",
  (await cookieLine("j", { a: 1 })).split(";")[0],
  `j=${encodeURIComponent('j:{"a":1}')}`,
);
checkEqual(
  "signed with opts.secret",
  (await cookieLine("s", "v", { signed: true, secret: "k1" })).split(";")[0],
  `s=${encodeURIComponent(`s:${signCookie("v", "k1")}`)}`,
);
const reqSecretRes = await makeRes();
reqSecretRes.req.secret = ["newest", "older"];
reqSecretRes.cookie("s", "v", { signed: true });
checkEqual(
  "signed with req.secret (an array signs with the first)",
  reqSecretRes.getHeader("Set-Cookie")?.[0]?.split(";")[0],
  `s=${encodeURIComponent(`s:${signCookie("v", "newest")}`)}`,
);
await checkRejects(
  "signed with no secret anywhere",
  () => cookieLine("s", "v", { signed: true }),
  { message: /Secret is required/ },
);
const cleared = await makeRes();
cleared.clearCookie("gone", { path: "/account", domain: "example.com" });
checkEqual("clearCookie()", cleared.getHeader("Set-Cookie"), [
  "gone=; Domain=example.com; Path=/account; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax",
]);
const clearedMaxAge = await makeRes();
clearedMaxAge.clearCookie("gone", {
  maxAge: 60_000,
  expires: new Date(Date.UTC(2031, 0, 28)),
});
checkEqual(
  "clearCookie() drops maxAge and expires, as Express 5: Expires is the epoch",
  clearedMaxAge.getHeader("Set-Cookie"),
  ["gone=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax"],
);
const both = await makeRes();
both.cookie("a", "1").cookie("b", "2");
checkEqual(
  "each cookie is its own Set-Cookie",
  (await native(both.send(""))).headers.getSetCookie().length,
  2,
);

/* ------------------------------------------------------------------ */
step("sendFile(), download(), attachment(): every SendFileOptions field");

const dir = await mkdtemp(join(tmpdir(), "bun-common-response-options-"));
await Bun.write(join(dir, "report.csv"), "a,b\n1,2\n");
const fileMtime = new Date(
  Bun.file(join(dir, "report.csv")).lastModified,
).toUTCString();

const served = await makeRes();
await served.sendFile("report.csv", {
  root: dir,
  headers: { "X-Served": "yes" },
  maxAge: 60_000,
  immutable: true,
});
const servedNative = await native(served);
checkEqual(
  "root, headers, maxAge (milliseconds), immutable",
  [
    servedNative.status,
    await servedNative.text(),
    servedNative.headers.get("Content-Type"),
    servedNative.headers.get("X-Served"),
    servedNative.headers.get("Cache-Control"),
    served.get("Content-Disposition"),
  ],
  [
    200,
    "a,b\n1,2\n",
    "text/csv",
    "yes",
    "public, max-age=60, immutable",
    undefined,
  ],
);
checkEqual(
  "maxAge as an ms string",
  (
    await (await makeRes()).sendFile("report.csv", { root: dir, maxAge: "1h" })
  ).get("Cache-Control"),
  "public, max-age=3600",
);
checkEqual(
  "lastModified (default true): the file's modification time",
  servedNative.headers.get("Last-Modified"),
  fileMtime,
);

const bare = await makeRes();
bare.set("Cache-Control", "no-store");
await bare.sendFile("report.csv", {
  root: dir,
  lastModified: false,
  cacheControl: false,
});
checkEqual(
  "lastModified: false; cacheControl: false leaves Cache-Control alone",
  [bare.get("Last-Modified"), bare.get("Cache-Control")],
  [undefined, "no-store"],
);
const cacheOnly = await makeRes();
cacheOnly.set("Cache-Control", "no-store");
await cacheOnly.sendFile("report.csv", { root: dir });
checkEqual(
  "cacheControl (default true) keeps a Cache-Control already set",
  cacheOnly.get("Cache-Control"),
  "no-store",
);
await Bun.write(join(dir, ".env"), "SECRET=1");
checkEqual(
  "dotfiles: ignore (default) 404, deny 403, allow 200",
  [
    (await native(await (await makeRes()).sendFile(".env", { root: dir })))
      .status,
    (
      await native(
        await (
          await makeRes()
        ).sendFile(".env", {
          root: dir,
          dotfiles: "deny",
        }),
      )
    ).status,
    (
      await native(
        await (
          await makeRes()
        ).sendFile(".env", {
          root: dir,
          dotfiles: "allow",
        }),
      )
    ).status,
  ],
  [404, 403, 200],
);
const ranged = await native(
  await (
    await makeRes({ Range: "bytes=0-2" })
  ).sendFile("report.csv", {
    root: dir,
  }),
);
checkEqual(
  "acceptRanges (default true): a Range is answered 206",
  [
    ranged.status,
    ranged.headers.get("Accept-Ranges"),
    ranged.headers.get("Content-Range"),
    await ranged.text(),
  ],
  [206, "bytes", "bytes 0-2/8", "a,b"],
);
checkEqual(
  "acceptRanges: false serves the whole file",
  (
    await native(
      await (
        await makeRes({ Range: "bytes=0-2" })
      ).sendFile("report.csv", {
        root: dir,
        acceptRanges: false,
      }),
    )
  ).status,
  200,
);

const asDownload = await makeRes();
await asDownload.sendFile("report.csv", {
  root: dir,
  download: true,
  filename: "sales.csv",
});
checkEqual(
  "download + filename",
  asDownload.get("Content-Disposition"),
  'attachment; filename="sales.csv"',
);
const missing = await makeRes();
await missing.sendFile("nope.csv", { root: dir });
const missingNative = await native(missing);
checkEqual(
  "a missing file: 404 Not Found",
  [missingNative.status, missingNative.statusText],
  [404, "Not Found"],
);
const notFound = await makeRes();
await notFound.handleNotFound();
checkEqual("handleNotFound()", (await native(notFound)).status, 404);

let callbackRan = false;
const downloaded = await makeRes();
await downloaded.download("report.csv", "renamed.csv", { root: dir }, () => {
  callbackRan = true;
});
checkEqual(
  "download(path, filename, options, cb)",
  [downloaded.get("Content-Disposition"), callbackRan],
  ['attachment; filename="renamed.csv"', true],
);
const attached = await makeRes();
attached.attachment();
checkEqual(
  "attachment() with no path",
  attached.get("Content-Disposition"),
  "attachment",
);
const attachedFile = await makeRes();
attachedFile.attachment(join(dir, "report.csv"));
checkEqual(
  "attachment(path) sets the type from the extension",
  attachedFile.get("Content-Type"),
  "text/csv",
);
checkEqual(
  "…and the basename as the filename",
  attachedFile.getHeader("Content-Disposition"),
  'attachment; filename="report.csv"',
);
await rm(dir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
step("Long-lived responses: write(), readableStream, getWritable(), end()");

const streaming = await makeRes();
let finished = false;
streaming.on("finish", () => {
  finished = true;
});
check("not long-lived at first", !streaming.isLongLived);
checkEqual("write() answers true", streaming.write("one "), true);
streaming.write(Buffer.from("two "));
streaming.write(new TextEncoder().encode("three").buffer);
checkEqual(
  "…switches to a long-lived stream, adding no headers (as Node)",
  [
    streaming.isLongLived,
    streaming.headersSent,
    streaming.get("Content-Type"),
    streaming.get("Cache-Control"),
    streaming.get("Connection"),
  ],
  [true, true, undefined, undefined, undefined],
);
const typedStream = await makeRes();
typedStream.setHeader("Content-Type", "text/event-stream");
typedStream.write("data: 1\n\n");
checkEqual(
  "…and keeps a Content-Type set before the first write",
  typedStream.get("Content-Type"),
  "text/event-stream",
);
await typedStream.end();
const streamedBody = streaming.getBody();
checkEqual(
  "getBody() lists the chunks",
  Array.isArray(streamedBody) ? streamedBody.length : undefined,
  3,
);
checkEqual(
  "initLongLivedConnection() again answers false",
  await streaming.initLongLivedConnection(),
  false,
);
const streamReader = (await native(streaming)).body!.getReader();
let streamedText = "";
while (streamedText.length < "one two three".length) {
  const { value } = await streamReader.read();
  streamedText += new TextDecoder().decode(value);
}
checkEqual("the client reads each chunk", streamedText, "one two three");
check("not finished while open", !finished);
check(
  "end() on a long-lived response resolves the response",
  (await streaming.end()) === streaming,
);
checkEqual("…closes the stream", (await streamReader.read()).done, true);
check("…and emits finish", finished);
checkEqual("write() after end() answers false", streaming.write("more"), false);

const flushed = await makeRes();
checkEqual(
  "flushHeaders() starts the stream",
  [flushed.flushHeaders(), flushed.isLongLived],
  [true, true],
);
check(
  "readableStream is the stream behind it",
  (await native(flushed)).body !== null && flushed.readableStream !== undefined,
);
const writer = flushed.getWritable();
let drained = 0;
flushed.on("drain", () => {
  drained++;
});
await writer.write("via writer");
checkEqual("getWritable().write() emits drain", drained, 1);
checkEqual("…ready resolves", await writer.ready, undefined);
await flushed.endLongLivedConnection();

const keptAlive = await makeRes();
keptAlive.req.socket.setKeepAlive(true);
check("isLongLived follows the request's keep-alive", keptAlive.isLongLived);

/* ------------------------------------------------------------------ */
step("upgradeToWebsocket()");

const upgradeReq = await makeReq("http://localhost/ws/room?x=1#h", {
  "X-Test": "1",
});
const upgrading = new BunResponse(upgradeReq);
checkEqual(
  "upgradeToWsData starts undefined",
  upgrading.upgradeToWsData,
  undefined,
);
upgrading.upgradeToWebsocket();
checkEqual(
  "the default data describes the request",
  [
    upgrading.upgradeToWsData?.path,
    upgrading.upgradeToWsData?.search,
    upgrading.upgradeToWsData?.hash,
    upgrading.upgradeToWsData?.originalUrl,
    upgrading.upgradeToWsData?.custom,
  ],
  ["/ws/room", "?x=1", "#h", "/ws/room?x=1#h", {}],
);
check("…and counts as headers sent", upgrading.headersSent);
const custom = new BunResponse<{ room: string }>(upgradeReq);
custom.upgradeToWebsocket({
  host: "h",
  path: "/p",
  search: "",
  hash: "",
  originalUrl: "/p",
  headers: new Headers(),
  user: undefined,
  custom: { room: "lobby" },
});
checkEqual("custom data is kept as given", custom.upgradeToWsData?.custom, {
  room: "lobby",
});

/* ------------------------------------------------------------------ */
step("Events: finish, close, error, drain, pipe, unpipe and the emitter API");

const evented = await makeRes();
const events: string[] = [];
evented.on("finish", () => events.push("finish"));
evented.addListener("close", () => events.push("close"));
evented.send("x");
await waitFor("close", () => events.includes("close"));
checkEqual("finish, then close", events, ["finish", "close"]);

const abortController = new AbortController();
const abortedRes = new BunResponse(
  await BunRequest.init(
    new Request("http://localhost/", { signal: abortController.signal }),
    FETCH_STUB_SERVER,
    { parseBody: false },
  ),
);
let closedOnAbort = false;
abortedRes.on("close", () => {
  closedOnAbort = true;
});
abortController.abort();
await waitFor("close on abort", () => closedOnAbort);
check("a dropped connection emits close", closedOnAbort);

const erroring = await makeRes();
// `unknown`, as the `error` event types it.
let caught: unknown;
erroring.on("error", (error) => {
  caught = error;
});
const failure = new Error("stream failure");
erroring.emitError(failure);
check("emitError() emits error", caught === failure);

const piped = await makeRes();
const pipeEvents: string[] = [];
piped.on("pipe", () => pipeEvents.push("pipe"));
piped.on("unpipe", () => pipeEvents.push("unpipe"));
const source = Readable.from(["chunk"]);
// `BunResponse` is not a `stream.Writable`; it emits `pipe`/`unpipe` like one,
// which is all `pipe()` needs here, so the cast has to go through `unknown`.
source.pipe(piped as unknown as Writable);
source.unpipe(piped as unknown as Writable);
source.destroy();
checkEqual("pipe and unpipe", pipeEvents, ["pipe", "unpipe"]);

const api = await makeRes();
checkEqual("emit() with no emitter answers false", api.emit("drain"), false);
checkEqual("getMaxListeners() before an emitter", api.getMaxListeners(), 10);
const order: string[] = [];
const listener = (): void => {
  order.push("on");
};
api.on("drain", listener);
api.prependListener("drain", () => order.push("prepended"));
api.prependOnceListener("drain", () => order.push("prepended once"));
api.once("drain", () => order.push("once"));
checkEqual(
  "listenerCount / listeners / eventNames",
  [api.listenerCount("drain"), api.listeners("drain").length, api.eventNames()],
  [4, 4, ["drain"]],
);
api.emit("drain");
api.emit("drain");
checkEqual("prepend order; once listeners fire once", order, [
  "prepended once",
  "prepended",
  "on",
  "once",
  "prepended",
  "on",
]);
api.off("drain", listener);
api.removeListener("drain", listener);
checkEqual("off / removeListener", api.listenerCount("drain"), 1);
check("setMaxListeners() returns the response", api.setMaxListeners(2) === api);
checkEqual("getMaxListeners()", api.getMaxListeners(), 2);
api.on("finish", () => {});
api.removeAllListeners("drain");
checkEqual("removeAllListeners(event)", api.eventNames(), ["finish"]);
api.removeAllListeners();
checkEqual("removeAllListeners()", api.eventNames(), []);

summary();
