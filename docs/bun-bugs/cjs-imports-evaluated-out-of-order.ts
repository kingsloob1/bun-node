/**
 * An ES module importing two CommonJS packages, the first large and both
 * requiring a third, has them evaluated out of order: the second first. The
 * ES module spec, and Node, evaluate imports in source order
 * (oven-sh/bun#49614).
 *
 *   bun docs/bun-bugs/cjs-imports-evaluated-out-of-order.ts
 *
 * Writes the packages and the importing module to a temporary directory,
 * runs it with this Bun five times, and prints the order each run saw. A
 * control without the shared dependency keeps the order. Exits 1 while any
 * run is out of order, 0 once every run keeps it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision})`);

/** Writes the three packages under `dir`; `shared` decides whether both require "shared". */
function setup(dir: string, shared: boolean): void {
  const pkg = (name: string, body: string) => {
    mkdirSync(join(dir, "node_modules", name), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
    );
    writeFileSync(join(dir, "node_modules", name, "index.js"), body);
  };
  const log = (name: string) =>
    `globalThis.order = (globalThis.order ?? []).concat(${JSON.stringify(name)});\n`;
  const require = shared ? `require("shared");\n` : "";
  const padding = Array.from(
    { length: 60_000 },
    (_, i) => `// ${i} ${"x".repeat(80)}`,
  ).join("\n");
  pkg("big", `${log("big")}${require}${padding}\n`);
  pkg("small", `${log("small")}${require}`);
  pkg("shared", log("shared"));
  writeFileSync(
    join(dir, "repro.mjs"),
    'import "big";\nimport "small";\nconsole.log(globalThis.order.join(" then "));\n',
  );
}

/** Runs the repro in `dir` `times` times; the orders printed. */
function run(dir: string, times: number): string[] {
  return Array.from({ length: times }, () =>
    Bun.spawnSync([process.execPath, "repro.mjs"], { cwd: dir })
      .stdout.toString()
      .trim(),
  );
}

let wrong = 0;
for (const shared of [true, false]) {
  const dir = mkdtempSync(join(tmpdir(), "bun-cjs-order-"));
  try {
    setup(dir, shared);
    const orders = run(dir, 5);
    const expected = shared ? "big then shared then small" : "big then small";
    const label = shared ? "both require shared" : "control, no shared dependency";
    console.log(`${label}: expected "${expected}", saw ${JSON.stringify(orders)}`);
    if (shared) {
      wrong += orders.filter((order) => order !== expected).length;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(wrong === 0 ? 0 : 1);
