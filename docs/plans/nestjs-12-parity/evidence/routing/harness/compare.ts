/**
 * Compares the harness's raw runs and writes results.md:
 *
 *   bun compare.ts <raw-nest11.json> <raw-nest12.json> <results.md> [<raw-summary.json>]
 *
 * One row per request: Express and Bun on Nest 11 and 12 side by side, and a
 * verdict. `causes.md` beside this file (hand-written analysis) is appended.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface Outcome {
  status?: number;
  body?: unknown;
  contentType?: string | null;
  allow?: string | null;
  xPoweredBy?: string | null;
  trail?: string | null;
  handler?: string | null;
  location?: string | null;
  xCustom?: string | null;
  error?: string;
}
interface Probe {
  area: string;
  name: string;
  method?: string;
  path: string;
  headers?: Record<string, string>;
}
interface SideResult {
  bootError?: string;
  logs: { level: string; context?: string; message: string }[];
  results: Record<string, Outcome>;
  served?: Record<string, Outcome>;
}
interface GroupRun {
  name: string;
  only12: boolean;
  options: unknown;
  bunOptions: unknown;
  probes: Probe[];
  express: SideResult;
  bun: SideResult;
}
interface Run {
  bun: { version: string; revision: string };
  nest: Record<string, string>;
  groups: GroupRun[];
}

const [f11, f12, out] = process.argv.slice(2);
const run11: Run = JSON.parse(readFileSync(f11, "utf8"));
const run12: Run = JSON.parse(readFileSync(f12, "utf8"));

const BOOT = { error: "BOOT ERROR" } as Outcome;

function outcomeOf(side: SideResult | undefined, probe: string, served = false): Outcome | undefined {
  if (!side) return undefined;
  if (side.bootError) return { error: `BOOT ERROR: ${side.bootError.split("\n")[0]}` };
  return (served ? side.served : side.results)?.[probe];
}

/** The fields compared, normalised. `x-powered-by` is reported apart. */
function canon(o: Outcome | undefined): string {
  if (!o) return "n/a";
  if (o.error) return o.error.startsWith("BOOT ERROR") ? BOOT.error! : `ERR ${o.error}`;
  return JSON.stringify({
    status: o.status,
    body: o.body,
    ct: o.contentType?.toLowerCase().replace(/;\s*/g, ";") ?? null,
    allow: o.allow ?? null,
    trail: o.trail ?? null,
    handler: o.handler ?? null,
    location: o.location ?? null,
    xCustom: o.xCustom ?? null,
  });
}

function differingFields(a: Outcome | undefined, b: Outcome | undefined): string[] {
  if (!a || !b) return ["n/a"];
  if (a.error || b.error) return ["error"];
  const ca = JSON.parse(canon(a));
  const cb = JSON.parse(canon(b));
  return Object.keys(ca).filter((k) => JSON.stringify(ca[k]) !== JSON.stringify(cb[k]));
}

function cell(o: Outcome | undefined): string {
  if (!o) return "n/a";
  if (o.error) return o.error.startsWith("BOOT ERROR") ? "**boot error**" : `**${o.error.slice(0, 60)}**`;
  const parts: string[] = [String(o.status)];
  if (o.handler) parts.push(`\`${o.handler}\``);
  const body = o.body as Record<string, unknown> | string;
  if (body && typeof body === "object") {
    for (const key of ["id", "params", "sub", "method", "x"]) {
      if (key in body) parts.push(`${key}=${JSON.stringify(body[key])}`);
    }
    if (!o.handler && "message" in body) parts.push(`"${String(body.message).slice(0, 50)}"`);
  } else if (typeof body === "string" && body && !o.handler) {
    parts.push(`"${body.replace(/\s+/g, " ").slice(0, 40)}"`);
  }
  if (o.trail) parts.push(`mw[${o.trail}]`);
  if (o.allow) parts.push(`allow=${o.allow}`);
  if (o.location) parts.push(`loc=${o.location}`);
  if (o.xCustom) parts.push(`x-custom=${o.xCustom}`);
  return parts.join(" ").replace(/\|/g, "\\|");
}

interface Row {
  area: string;
  group: string;
  probe: Probe;
  e11?: Outcome;
  b11?: Outcome;
  e12?: Outcome;
  b12?: Outcome;
  verdict: string;
  diff12: string[];
  servedMismatch12: boolean;
  servedMismatch11: boolean;
}

const rows: Row[] = [];
const g11 = new Map(run11.groups.map((g) => [g.name, g]));
for (const g of run12.groups) {
  const old = g11.get(g.name);
  for (const probe of g.probes) {
    const e12 = outcomeOf(g.express, probe.name);
    const b12 = outcomeOf(g.bun, probe.name);
    const e11 = outcomeOf(old?.express, probe.name);
    const b11 = outcomeOf(old?.bun, probe.name);
    const same12 = canon(e12) === canon(b12);
    let verdict: string;
    if (!old) {
      verdict = same12 ? "same" : "bun differs from express on 12";
    } else {
      const same11 = canon(e11) === canon(b11);
      const expressChanged = canon(e11) !== canon(e12);
      const bunChanged = canon(b11) !== canon(b12);
      if (same12 && same11 && !expressChanged) verdict = "same";
      else if (same12 && same11) verdict = "Nest 12 changed both";
      else if (same12 && !same11) verdict = "bun matches on 12 only (Nest 12 fixed it)";
      else if (!same12 && same11) {
        verdict = bunChanged && !expressChanged
          ? "regression in bun on 12"
          : !bunChanged
            ? "bun differs on 12: Nest 12 changed express, bun kept 11's answer"
            : "bun differs on 12: both changed, differently";
      }
      else {
        verdict = "bun differs from express (11 and 12)";
        const notes = [expressChanged && "express changed on 12", bunChanged && "bun changed on 12"].filter(Boolean);
        if (notes.length) verdict += `; ${notes.join(", ")}`;
      }
    }
    const servedMismatch = (side?: SideResult) =>
      !!side && !side.bootError && canon(side.results[probe.name]) !== canon(side.served?.[probe.name]);
    rows.push({
      area: probe.area,
      group: g.name,
      probe,
      e11,
      b11,
      e12,
      b12,
      verdict,
      diff12: same12 ? [] : differingFields(e12, b12),
      servedMismatch12: servedMismatch(g.bun),
      servedMismatch11: servedMismatch(old?.bun),
    });
  }
}

const AREAS = [
  "routes",
  "syntax",
  "prefix/exclude",
  "versioning",
  "middleware",
  "not-found",
  "HEAD/OPTIONS/QUERY",
  "host",
  "nest12-options",
];

const lines: string[] = [];
const push = (...l: string[]) => lines.push(...l);
push(
  "# Routing differential: platform-express vs BunHttpAdapter, Nest 11 vs Nest 12",
  "",
  `Generated by \`agent-routing/harness/compare.ts\` from \`raw-nest11.json\` and \`raw-nest12.json\` (re-run: see README.md).`,
  "",
  `- Bun ${run12.bun.version} (${run12.bun.revision.slice(0, 9)})`,
  `- Nest 11 run: ${Object.entries(run11.nest).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  `- Nest 12 run: ${Object.entries(run12.nest).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  "",
);

const counts = new Map<string, number>();
for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
push(
  `**${rows.length} requests** in ${run12.groups.length} applications (Nest 12; ${run11.groups.length} of them also on Nest 11), each sent to Express and to the Bun adapter: ${rows.length * 2} compared on Nest 12, ${rows.filter((r) => r.e11).length * 2} on Nest 11. The Bun side is asked through \`adapter.fetch()\` and, as a cross-check, over its socket.`,
  "",
  "| verdict | requests |",
  "|---|---|",
  ...[...counts].sort((a, b) => b[1] - a[1]).map(([v, n]) => `| ${v} | ${n} |`),
  "",
  "Compared fields: status, body (parsed JSON), content-type (spacing normalised), `allow`, `location`, `x-custom`, the handler that ran (`x-h`) and the middleware trail (`x-trail`). `x-powered-by` is listed apart below. A cell reads `status \\`handler\\` params… mw[trail]`; a body is shown only where no handler ran.",
  "",
);

for (const area of AREAS) {
  const areaRows = rows.filter((r) => r.area === area);
  if (!areaRows.length) continue;
  push(`## ${area}`, "", "| group | request | express@11 | bun@11 | express@12 | bun@12 | verdict | fields differing on 12 |", "|---|---|---|---|---|---|---|---|");
  for (const r of areaRows) {
    const p = r.probe;
    const hdrs = p.headers ? ` ${Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join(", ")}` : "";
    const req = `\`${p.method ?? "GET"} ${p.path}\`${hdrs} — ${p.name}`.replace(/\|/g, "\\|");
    const v = r.verdict === "same" ? "same" : `**${r.verdict}**`;
    push(`| ${r.group} | ${req} | ${cell(r.e11)} | ${cell(r.b11)} | ${cell(r.e12)} | ${cell(r.b12)} | ${v} | ${r.diff12.join(", ")} |`);
  }
  push("");
}

push("## Startup logs (warnings and errors) and boot errors", "");
for (const [label, run] of [["Nest 11", run11], ["Nest 12", run12]] as const) {
  for (const g of run.groups) {
    for (const side of ["express", "bun"] as const) {
      const s = g[side];
      if (!s.bootError && !s.logs.length) continue;
      push(`- **${label} ${g.name} / ${side}**`);
      if (s.bootError) push(`  - boot error: \`${s.bootError.split("\n").join(" ").slice(0, 400)}\``);
      for (const l of s.logs) push(`  - ${l.level} [${l.context ?? ""}]: ${l.message.slice(0, 260).replace(/\n/g, " ")}`);
    }
  }
}
push("");

push("## x-powered-by", "");
const xpb = new Set<string>();
for (const r of rows) {
  xpb.add(`express: ${r.e12?.xPoweredBy ?? "none"}; bun: ${r.b12?.xPoweredBy ?? "none"}`);
}
push(...[...xpb].map((x) => `- ${x}`), "");

push("## Bun adapter: `adapter.fetch()` vs served over its socket", "");
const mism = rows.filter((r) => r.servedMismatch12 || r.servedMismatch11);
if (!mism.length) push("Every request answered the same through `fetch()` as over the socket, on both Nest versions.");
for (const r of mism) {
  const g12 = run12.groups.find((g) => g.name === r.group)!;
  const served = g12.bun.served?.[r.probe.name];
  push(`- ${r.group} \`${r.probe.method ?? "GET"} ${r.probe.path}\` (${r.probe.name}): fetch ${cell(r.b12)} / served ${cell(served)}${r.servedMismatch11 ? " (also on 11)" : ""}`);
}
push("");

const causes = join(dirname(import.meta.path), "causes.md");
if (existsSync(causes)) push(readFileSync(causes, "utf8"));

await Bun.write(out, `${lines.join("\n")}\n`);
await Bun.write(
  out.replace(/\.md$/, ".rows.json"),
  `${JSON.stringify(rows.map((r) => ({ group: r.group, area: r.area, probe: r.probe, verdict: r.verdict, diff12: r.diff12, e11: r.e11, b11: r.b11, e12: r.e12, b12: r.b12 })), null, 2)}\n`,
);
console.log(`wrote ${out}: ${rows.length} requests`);
for (const [v, n] of counts) console.log(`  ${n}\t${v}`);
