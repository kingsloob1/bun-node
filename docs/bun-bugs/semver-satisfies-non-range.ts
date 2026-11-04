/**
 * Bun.semver.satisfies answers true for a string that is not a semver range
 * ("foo", "latest", "next"), where node-semver answers false: an invalid
 * range matches nothing (oven-sh/bun#47908).
 *
 *   bun docs/bun-bugs/semver-satisfies-non-range.ts
 *
 * Prints each answer, and a valid range as a control. Exits 1 while the bug
 * is present, 0 once every non-range answers false.
 */
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision})`);

const nonRanges: [string, string][] = [
  ["1.2.3", "foo"],
  ["1.2.3", "latest"],
  ["0.0.0", "next"],
  ["1.2.3", "not a range"],
];
let wrong = 0;
for (const [version, range] of nonRanges) {
  const got = Bun.semver.satisfies(version, range);
  console.log(
    `Bun.semver.satisfies(${JSON.stringify(version)}, ${JSON.stringify(range)}) = ${got} (node-semver: false)`,
  );
  if (got !== false) wrong++;
}
// The control: a real range still answers as node-semver does.
console.log(
  `control: Bun.semver.satisfies("1.2.3", "^1.0.0") = ${Bun.semver.satisfies("1.2.3", "^1.0.0")}, ` +
    `Bun.semver.satisfies("1.2.3", "^2.0.0") = ${Bun.semver.satisfies("1.2.3", "^2.0.0")}`,
);
process.exit(wrong === 0 ? 0 : 1);
