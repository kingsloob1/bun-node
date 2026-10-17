/**
 * Runtime probe of the http-complete design, against a PATCHED copy of
 * bun-common (http-complete.patch; run.sh copies this file into the copy's
 * `spike/`). Everything goes through `router.fetch()`, the production
 * pipeline with no socket.
 *
 *   H1-H24   each body kind x {zod (sync), yup (Promise)}: a bad body under
 *            off | warn | error, then a good body under error
 *   H25-...  status, headers, Set-Cookie, request cookies / signed cookies /
 *            typed headers, exemptions, and what bun-common does with a
 *            Response a handler returns
 *
 * Pass conditions are in README.md ("runtime.probe.ts").
 */
import type { RouterErrorMiddlewareHandler, RouterHandler } from "../lib/types/general";
import type { ResponseSchemas, ResponseValidationMode } from "../lib/responseContract";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yup from "yup";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { createTestLogger } from "../lib/logging";
import { chunks, sse } from "../lib/responseContract";
import { signCookie } from "../lib/utils/native";

const out: string[] = [];
const log = (s: string) => out.push(s);

/** The app's error handler: renders any error carrying `status` and `issues`. */
const errorHandler = ((err, _req, res, _next) => {
  const e = err as { status?: number; name?: string; issues?: { part?: string; target?: string; path: string; message: string }[] };
  res.status(e.status ?? 500).json({
    error: e.name ?? "Error",
    issues: (e.issues ?? []).map((i) => `${i.part ?? i.target}${i.path ? `.${i.path}` : ""}: ${i.message.slice(0, 48)}`),
  });
}) satisfies RouterErrorMiddlewareHandler;

/** Reads a response fully, reporting a stream cut off mid-body. */
async function show(resp: Response, width = 120): Promise<string> {
  // Read chunk by chunk, so a stream cut off mid-body shows what got out first.
  let body = "";
  const decoder = new TextDecoder();
  const reader = resp.body?.getReader();
  try {
    for (;;) {
      if (reader === undefined) break;
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    body = `${body}<then cut off: ${(error as Error).message.slice(0, 60)}>`;
  }
  const loc = resp.headers.get("location");
  return `${resp.status}${loc ? ` location=${loc}` : ""} ${body.replace(/\s+/g, " ").slice(0, width)}`;
}

/** One route with one contract; returns what the response looked like and how many warnings were logged. */
async function once(
  responses: ResponseSchemas,
  mode: ResponseValidationMode,
  handler: RouterHandler,
  init?: RequestInit & { path?: string },
): Promise<string> {
  const { logger, events } = createTestLogger();
  const r = new BunRouter();
  r.all("/x", validate({}, { responses, responseValidation: mode, logger }), handler);
  r.use(errorHandler);
  let shown: string;
  try {
    shown = await show(await r.fetch(init?.path ?? "/x", init));
  } catch (error) {
    shown = `fetch rejected: ${(error as Error).message.slice(0, 80)}`;
  }
  await Bun.sleep(5); // a "warn" Promise check logs after the response
  const warns = events.filter((e) => e.level === "warn").length;
  const errors = events.filter((e) => e.level === "error").length;
  return `${shown}${warns ? ` [warn x${warns}]` : ""}${errors ? ` [log error x${errors}]` : ""}`;
}

const dir = mkdtempSync(join(tmpdir(), "http-complete-"));
const goodFile = join(dir, "good.txt");
const badFile = join(dir, "bad.txt");
writeFileSync(goodFile, "ok: file");
writeFileSync(badFile, "nope");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const NOT_PNG = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

/** zod and yup versions of each schema. */
const S = {
  zod: {
    json: z.object({ id: z.string() }),
    text: z.string().min(3),
    html: z.string().startsWith("<"),
    bytes4: z.instanceof(Uint8Array).refine((b) => b.length === 4, "expected 4 bytes"),
    png: z.instanceof(Uint8Array).refine((b) => b[0] === 0x89, "not a PNG signature"),
    fileText: z.string().startsWith("ok"),
    chunk: z.string().max(5),
    tick: z.object({ n: z.number() }),
  },
  yup: {
    json: yup.object({ id: yup.string().strict().required() }),
    text: yup.string().strict().min(3).required(),
    html: yup.string().strict().matches(/^</).required(),
    bytes4: yup.mixed((v): v is Uint8Array => v instanceof Uint8Array).test("len", "expected 4 bytes", (b) => b?.length === 4),
    png: yup.mixed((v): v is Uint8Array => v instanceof Uint8Array).test("png", "not a PNG signature", (b) => b?.[0] === 0x89),
    fileText: yup.string().strict().matches(/^ok/).required(),
    chunk: yup.string().strict().max(5).required(),
    tick: yup.object({ n: yup.number().strict().required() }),
  },
} as const satisfies Record<string, Record<string, StandardSchemaV1>>;

type Vendor = keyof typeof S;
interface Kind {
  name: string;
  responses: (s: (typeof S)[Vendor]) => ResponseSchemas;
  bad: RouterHandler;
  good: RouterHandler;
}

const stream = (parts: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });

const kinds: Kind[] = [
  { name: "json()", responses: (s) => ({ 200: s.json }), bad: (_q, res) => res.status(200).json({ id: 1 }), good: (_q, res) => res.status(200).json({ id: "a" }) },
  { name: "send(text)", responses: (s) => ({ 200: { content: { "text/plain": s.text } } }), bad: (_q, res) => res.send("no"), good: (_q, res) => res.send("hello") },
  { name: "send(html)", responses: (s) => ({ 200: { content: { "text/html": s.html } } }), bad: (_q, res) => res.type("html").send("plain"), good: (_q, res) => res.type("html").send("<p>hi</p>") },
  { name: "send(Buffer)", responses: (s) => ({ 200: { content: { "application/octet-stream": s.bytes4 } } }), bad: (_q, res) => res.send(Buffer.from([1, 2])), good: (_q, res) => res.send(Buffer.from([1, 2, 3, 4])) },
  { name: "send(Uint8Array)", responses: (s) => ({ 200: { content: { "application/octet-stream": s.bytes4 } } }), bad: (_q, res) => res.send(new Uint8Array(2)), good: (_q, res) => res.send(new Uint8Array(4)) },
  { name: "send(Blob)", responses: (s) => ({ 200: { content: { "image/png": s.png } } }), bad: (_q, res) => res.send(new Blob([NOT_PNG], { type: "image/png" })), good: (_q, res) => res.send(new Blob([PNG], { type: "image/png" })) },
  {
    name: "send(native Response)",
    responses: (s) => ({ 200: s.json }),
    bad: (_q, res) => res.send(Response.json({ id: 2 })),
    good: (_q, res) => res.send(Response.json({ id: "b" })),
  },
  {
    name: "redirect()",
    responses: () => ({ 302: { headers: z.object({ location: z.string().startsWith("/app") }) } }),
    bad: (_q, res) => res.redirect("/elsewhere"),
    good: (_q, res) => res.redirect("/app/home"),
  },
  { name: "sendFile()", responses: (s) => ({ 200: { content: { "text/plain": s.fileText } } }), bad: async (_q, res) => void (await res.sendFile(badFile)), good: async (_q, res) => void (await res.sendFile(goodFile)) },
  { name: "send(ReadableStream)", responses: (s) => ({ 200: { content: { "text/plain": chunks(s.chunk) } } }), bad: (_q, res) => res.type("text/plain").send(stream(["abc", "toolong!"])), good: (_q, res) => res.type("text/plain").send(stream(["abc", "de"])) },
  {
    name: "write()/end()",
    responses: (s) => ({ 200: { content: { "text/plain": chunks(s.chunk) } } }),
    bad: async (_q, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.write("abc");
      res.write("toolong!");
      await res.end();
    },
    good: async (_q, res) => {
      res.setHeader("Content-Type", "text/plain");
      res.write("abc");
      res.write("de");
      await res.end();
    },
  },
  {
    name: "SSE per event",
    responses: (s) => ({ 200: { content: { "text/event-stream": sse({ tick: s.tick }) } } }),
    bad: async (_q, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('event: tick\ndata: {"n":1}\n\n');
      res.write('event: tick\ndata: {"n":"x"}\n\n');
      await res.end();
    },
    good: async (_q, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.write('event: tick\ndata: {"n":1}\n\n');
      res.write('event: tick\ndata: {"n":2}\n\n');
      await res.end();
    },
  },
];

let n = 0;
for (const kind of kinds) {
  for (const vendor of ["zod", "yup"] as const) {
    const responses = kind.responses(S[vendor]);
    const cells: string[] = [];
    for (const mode of ["off", "warn", "error"] as const) cells.push(`${mode}: ${await once(responses, mode, kind.bad)}`);
    cells.push(`GOOD error: ${await once(responses, "error", kind.good)}`);
    log(`H${++n} ${kind.name} / ${vendor}\n    ${cells.join("\n    ")}`);
  }
}

/* ---- status, headers, Set-Cookie ---------------------------------- */
const RateHeaders = z.object({ "x-ratelimit-remaining": z.string().regex(/^\d+$/), "content-type": z.string().startsWith("application/json") });
const contracts: [string, ResponseSchemas, RouterHandler][] = [
  ["undeclared status 418", { 200: S.zod.json }, (_q, res) => res.status(418).json({ id: "a" })],
  ["undeclared status, implicit 200", { 201: S.zod.json }, (_q, res) => res.json({ id: "a" })],
  ["text sent where only JSON is declared", { 200: S.zod.json }, (_q, res) => res.send("hi")],
  ["mismatched response header", { 200: { headers: RateHeaders, content: { "application/json": S.zod.json } } }, (_q, res) => res.set("X-RateLimit-Remaining", "many").json({ id: "a" })],
  ["missing response header", { 200: { headers: RateHeaders, content: { "application/json": S.zod.json } } }, (_q, res) => res.json({ id: "a" })],
  ["matching response header", { 200: { headers: RateHeaders, content: { "application/json": S.zod.json } } }, (_q, res) => res.set("X-RateLimit-Remaining", "9").json({ id: "a" })],
  [
    "Set-Cookie without HttpOnly",
    { 200: { cookies: z.object({ sid: z.object({ value: z.string(), httpOnly: z.literal(true), secure: z.literal(true) }) }), content: { "application/json": S.zod.json } } },
    (_q, res) => res.cookie("sid", "abc", { secure: true }).json({ id: "a" }),
  ],
  [
    "Set-Cookie as declared",
    { 200: { cookies: z.object({ sid: z.object({ value: z.string(), httpOnly: z.literal(true), secure: z.literal(true) }) }), content: { "application/json": S.zod.json } } },
    (_q, res) => res.cookie("sid", "abc", { secure: true, httpOnly: true }).json({ id: "a" }),
  ],
  ["204 declared null, sent empty", { 204: null }, (_q, res) => res.status(204).send(null)],
  ["404 declared null, body sent", { 200: S.zod.json, 404: null }, (_q, res) => res.status(404).json({ id: "a" })],
  ["redirect to an undeclared 301", { 302: null }, (_q, res) => res.redirect(301, "/app")],
  ["sendStatus(404) undeclared", { 200: S.zod.json }, (_q, res) => void res.sendStatus(404)],
  ["media type not declared (text/csv)", { 200: { content: { "application/json": S.zod.json } } }, (_q, res) => res.type("text/csv").send("a,b")],
  ["write() with an undeclared media type", { 200: { content: { "text/event-stream": sse({ tick: S.zod.tick }) } } }, async (_q, res) => { res.setHeader("Content-Type", "text/plain"); res.write("x"); res.write("y"); await res.end(); }],
  ["SSE undeclared event name", { 200: { content: { "text/event-stream": sse({ tick: S.zod.tick }) } } }, async (_q, res) => { res.setHeader("Content-Type", "text/event-stream"); res.write("event: boom\ndata: 1\n\n"); await res.end(); }],
  ["stream vs a whole-body schema (not buffered)", { 200: { content: { "text/plain": S.zod.text } } }, (_q, res) => res.type("text/plain").send(stream(["a"]))],
];
for (const [label, responses, handler] of contracts) {
  log(`H${++n} ${label}\n    warn: ${await once(responses, "warn", handler)}\n    error: ${await once(responses, "error", handler)}`);
}

/* ---- exemptions ---------------------------------------------------- */
{
  const responses: ResponseSchemas = { 200: S.zod.json };
  log(`H${++n} HEAD on a GET route, bad body, error: ${await once(responses, "error", (_q, res) => res.json({ id: 1 }), { method: "HEAD" })}`);
  const etagRouter = new BunRouter();
  etagRouter.get("/x", validate({}, { responses, responseValidation: "error" }), (_q, res) => res.setEtag(true).json({ id: "a" }));
  etagRouter.use(errorHandler);
  const first = await etagRouter.fetch("/x");
  const etag = first.headers.get("etag")!;
  log(`H${++n} 304 from freshness (If-None-Match), 304 undeclared, error: ${await show(await etagRouter.fetch("/x", { headers: { "if-none-match": etag } }))}`);
}
{
  const r = new BunRouter();
  // The typed `res` refuses this body at compile time too (types.probe.ts); the
  // directive keeps the runtime case compiling.
  // @ts-expect-error 200 declares { id: string }
  r.get("/x", validate({}, { responses: { 200: S.zod.json }, responseValidation: "error" }), (_q, res) => res.json({ id: 1 }));
  let shown: string;
  try {
    shown = await show(await r.fetch("/x"));
  } catch (error) {
    shown = `fetch rejected: ${(error as Error).name}: ${(error as Error).message.slice(0, 70)}`;
  }
  log(`H${++n} error mode with NO app error handler (router.fetch): ${shown}`);
}

{
  // An error handler's own response (a 500 for a thrown error, undeclared) is
  // checked but only reported: it must not be replaced by a
  // ResponseValidationError, which would mask the error it renders.
  log(`H${++n} handler throws; the error handler's 500 is undeclared, error: ${await once({ 200: S.zod.json }, "error", () => {
    throw Object.assign(new Error("boom"), { status: 500, name: "BoomError" });
  })}`);
  log(`H${++n} a refused redirect's Location does not leak into the 500, error: ${await once({ 302: { headers: z.object({ location: z.string().startsWith("/app") }) } }, "error", (_q, res) => res.redirect("/elsewhere"))}`);
}

/* ---- request parts on the patched copy ------------------------------ */
{
  const r = new BunRouter();
  r.get(
    "/req",
    validate(
      { headers: z.object({ "x-n": z.coerce.number() }), cookies: z.object({ n: z.coerce.number().int() }) },
      { onFailure: "respond" },
    ),
    (req, res) =>
      res.json({
        "req.valid.headers.x-n": `${typeof req.valid.headers["x-n"]} ${req.valid.headers["x-n"]}`,
        "req.headers.x-n (raw, untouched)": `${typeof req.headers["x-n"]} ${req.headers["x-n"]}`,
        "req.cookies.n": `${typeof req.cookies.n} ${req.cookies.n}`,
        "req.valid keys": Object.keys(req.valid),
        "req.accepts(json) still reads raw headers": req.accepts("json"),
      }),
  );
  log(`H${++n} typed header coerced + cookies target: ${await show(await r.fetch("/req", { headers: { "x-n": "5", cookie: "n=7", accept: "application/json" } }), 400)}`);
  log(`H${++n} mismatched request cookie: ${await show(await r.fetch("/req", { headers: { "x-n": "5", cookie: "n=seven" } }))}`);
  log(`H${++n} mismatched request header: ${await show(await r.fetch("/req", { headers: { "x-n": "five", cookie: "n=7" } }))}`);
}
{
  const SECRET = "k1";
  const r = new BunRouter();
  r.get(
    "/signed",
    (req, _res, next) => {
      req.parseCookies({ forceUpdateRequest: true, secret: SECRET });
      next();
    },
    validate({ signedCookies: z.object({ sid: z.string() }) }, { onFailure: "respond" }),
    (req, res) => res.json({ sid: req.signedCookies.sid }),
  );
  const genuine = encodeURIComponent(`s:${signCookie("alice", SECRET)}`);
  log(`H${++n} signedCookies, genuine: ${await show(await r.fetch("/signed", { headers: { cookie: `sid=${genuine}` } }))}`);
  log(`H${++n} signedCookies, forged unsigned: ${await show(await r.fetch("/signed", { headers: { cookie: "sid=alice" } }))}`);
  log(`H${++n} signedCookies, tampered: ${await show(await r.fetch("/signed", { headers: { cookie: `sid=${encodeURIComponent(`s:alice.${"A".repeat(43)}`)}` } }))}`);
}
{
  // Does bun-common honour a Response a handler RETURNS? (No: return values are ignored.)
  const r = new BunRouter();
  r.get("/ret", () => new Response("returned"));
  const outcome = await Promise.race([
    r.fetch("/ret").then(show, (e: Error) => `rejected: ${e.message}`),
    Bun.sleep(300).then(() => "no response within 300 ms (the pipeline waits; the returned Response is ignored)"),
  ]);
  log(`H${++n} handler RETURNS a native Response: ${outcome}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`# bun ${Bun.version} (${Bun.revision.slice(0, 9)}), patched bun-common copy\n${out.join("\n")}`);
process.exit(0);
