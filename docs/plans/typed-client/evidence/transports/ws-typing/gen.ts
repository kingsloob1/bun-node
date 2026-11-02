/**
 * Generates the WS typing projects: N channels (modules of 10), each with
 * 8 client → server messages (2 of them requests with a declared reply) and
 * 8 server → client messages, every message its own zod object schema.
 *
 *   bun ws-typing/gen.ts            # N = 10, 50, 200
 *
 * out/infer-N/: specs declared with `channelContract()` (browser-safe), the
 *   client's types inferred from them (`ChannelClient<S>`).
 * out/gen-N/: the same messages as a generated plain map (what codegen from
 *   the model writes), the client over it (`GenChannelClient`).
 * out/base-N/: the specs alone, no client: the cost of declaring them.
 *
 * Each client module calls every message once (send, request, on), with
 * `@ts-expect-error` negative controls (wrong field type, unknown type,
 * missing data), so a clean check proves the types bind.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dir, "out");
const sizes = process.argv.slice(2).map(Number);
const N_LIST = sizes.length ? sizes : [10, 50, 200];
const PER_MODULE = 10;
const IN = 8;
const OUT = 8;

const tsconfig = (include: string[]) =>
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        customConditions: ["@kingsleyweb/source"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        lib: ["ESNext", "DOM"],
        types: [],
      },
      include,
    },
    null,
    2,
  );

/** A field set, varied per message so no two schemas are identical. */
function fields(seed: number): string {
  const kinds = [
    "z.string().min(1)",
    "z.number().int()",
    "z.boolean()",
    "z.array(z.string())",
    'z.enum(["a", "b", "c"])',
    "z.string().optional()",
    "z.coerce.number()",
    "z.object({ x: z.number(), y: z.number() })",
  ];
  const n = 3 + (seed % 4);
  return Array.from({ length: n }, (_, i) => `f${i}: ${kinds[(seed + i) % kinds.length]}`).join(", ");
}
function tsFields(seed: number, side: "send" | "recv"): string {
  const kinds = [
    "string",
    "number",
    "boolean",
    "string[]",
    '"a" | "b" | "c"',
    "string | undefined",
    "number",
    "{ x: number; y: number }",
  ];
  const n = 3 + (seed % 4);
  return Array.from({ length: n }, (_, i) => {
    const k = (seed + i) % kinds.length;
    const opt = k === 5 ? "?" : "";
    return `f${i}${opt}: ${kinds[k]}`;
  }).join("; ");
}
/** A valid literal for message `seed` (first field only matters for the controls). */
function value(seed: number): string {
  const vals = ['"s"', "1", "true", '["s"]', '"a"', "undefined", "2", "{ x: 1, y: 2 }"];
  const n = 3 + (seed % 4);
  return `{ ${Array.from({ length: n }, (_, i) => {
    const k = (seed + i) % vals.length;
    return k === 5 ? "" : `f${i}: ${vals[k]}`;
  })
    .filter(Boolean)
    .join(", ")} }`;
}

function specModule(m: number, channels: number[]): string {
  const lines = ['import { z } from "zod";', 'import { channelContract } from "@kingsleyweb/bun-common/contract";', ""];
  for (const c of channels) {
    const recv = Array.from({ length: IN }, (_, i) => `    in${i}: z.object({ ${fields(c * 31 + i)} }),`).join("\n");
    const send = Array.from({ length: OUT }, (_, i) => `    out${i}: z.object({ ${fields(c * 17 + i + 3)} }),`).join("\n");
    lines.push(
      `export const ch${c} = channelContract({`,
      `  path: "/ch${c}/:room",`,
      `  receives: {\n${recv}\n  },`,
      `  sends: {\n${send}\n  },`,
      `  replies: { in0: "out0", in1: "out1" },`,
      `});`,
      "",
    );
  }
  void m;
  return lines.join("\n");
}

function inferClient(m: number, channels: number[]): string {
  const lines = [
    'import { channel } from "../../client-types";',
    `import { ${channels.map((c) => `ch${c}`).join(", ")} } from "./spec${m}";`,
    "",
    "export async function use(): Promise<void> {",
  ];
  for (const c of channels) {
    lines.push(`  const c${c} = channel(ch${c});`);
    for (let i = 0; i < IN; i++) lines.push(`  c${c}.send("in${i}", ${value(c * 31 + i)});`);
    lines.push(`  const r${c} = await c${c}.request("in0", ${value(c * 31)});`);
    lines.push(`  void r${c}.f0;`);
    for (let i = 0; i < OUT; i++) lines.push(`  c${c}.on("out${i}", (d) => void d.f0);`);
    if (c === channels[0]) {
      lines.push(`  // @ts-expect-error unknown message type`, `  c${c}.send("nope", {});`);
      lines.push(`  // @ts-expect-error data is required`, `  c${c}.send("in0");`);
      lines.push(`  // @ts-expect-error in2 has no declared reply`, `  void c${c}.request("in2", ${value(c * 31 + 2)});`);
      lines.push(`  // @ts-expect-error f0 is a number`, `  c${c}.on("out0", (d) => { const s: string = d.f0; void s; });`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

function genMap(all: number[]): string {
  const lines = ["export interface Channels {"];
  for (const c of all) {
    lines.push(`  "/ch${c}/:room": {`);
    lines.push(`    receives: {`);
    for (let i = 0; i < IN; i++) lines.push(`      in${i}: { ${tsFields(c * 31 + i, "send")} };`);
    lines.push(`    };`, `    sends: {`);
    for (let i = 0; i < OUT; i++) lines.push(`      out${i}: { ${tsFields(c * 17 + i + 3, "recv")} };`);
    lines.push(`    };`, `    replies: { in0: "out0"; in1: "out1" };`, `  };`);
  }
  lines.push("}");
  return lines.join("\n");
}

function genClient(channels: number[]): string {
  const lines = [
    'import { genChannel } from "../../client-types";',
    'import type { Channels } from "./channels.gen";',
    "",
    "export async function use(): Promise<void> {",
  ];
  for (const c of channels) {
    lines.push(`  const c${c} = genChannel<Channels, "/ch${c}/:room">("/ch${c}/:room");`);
    for (let i = 0; i < IN; i++) lines.push(`  c${c}.send("in${i}", ${value(c * 31 + i)});`);
    lines.push(`  const r${c} = await c${c}.request("in0", ${value(c * 31)});`);
    lines.push(`  void r${c}.f0;`);
    for (let i = 0; i < OUT; i++) lines.push(`  c${c}.on("out${i}", (d) => void d.f0);`);
    if (c === channels[0]) {
      lines.push(`  // @ts-expect-error unknown message type`, `  c${c}.send("nope", {});`);
      lines.push(`  // @ts-expect-error data is required`, `  c${c}.send("in0");`);
      lines.push(`  // @ts-expect-error in2 has no declared reply`, `  void c${c}.request("in2", ${value(c * 31 + 2)});`);
      lines.push(`  // @ts-expect-error f0 is a number`, `  c${c}.on("out0", (d) => { const s: string = d.f0; void s; });`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}

rmSync(out, { recursive: true, force: true });
for (const N of N_LIST) {
  const all = Array.from({ length: N }, (_, i) => i);
  const modules: number[][] = [];
  for (let i = 0; i < N; i += PER_MODULE) modules.push(all.slice(i, i + PER_MODULE));
  for (const variant of ["base", "infer", "gen"]) {
    const dir = join(out, `${variant}-${N}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), tsconfig(["./**/*.ts"]));
    if (variant === "gen") writeFileSync(join(dir, "channels.gen.ts"), genMap(all));
    modules.forEach((chs, m) => {
      if (variant !== "gen") writeFileSync(join(dir, `spec${m}.ts`), specModule(m, chs));
      if (variant === "infer") writeFileSync(join(dir, `client${m}.ts`), inferClient(m, chs));
      if (variant === "gen") writeFileSync(join(dir, `client${m}.ts`), genClient(chs));
    });
  }
  console.log(`N=${N}: ${modules.length} modules`);
}
