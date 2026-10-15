/**
 * A throwaway prototype of runtime response checking (plan §B1), built on
 * today's public surface only — a middleware that wraps this request's
 * `res.json` — to answer three questions by measurement:
 *
 *   P1. Can a failed check still become a 500 (mode "error") when the schema
 *       answers synchronously? And when it answers with a Promise (yup)?
 *   P2. What do "off", "warn" and "error" cost per request, through the real
 *       pipeline (`router.fetch`, no socket), on a 20-item list?
 *   P3. Does holding the response for an async check stall the pipeline?
 *
 * The real design hooks inside BunResponse (§B1.3); wrapping `res.json` here
 * is only how a prototype reaches the same moment without editing the package.
 *
 *   bun response-check-proto.ts > results-proto.txt
 */
import type { BunResponse, RouterHandler, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";
import * as yup from "yup";
import { z } from "zod";

type Mode = "off" | "warn" | "error";
type Responses = Record<number, StandardSchemaV1 | null>;

function describeIssues(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((i) => `${(i.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".") || "(body)"}: ${i.message}`)
    .join("; ");
}

let warned = 0;
function checkResponses(responses: Responses, mode: Mode): RouterHandler {
  return (_req, res, next) => {
    if (mode === "off") return next();
    const original = res.json.bind(res) as (body: unknown) => BunResponse;
    const fail = (mismatch: string) => {
      if (mode === "warn") {
        warned++;
        return false;
      }
      res.status(500);
      original({ type: "about:blank", title: "Response failed its schema", status: 500, detail: mismatch });
      return true;
    };
    (res as { json: (body: unknown) => BunResponse }).json = (body: unknown) => {
      const status = res.statusCode;
      const schema = responses[status];
      if (schema === undefined) {
        if (!fail(`status ${status} is not declared`)) original(body);
        return res;
      }
      if (schema === null) {
        if (!(body === undefined ? false : fail(`status ${status} declares no body`))) original(body);
        return res;
      }
      const result = schema["~standard"].validate(body);
      if (!(result instanceof Promise)) {
        if (!(result.issues && fail(describeIssues(result.issues)))) original(body);
        return res;
      }
      // Async vendor: hold the response until the check settles. The pipeline
      // waits for a response, so nothing else is needed (P3 measures it).
      void result.then((r) => {
        if (!(r.issues && fail(describeIssues(r.issues)))) original(body);
      });
      return res;
    };
    next();
  };
}

const user = (i: number) => ({ id: `u${i}`, name: `User ${i}`, email: `u${i}@example.com` });
const good = { items: Array.from({ length: 20 }, (_, i) => user(i)), total: 20 };
const bad = { items: good.items.map((u, i) => (i === 7 ? { ...u, email: 42 } : u)), total: 20 };

const ZList = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })), total: z.number() });
const YList = yup.object({ items: yup.array(yup.object({ id: yup.string().required(), name: yup.string().required(), email: yup.string().strict().required() })).required(), total: yup.number().required() });

function app(schema: StandardSchemaV1, mode: Mode, body: unknown, withCheck = true) {
  const r = new BunRouter();
  const handler: RouterHandler = (_req, res) => res.status(200).json(body as object);
  if (withCheck) r.get("/list", checkResponses({ 200: schema, 404: null }, mode), handler);
  else r.get("/list", handler);
  return r;
}

const out: string[] = [`# bun ${Bun.version} (${Bun.revision.slice(0, 9)}), loadavg ${(await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ")}`];
const show = async (r: Response) => `${r.status} ${(await r.text()).slice(0, 110)}`;

/* P1 */
out.push(`P1a zod, mode error, bad body   => ${await show(await app(ZList, "error", bad).fetch("/list"))}`);
out.push(`P1b zod, mode warn,  bad body   => ${await show(await app(ZList, "warn", bad).fetch("/list"))} (warned ${warned})`);
out.push(`P1c yup (Promise), error, bad   => ${await show(await app(YList, "error", bad).fetch("/list"))}`);
out.push(`P1d yup (Promise), error, good  => ${(await app(YList, "error", good).fetch("/list")).status}`);
{
  const r = new BunRouter();
  r.get("/list", checkResponses({ 200: ZList }, "error"), (_req, res) => res.status(418).json({}));
  out.push(`P1e undeclared status 418       => ${await show(await r.fetch("/list"))}`);
}

/* P2 + P3: per-request cost through the pipeline. Variants are interleaved
   in rounds and the median per variant reported, so a load spike on a shared
   machine hits every variant alike rather than one. */
async function time(r: BunRouter, n: number) {
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < n; i++) await (await r.fetch("/list")).arrayBuffer();
  return (Bun.nanoseconds() - t0) / n / 1000;
}
const variants: [string, BunRouter, number][] = [
  ["no middleware (baseline)", app(ZList, "off", good, false), 10_000],
  ["check middleware, mode off", app(ZList, "off", good), 10_000],
  ["zod, mode warn, valid body", app(ZList, "warn", good), 10_000],
  ["zod, mode error, valid body", app(ZList, "error", good), 10_000],
  ["yup (Promise), mode error, valid body", app(YList, "error", good), 500],
];
for (const [, r] of variants) await time(r, 1_000); // warm-up
const samples = new Map<string, number[]>(variants.map(([l]) => [l, []]));
const ROUNDS = 7;
for (let round = 0; round < ROUNDS; round++) {
  for (const [label, r, n] of variants) samples.get(label)!.push(await time(r, n));
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const med = new Map([...samples].map(([l, xs]) => [l, median(xs)]));
for (const [label] of variants) {
  const xs = samples.get(label)!;
  out.push(`P2 ${label.padEnd(38)} median ${med.get(label)!.toFixed(2)} us/request  (min ${Math.min(...xs).toFixed(2)}, max ${Math.max(...xs).toFixed(2)}, ${ROUNDS} rounds)`);
}
const b = med.get("no middleware (baseline)")!;
out.push(`P2 overhead vs baseline (medians): off +${(med.get("check middleware, mode off")! - b).toFixed(2)} us, zod warn +${(med.get("zod, mode warn, valid body")! - b).toFixed(2)} us, zod error +${(med.get("zod, mode error, valid body")! - b).toFixed(2)} us, yup error +${(med.get("yup (Promise), mode error, valid body")! - b).toFixed(2)} us`);
out.push(`# loadavg at end ${(await Bun.file("/proc/loadavg").text()).split(" ").slice(0, 3).join(" ")}`);

console.log(out.join("\n"));
