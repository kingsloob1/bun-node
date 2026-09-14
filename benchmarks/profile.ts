#!/usr/bin/env bun
/**
 * Micro-profiler for the BunRouter request pipeline.
 *
 * Times each operation that runs while serving a request through
 * `BunHttpAdapter` → `BunRequest` / `BunRouter` / `BunResponse`, then ranks
 * them so the dominant cost is obvious.
 *
 *   bun profile.ts
 */
import { EventEmitter } from "node:events";
import process from "node:process";
import { BunHttpAdapter } from "../packages/bun-common/lib/index";
import { BunRequest } from "../packages/bun-common/lib/BunRequest";
import { BunResponse } from "../packages/bun-common/lib/BunResponse";
import { etag } from "../packages/bun-common/lib/utils/native";

const SYNC_ITERS = 300_000;
const ASYNC_ITERS = 80_000;
const WARMUP = 5_000;

/** Prevents the JIT from eliminating "unused" work. */
let sink: unknown;

interface Measurement {
  label: string;
  nsPerOp: number;
  group: string;
}

const measurements: Measurement[] = [];

function record(label: string, group: string, nsPerOp: number): void {
  measurements.push({ label, group, nsPerOp });
}

function benchSync(label: string, group: string, fn: () => unknown): number {
  for (let i = 0; i < WARMUP; i++) sink = fn();
  const start = Bun.nanoseconds();
  for (let i = 0; i < SYNC_ITERS; i++) sink = fn();
  const nsPerOp = (Bun.nanoseconds() - start) / SYNC_ITERS;
  record(label, group, nsPerOp);
  return nsPerOp;
}

async function benchAsync(
  label: string,
  group: string,
  fn: () => Promise<unknown>,
): Promise<number> {
  for (let i = 0; i < WARMUP; i++) sink = await fn();
  const start = Bun.nanoseconds();
  for (let i = 0; i < ASYNC_ITERS; i++) sink = await fn();
  const nsPerOp = (Bun.nanoseconds() - start) / ASYNC_ITERS;
  record(label, group, nsPerOp);
  return nsPerOp;
}

async function main(): Promise<void> {
  const adapter = new BunHttpAdapter(0, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
  });
  adapter.get("/ping", (_req, res) => res.send("ok"));
  await adapter.listen(46000);
  const server = adapter.server!;
  const router = adapter.instance;
  const requestOpts = {
    parseBody: false,
    parseCookies: false,
    parseQuery: false,
  } as const;

  const URL_STR = "http://127.0.0.1/ping";
  const makeNativeRequest = () => new Request(URL_STR);
  const makeBunRequest = () =>
    new BunRequest(makeNativeRequest(), server as never, requestOpts);

  console.log("Profiling the BunRouter request pipeline");
  console.log(`  Bun ${Bun.version}  ·  sync x${SYNC_ITERS.toLocaleString()}` +
    `  ·  async x${ASYNC_ITERS.toLocaleString()}\n`);

  /* --- primitives (baseline) ----------------------------------------- */
  benchSync("new URL()", "primitive", () => new URL(URL_STR));
  benchSync("new Request()", "primitive", () => new Request(URL_STR));
  benchSync(
    "EventEmitter subclass super()",
    "primitive",
    () => new (class extends EventEmitter {})(),
  );
  benchSync(
    "new Response(body, init)",
    "primitive",
    () => new Response("ok", { status: 200 }),
  );

  /* --- BunRequest ---------------------------------------------------- */
  benchSync("new BunRequest (constructor)", "BunRequest", makeBunRequest);
  await benchAsync("BunRequest.init (construct + ready)", "BunRequest", () =>
    BunRequest.init(makeNativeRequest(), server as never, requestOpts),
  );
  {
    // Getters the adapter reads to build the handle() options.
    const req = makeBunRequest();
    benchSync("req.method getter", "BunRequest", () => req.method);
    benchSync("req.headers getter (cached)", "BunRequest", () => req.headers);
  }
  // Both getters go through `splitRequestUrl()` — a single string scan, not a
  // `new URL()` — and share its cached result. Each figure below builds a fresh
  // request per iteration, so it includes construction (~73ns) plus one cold
  // scan; the second getter on the same request is effectively free.
  benchSync("req.host (fresh request: construct + url scan)", "BunRequest", () => {
    sink = makeBunRequest().host;
  });
  benchSync(
    "req.originalUrl (fresh request: construct + url scan)",
    "BunRequest",
    () => {
      sink = makeBunRequest().originalUrl;
    },
  );

  /* --- BunResponse --------------------------------------------------- */
  {
    const req = makeBunRequest();
    benchSync("new BunResponse", "BunResponse", () => new BunResponse(req));
  }
  benchSync("etag(body)", "BunResponse", () => etag("ok"));

  /* --- BunRouter ----------------------------------------------------- */
  const matchOptions = {
    requestHost: "127.0.0.1",
    requestMethod: "GET",
    requestUrl: "/ping",
  };
  benchSync("router.getCacheKey()", "BunRouter", () =>
    router.getCacheKey(matchOptions),
  );
  benchSync("router.getMatchedLayers() — cache HIT", "BunRouter", () =>
    router.getMatchedLayers(matchOptions),
  );
  benchSync("router.getMatchedLayers() — cache MISS", "BunRouter", () => {
    router.clearRouteCache();
    return router.getMatchedLayers(matchOptions);
  });

  /* --- async pipeline stages (cumulative subtraction) ---------------- */
  const tInit = measurements.find(
    (m) => m.label === "BunRequest.init (construct + ready)",
  )!.nsPerOp;

  const tInitResp = await benchAsync(
    "stage: init + new BunResponse",
    "_stage",
    async () => {
      const req = await BunRequest.init(
        makeNativeRequest(),
        server as never,
        requestOpts,
      );
      return new BunResponse(req);
    },
  );

  const tInitRespSend = await benchAsync(
    "stage: init + BunResponse + res.send",
    "_stage",
    async () => {
      const req = await BunRequest.init(
        makeNativeRequest(),
        server as never,
        requestOpts,
      );
      const res = new BunResponse(req);
      return res.send("ok");
    },
  );

  const tInitRespHandle = await benchAsync(
    "stage: init + BunResponse + handle",
    "_stage",
    async () => {
      const req = await BunRequest.init(
        makeNativeRequest(),
        server as never,
        requestOpts,
      );
      const res = new BunResponse(req);
      return router.handle({
        requestHost: req.host,
        requestMethod: req.method,
        requestUrl: req.originalUrl,
        request: req,
        response: res,
      });
    },
  );

  const tFull = await benchAsync(
    "stage: full server pipeline",
    "_stage",
    async () => {
      const req = await BunRequest.init(
        makeNativeRequest(),
        server as never,
        requestOpts,
      );
      const res = new BunResponse(req);
      await router.handle({
        requestHost: req.host,
        requestMethod: req.method,
        requestUrl: req.originalUrl,
        request: req,
        response: res,
      });
      return res.getNativeResponse(0);
    },
  );

  // Attribute the deltas.
  const tSend = tInitRespSend - tInitResp;
  const tHandle = tInitRespHandle - tInitResp;
  record("BunResponse.send (etag + new Response + headers)", "attributed", tSend);
  record(
    "BunRouter.handle total (getMatchedLayers + walk + send)",
    "attributed",
    tHandle,
  );
  record(
    "BunRouter.handle — walk/dispatch only (handle − send)",
    "attributed",
    tHandle - tSend,
  );
  record(
    "BunResponse.getNativeResponse",
    "attributed",
    tFull - tInitRespHandle,
  );

  await adapter.close();

  /* --- report -------------------------------------------------------- */
  const pipeline = tFull;

  console.log(`Full server-side pipeline: ${pipeline.toFixed(0)} ns/req\n`);

  const ranked = measurements
    .filter((m) => m.group !== "_stage")
    .sort((a, b) => b.nsPerOp - a.nsPerOp);

  const labelWidth = Math.max(...ranked.map((m) => m.label.length)) + 2;
  console.log(
    `  ${"operation".padEnd(labelWidth)}${"ns/op".padStart(11)}` +
      `${"µs/op".padStart(10)}${"% pipeline".padStart(13)}   group`,
  );
  console.log(`  ${"-".repeat(labelWidth + 47)}`);
  for (const m of ranked) {
    const pct = (m.nsPerOp / pipeline) * 100;
    console.log(
      `  ${m.label.padEnd(labelWidth)}` +
        `${m.nsPerOp.toFixed(0).padStart(11)}` +
        `${(m.nsPerOp / 1000).toFixed(3).padStart(10)}` +
        `${`${pct.toFixed(1)}%`.padStart(13)}   ${m.group}`,
    );
  }

  console.log("\nStage breakdown (cumulative):");
  console.log(`  init ......................... ${tInit.toFixed(0)} ns`);
  console.log(
    `  + new BunResponse ............ ${(tInitResp - tInit).toFixed(0)} ns`,
  );
  console.log(
    `  + handle (walk + send) ....... ${(tInitRespHandle - tInitResp).toFixed(0)} ns`,
  );
  console.log(
    `  + getNativeResponse .......... ${(tFull - tInitRespHandle).toFixed(0)} ns`,
  );
  console.log(`  = full pipeline .............. ${pipeline.toFixed(0)} ns`);

  if (sink === Symbol.for("never")) console.log(sink);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
