/**
 * `JSON.stringify` on a deeply nested, acyclic array falls off a cliff a
 * little past 28,000 levels: under 1 ms there, about 0.8 s at 32,000 and about
 * 1.4 s from 40,000 on, where it either succeeds or throws a `RangeError`.
 * Node rejects any depth past its limit in about 6 ms.
 *
 *   bun docs/bun-bugs/json-stringify-deep-nesting-slow.ts
 *
 * Exits 1 while the behaviour is present, 0 once it is fixed.
 */
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)})`);

/** How long one `JSON.stringify` of a `depth`-deep array takes, and how it ended. */
function measure(depth: number): { ms: number; outcome: string } {
  const value: unknown = JSON.parse("[".repeat(depth) + "]".repeat(depth));
  const start = performance.now();
  let outcome = "ok";
  try {
    JSON.stringify(value);
  } catch (error) {
    outcome = (error as Error).constructor.name;
  }
  return { ms: performance.now() - start, outcome };
}

// The control first: below the cliff it is fast on every version measured.
const shallow = measure(28_000);
let present = false;
for (const depth of [28_000, 32_000, 200_000]) {
  const { ms, outcome } = depth === 28_000 ? shallow : measure(depth);
  // Linear in the depth would be a few ms; 100 ms is the cliff, with room.
  const slow = ms > 100;
  if (slow) present = true;
  console.log(
    `${slow ? "SLOW" : "fast"}  depth ${String(depth).padEnd(7)} ${ms.toFixed(1)} ms, ${outcome}`,
  );
}
process.exit(present ? 1 : 0);
