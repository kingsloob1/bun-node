/* eslint-disable no-console, n/prefer-global/process -- a CLI entry point, as scripts/ */
/**
 * What the variants matcher costs per response, by variant count (plan
 * §4.4.6, "Cost"). zod 4, in-process, no router: the matcher alone, the
 * decision V3c's commit gate adds. Prints the minimum and median ns per
 * match over ROUNDS rounds, and the load average before and after.
 *
 *   HEAVY_TICKET=<you>-v3c-bench /tmp/claude-1000/bun-node-heavy-run.sh nice -n 10 timeout 900 bash bench.sh > <scratch>/bench.out
 *
 * (`bun bench.ts` runs every scenario in one process; `ONLY="last N=8"` one.)
 *
 * Scenarios, each a response that is accepted:
 * - plain:  one status, no variants (a V3a status: headers + JSON body).
 * - first:  N variants, each with a `when` that holds; the response matches the first.
 * - last:   the same, matching the last, so N-1 variants fail their body first
 *           (each failure runs the vendor's failure path and the core's scrub).
 * - by:     N variants and a discriminant header: one variant checked.
 * - named:  N variants, `res.variant()` named the last: one variant checked,
 *           and its adjust plan walked with nothing to change (Q-H18).
 * - adjust fill+strip: one variant named, the body missing a literal and
 *           carrying three undeclared fields; reserialize: what V3c adds when
 *           an adjust changed the body (JSON.stringify and a new Response).
 *
 * While matching, a failing variant answers "no" from the vendor's own result,
 * with no issues built; `FLATTEN=1` builds and scrubs them as a refusal does
 * (bench.sh runs the `last` rows both ways).
 */
import { cpus, loadavg } from "node:os";
import { z } from "zod";
import { compile, match, matching, variants } from "./variants";

const ROUNDS = Number(process.env.ROUNDS ?? 15);
const ITER = Number(process.env.ITER ?? 20_000);
const WARM = Number(process.env.WARM ?? 200_000);
/** `FLATTEN=1`: build and scrub every failing variant's issues while matching (the first prototype), to compare. */
matching.flatten = process.env.FLATTEN === "1";
const Headers = z.object({ "x-request-id": z.string() });

/** A variant's body: `{ kind: "v<i>", id, n }`, so a variant fails another's body on `kind`. */
const body = (i: number) =>
  z.object({ kind: z.literal(`v${i}`), id: z.string(), n: z.number() });
const spec = (i: number, when: boolean) => ({
  ...(when ? { when: () => true } : {}),
  headers: Headers,
  content: { "application/json": body(i) },
});
const table = (n: number, by: boolean) =>
  compile({
    200: variants(
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`v${i}`, spec(i, true)]),
      ),
      by ? { by: { header: "x-variant" } } : {},
    ),
  });
const view = (
  i: number,
  extra: Record<string, string> = {},
  variant?: string,
) => ({
  status: 200,
  headers: {
    "content-type": "application/json",
    "x-request-id": "r1",
    ...extra,
  },
  cookies: {},
  mediaType: "application/json",
  body: { kind: `v${i}`, id: "a", n: 1 },
  ...(variant === undefined ? {} : { variant }),
});
const req = { valid: {} };

function time(f: () => unknown): { min: number; median: number } {
  for (let i = 0; i < WARM; i++) f(); // warm: enough for the JIT's top tier in a fresh process
  const per: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < ITER; i++) f();
    per.push(((performance.now() - t0) * 1e6) / ITER);
  }
  per.sort((a, b) => a - b);
  return { min: per[0], median: per[Math.floor(per.length / 2)] };
}

const check = (v: unknown) => {
  if (!(v as { ok: boolean }).ok)
    throw new Error(`bench case refused: ${JSON.stringify(v)}`);
};
const before = loadavg();
const rows: string[] = [];
const fmt = (x: number) => x.toFixed(0).padStart(6);
/** `ONLY=<name>` runs one scenario (bench.sh runs each in its own process, so one scenario's JIT state never reaches another's). */
const only = process.env.ONLY;
const row = (name: string, f: () => unknown) => {
  if (only !== undefined && only !== name) return;
  check(f());
  const t = time(f);
  rows.push(
    `${(matching.flatten ? `${name} (flatten)` : name).padEnd(22)} min ${fmt(t.min)} ns  median ${fmt(t.median)} ns`,
  );
};

const plain = compile({
  200: { headers: Headers, content: { "application/json": body(0) } },
});
const plainView = view(0);
row("plain", () => match(plain, plainView, req));
for (const n of [1, 2, 4, 8]) {
  const t = table(n, false);
  const tb = table(n, true);
  const first = view(0);
  const last = view(n - 1);
  const byLast = view(n - 1, { "x-variant": `v${n - 1}` });
  const named = view(n - 1, {}, `v${n - 1}`);
  row(`first N=${n}`, () => match(t, first, req));
  row(`last N=${n}`, () => match(t, last, req));
  row(`by N=${n}`, () => match(tb, byLast, req));
  row(`named N=${n}`, () => match(t, named, req));
}
// `.variant()`'s adjust (Q-H18). "named" above already walks the plan with nothing to change.
{
  const t = table(1, false);
  const draft = {
    ...view(0, {}, "v0"),
    body: { id: "a", n: 1, x1: 1, x2: "two", x3: [3] }, // kind missing (a literal: filled); three undeclared fields (stripped)
  };
  row("adjust fill+strip", () => match(t, draft, req));
  // What V3c adds when something changed: the body serialised again into a new Response.
  const adjusted = { kind: "v0", id: "a", n: 1 };
  row("reserialize", () => {
    void new Response(JSON.stringify(adjusted), {
      headers: { "content-type": "application/json" },
    });
    return { ok: true };
  });
}
const after = loadavg();
console.log(
  `# response-variants bench — Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${cpus().length} cores, ${ROUNDS} rounds × ${ITER} after ${WARM} warm-up calls`,
);
console.log(
  `# load before ${before.map((x) => x.toFixed(2)).join(" ")}; after ${after.map((x) => x.toFixed(2)).join(" ")}`,
);
console.log(rows.join("\n"));
