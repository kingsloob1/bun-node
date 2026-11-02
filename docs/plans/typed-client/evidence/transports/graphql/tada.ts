/**
 * What typing an external GraphQL API costs a client, the gql.tada way: the
 * schema's introspection as a `.d.ts`, and every operation's result and
 * variables inferred by TypeScript from the document string (no codegen per
 * operation).
 *
 *   bun graphql/tada.ts           # T = 50, 200 object types; 50 operations each
 *
 * For each size: builds an SDL (T object types, 8 fields each, two of them
 * relations; a Query field and a list field per type), introspects it with
 * graphql-js, writes `graphql-env.d.ts` with `@gql.tada/internal`'s
 * `outputIntrospectionFile`, writes 50 operations (nested selections,
 * variables), and checks the project with tsc 6.0.3 (`--extendedDiagnostics`,
 * median of 3) and a bare `bun --check` (wall, median of 3). The operations
 * file carries `@ts-expect-error` negative controls (a field's type, a
 * variable's type), so a clean check proves the inference binds.
 */
import { $ } from "bun";
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildSchema, introspectionFromSchema } from "graphql";
import { outputIntrospectionFile } from "@gql.tada/internal";

const ROOT = join(import.meta.dir, "../../../../../..");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const out = join(import.meta.dir, "out");
const OPS = 50;
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const stat = (text: string, label: string) => Number(new RegExp(`^${label}:\\s+([\\d.]+)`, "m").exec(text)?.[1]);
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.AGENT;
delete env.REPL_ID;

function sdl(T: number): string {
  const types: string[] = [];
  const query: string[] = [];
  for (let t = 0; t < T; t++) {
    const next = (t + 1) % T;
    const other = (t * 7 + 3) % T;
    types.push(
      `type T${t} { id: ID! name: String! count: Int! score: Float flag: Boolean! tags: [String!]! next: T${next} others(first: Int = 10): [T${other}!]! }`,
    );
    query.push(`t${t}(id: ID!): T${t}`, `list${t}(first: Int, after: String): [T${t}!]!`);
  }
  return `${types.join("\n")}\ntype Query { ${query.join(" ")} }\n`;
}

function operations(T: number): string {
  const lines = [
    'import { initGraphQLTada, type ResultOf, type VariablesOf } from "gql.tada";',
    'import type { introspection } from "./graphql-env";',
    "export const graphql = initGraphQLTada<{ introspection: introspection }>();",
    "",
  ];
  for (let i = 0; i < OPS; i++) {
    const t = (i * 13) % T;
    lines.push(
      `export const Op${i} = graphql(\`query Op${i}($id: ID!, $first: Int) { t${t}(id: $id) { id name count tags next { id name next { id score } } others(first: $first) { id flag } } list${t}(first: $first) { id name } }\`);`,
      `export function use${i}(r: ResultOf<typeof Op${i}>, v: VariablesOf<typeof Op${i}>): number { void v.id; return (r.t${t}?.count ?? 0) + r.list${t}.length + (r.t${t}?.others[0]?.flag ? 1 : 0); }`,
    );
  }
  lines.push(
    "declare const r0: ResultOf<typeof Op0>;",
    "// @ts-expect-error name is a string",
    `export const n: number = r0.t0!.name;`,
    "// @ts-expect-error id is required",
    "export const v: VariablesOf<typeof Op0> = { first: 1 };",
  );
  return lines.join("\n");
}

rmSync(out, { recursive: true, force: true });
console.log("T    sdl_KB  env_d.ts_KB  tsc: exit check_s  mem_MB  instantiations | bun --check: exit wall_ms");
for (const T of [50, 200]) {
  const dir = join(out, `tada-${T}`);
  mkdirSync(dir, { recursive: true });
  const source = sdl(T);
  const intro = introspectionFromSchema(buildSchema(source));
  writeFileSync(join(dir, "graphql-env.d.ts"), outputIntrospectionFile(intro, { fileType: ".d.ts", shouldPreprocess: true }));
  writeFileSync(join(dir, "ops.ts"), operations(T));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["./*.ts"] }, null, 2),
  );
  const checks: number[] = [];
  const mems: number[] = [];
  let inst = 0;
  let exit = 0;
  let firstErr = "";
  for (let i = 0; i < 3; i++) {
    const r = await $`${TSC} -p ${dir} --extendedDiagnostics`.nothrow().quiet();
    const text = r.stdout.toString();
    exit ||= r.exitCode;
    if (r.exitCode && !firstErr) firstErr = text.split("\n").filter((l) => l.includes("error")).slice(0, 3).join(" / ");
    checks.push(stat(text, "Check time"));
    mems.push(stat(text, "Memory used") / 1024);
    inst = stat(text, "Instantiations");
  }
  const walls: number[] = [];
  let bexit = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await $`bun --check`.cwd(dir).env(env).nothrow().quiet();
    walls.push(performance.now() - t0);
    bexit ||= r.exitCode;
  }
  console.log(
    `${String(T).padEnd(4)} ${(source.length / 1024).toFixed(1).padStart(6)} ${(statSync(join(dir, "graphql-env.d.ts")).size / 1024).toFixed(1).padStart(12)} ${String(exit).padStart(9)} ${median(checks).toFixed(2).padStart(7)} ${median(mems).toFixed(0).padStart(7)} ${String(inst).padStart(15)} | ${String(bexit).padStart(16)} ${median(walls).toFixed(0).padStart(7)}${firstErr ? `  ERR ${firstErr}` : ""}`,
  );
}
