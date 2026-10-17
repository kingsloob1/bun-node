/**
 * Cost per body kind of the http-complete design, per request, through the
 * real pipeline (`router.fetch`, no socket), against a PATCHED copy of
 * bun-common (run.sh copies this file into the copy's `spike/`). Heavy: run it
 * through the heavy-run wrapper, from the copy's package directory:
 *
 *   HEAVY_TICKET=<you>-httpcost /tmp/claude-1000/bun-node-heavy-run.sh \
 *     nice -n 10 timeout 900 bun spike/bench.ts > <log> 2>&1
 *
 * Variants per kind, interleaved in rounds so a load spike hits all alike:
 *   base  no validator at all
 *   off   validate({}, { responses, responseValidation: "off" }) — no gate installed
 *   error validate({}, { responses, responseValidation: "error" }) with zod, a valid body
 * Read the minimums; the medians move with the machine's load, printed at
 * start and end.
 */
import type { RouterHandler } from "../lib/types/general";
import type { ResponseSchemas, ResponseValidationMode } from "../lib/responseContract";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BunRouter } from "../lib/BunRouter";
import { validate } from "../lib/BunValidate";
import { noopLogger } from "../lib/logging";
import { chunks, sse } from "../lib/responseContract";

const load = async () => (await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ");
const lines: string[] = [`# bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${navigator.hardwareConcurrency} cores, loadavg at start ${await load()}`];

const dir = mkdtempSync(join(tmpdir(), "http-complete-bench-"));
const file = join(dir, "f.txt");
writeFileSync(file, "ok: a small file body");

const user = (i: number) => ({ id: `u${i}`, name: `User ${i}`, email: `u${i}@example.com` });
const list = { items: Array.from({ length: 20 }, (_, i) => user(i)), total: 20 };
const ZList = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })), total: z.number() });
const bytes = new Uint8Array(512).fill(7);
const Bytes = z.instanceof(Uint8Array).refine((b) => b.length === 512);
const enc = new TextEncoder();

interface Kind {
  name: string;
  responses: ResponseSchemas;
  handler: RouterHandler;
  n: number;
}
const kinds: Kind[] = [
  { name: "json() 20-item list", responses: { 200: ZList }, handler: (_q, res) => res.json(list), n: 4000 },
  { name: "send(text)", responses: { 200: { content: { "text/plain": z.string().min(1) } } }, handler: (_q, res) => res.send("hello world"), n: 4000 },
  { name: "send(html)", responses: { 200: { content: { "text/html": z.string().startsWith("<") } } }, handler: (_q, res) => res.type("html").send("<p>hello</p>"), n: 4000 },
  { name: "send(Buffer 512 B)", responses: { 200: { content: { "application/octet-stream": Bytes } } }, handler: (_q, res) => res.send(Buffer.from(bytes)), n: 4000 },
  { name: "send(Uint8Array 512 B)", responses: { 200: { content: { "application/octet-stream": Bytes } } }, handler: (_q, res) => res.send(bytes), n: 4000 },
  { name: "send(Blob 512 B)", responses: { 200: { content: { "image/png": Bytes } } }, handler: (_q, res) => res.send(new Blob([bytes], { type: "image/png" })), n: 3000 },
  { name: "send(native Response)", responses: { 200: ZList }, handler: (_q, res) => res.send(Response.json(list)), n: 3000 },
  { name: "redirect()", responses: { 302: { headers: z.object({ location: z.string().startsWith("/app") }) } }, handler: (_q, res) => res.redirect("/app/home"), n: 4000 },
  { name: "sendFile()", responses: { 200: { content: { "text/plain": z.string().startsWith("ok") } } }, handler: async (_q, res) => void (await res.sendFile(file)), n: 2000 },
  {
    name: "send(ReadableStream) 4 chunks",
    responses: { 200: { content: { "text/plain": chunks(z.string().max(16)) } } },
    handler: (_q, res) =>
      res.type("text/plain").send(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 4; i++) c.enqueue(enc.encode(`chunk ${i}`));
            c.close();
          },
        }),
      ),
    n: 1500,
  },
  {
    name: "write()/end() 4 chunks",
    responses: { 200: { content: { "text/plain": chunks(z.string().max(16)) } } },
    handler: async (_q, res) => {
      res.setHeader("Content-Type", "text/plain");
      for (let i = 0; i < 4; i++) res.write(`chunk ${i}`);
      await res.end();
    },
    n: 1500,
  },
  {
    name: "SSE 4 events",
    responses: { 200: { content: { "text/event-stream": sse({ tick: z.object({ n: z.number() }) }) } } },
    handler: async (_q, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      for (let i = 0; i < 4; i++) res.write(`event: tick\ndata: {"n":${i}}\n\n`);
      await res.end();
    },
    n: 1500,
  },
];

function app(kind: Kind, variant: "base" | ResponseValidationMode): BunRouter {
  const r = new BunRouter();
  if (variant === "base") r.get("/x", kind.handler);
  else r.get("/x", validate({}, { responses: kind.responses, responseValidation: variant, logger: noopLogger }), kind.handler);
  return r;
}

async function time(r: BunRouter, n: number, init?: RequestInit): Promise<number> {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) await (await r.fetch("/x", init)).arrayBuffer();
  return (Bun.nanoseconds() - t0) / n / 1000;
}

// BENCH_SCALE (default 1) scales every count down for a smoke run.
const SCALE = Number(process.env.BENCH_SCALE ?? 1);
// BENCH_ROUNDS (default 7): more, shorter rounds give a steadier minimum on a loaded machine.
const ROUNDS = SCALE < 1 ? 1 : Number(process.env.BENCH_ROUNDS ?? 7);
const fmt = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return { min: sorted[0]!, med: sorted[Math.floor(sorted.length / 2)]! };
};
lines.push(`${"kind".padEnd(32)} ${"base min".padStart(9)} ${"off min".padStart(9)} ${"error min".padStart(10)} ${"+error".padStart(8)}   medians base/off/error (us/request, ${ROUNDS} rounds)`);
for (const kind of kinds) {
  const variants = (["base", "off", "error"] as const).map((v) => [v, app(kind, v)] as const);
  const n = Math.max(1, Math.round(kind.n * SCALE));
  for (const [, r] of variants) await time(r, Math.ceil(n / 4)); // warm-up
  const samples = new Map<string, number[]>(variants.map(([v]) => [v, []]));
  for (let round = 0; round < ROUNDS; round++) for (const [v, r] of variants) samples.get(v)!.push(await time(r, n));
  const b = fmt(samples.get("base")!);
  const o = fmt(samples.get("off")!);
  const e = fmt(samples.get("error")!);
  lines.push(
    `${kind.name.padEnd(32)} ${b.min.toFixed(2).padStart(9)} ${o.min.toFixed(2).padStart(9)} ${e.min.toFixed(2).padStart(10)} ${`+${(e.min - b.min).toFixed(2)}`.padStart(8)}   ${b.med.toFixed(2)}/${o.med.toFixed(2)}/${e.med.toFixed(2)}`,
  );
}

/* Request side: headers + cookies validated and copied to req.valid. */
{
  const handler: RouterHandler = (_q, res) => res.send("ok");
  const base = new BunRouter();
  base.get("/x", handler);
  const parts = new BunRouter();
  parts.get("/x", validate({ headers: z.object({ "x-n": z.coerce.number() }), cookies: z.object({ n: z.coerce.number() }) }), handler);
  const init = { headers: { "x-n": "5", cookie: "n=7; other=x" } };
  for (const r of [base, parts]) await time(r, 1000, init);
  const sb: number[] = [];
  const sp: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    sb.push(await time(base, Math.max(1, Math.round(4000 * SCALE)), init));
    sp.push(await time(parts, Math.max(1, Math.round(4000 * SCALE)), init));
  }
  const b = fmt(sb);
  const p = fmt(sp);
  lines.push(`${"request headers+cookies (zod)".padEnd(32)} ${b.min.toFixed(2).padStart(9)} ${"-".padStart(9)} ${p.min.toFixed(2).padStart(10)} ${`+${(p.min - b.min).toFixed(2)}`.padStart(8)}   ${b.med.toFixed(2)}/-/${p.med.toFixed(2)}`);
}

lines.push(`# loadavg at end ${await load()}`);
rmSync(dir, { recursive: true, force: true });
console.log(lines.join("\n"));
