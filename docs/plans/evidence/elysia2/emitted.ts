/**
 * Prints what Elysia 2 compiles each benchmark route to: the source its JIT
 * emits for a route that gets a generated function (`setOnEmit`, the test
 * hook in dist/compile/handler/jit.mjs), or the kind of closure it returns
 * instead (`createInlineHandler` and friends emit nothing).
 *
 *   NODE_ENV=production bun emitted.ts
 */
import { makeTarget, SCENARIOS } from "./targets";

const JIT = "../../../../benchmarks/node_modules/elysia2/dist/compile/handler/jit.mjs";
const { setOnEmit } = (await import(JIT)) as { setOnEmit: (fn: ((code: string) => void) | undefined) => void };

let emitted: string[] = [];
setOnEmit((code) => emitted.push(code));
const serve = await makeTarget("elysia2");
for (const [name, make] of Object.entries(SCENARIOS)) {
  emitted = [];
  const r = await serve(make());
  console.log(`=== ${name} (${make().method} ${new URL(make().url).pathname}) -> ${r?.status}`);
  console.log(emitted.length ? emitted.join("\n---\n") : "(no generated source: an inline closure, see createInlineHandler)");
  console.log();
}
process.exit(0);
