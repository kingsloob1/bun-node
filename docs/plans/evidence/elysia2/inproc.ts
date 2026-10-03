/**
 * Where a request's time goes, in process: each target's `fetch` (the
 * function `Bun.serve` calls) timed per scenario, no sockets.
 *
 *   NODE_ENV=production bun inproc.ts [targets] [scenarios]
 *
 * ns per request, best of 5 passes of N after a warm-up, fresh `Request`
 * every call (its construction is included; the `new Request` row is that
 * floor). A promise result is awaited; a synchronous `Response` is not.
 */
import process from "node:process";
import { check, makeTarget, SCENARIOS, type Serve } from "./targets";

const N = Number(process.env.N ?? 100_000);
const targets = (process.argv[2] ?? "raw,elysia2,elysia1,bun-common,bun-nest").split(",");
const scenarios = (process.argv[3] ?? Object.keys(SCENARIOS).join(",")).split(",");
const sink: unknown[] = [];
/**
 * POLLUTE=<bytes>: after every request, walk a buffer of that size (one
 * write per 64-byte line) — a crude stand-in for the socket and kernel work
 * a served request is interleaved with, which evicts the caches the request
 * path ran in. 0 (default) = off.
 */
const POLLUTE = Number(process.env.POLLUTE ?? 0);
const scratch = new Uint8Array(POLLUTE || 64);
function pollute(): void {
  for (let i = 0; i < scratch.length; i += 64) scratch[i]++;
}

async function time(fn0: () => unknown, n = N): Promise<number> {
  const fn = POLLUTE ? () => (pollute(), fn0()) : fn0;
  for (let i = 0; i < 20_000; i++) {
    const r = fn();
    sink[i & 7] = r instanceof Promise ? await r : r;
  }
  let best = Infinity;
  for (let pass = 0; pass < 5; pass++) {
    const t0 = Bun.nanoseconds();
    for (let i = 0; i < n; i++) {
      const r = fn();
      sink[i & 7] = r instanceof Promise ? await r : r;
    }
    best = Math.min(best, (Bun.nanoseconds() - t0) / n);
  }
  return best;
}

console.log(`Bun ${Bun.version} (${Bun.revision}), NODE_ENV=${process.env.NODE_ENV}, N=${N}, POLLUTE=${POLLUTE}, best of 5, ns/request\n`);
const floor: Record<string, number> = {};
for (const s of scenarios) floor[s] = await time(SCENARIOS[s]);
console.log(`${"target".padEnd(16)}${scenarios.map((s) => s.padStart(14)).join("")}`);
console.log(`${"new Request".padEnd(16)}${scenarios.map((s) => floor[s].toFixed(0).padStart(14)).join("")}`);
for (const t of targets) {
  const serve: Serve = await makeTarget(t);
  const row: string[] = [];
  for (const s of scenarios) {
    const make = SCENARIOS[s];
    row.push((await time(() => serve(make()))).toFixed(0).padStart(14));
  }
  console.log(`${t.padEnd(16)}${row.join("")}`);
  if (process.env.CHECK) for (const s of scenarios) console.log(`   ${s}: ${await check(serve, s)}`);
}
process.exit(0);
