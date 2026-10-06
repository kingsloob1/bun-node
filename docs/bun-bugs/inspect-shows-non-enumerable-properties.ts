/**
 * `Bun.inspect` (and so `console.log`) prints an object's non-enumerable own
 * properties, which Node's `util.inspect` and `console.log` leave out unless
 * `showHidden` is set. An `Error`'s are left out, as in Node.
 *
 *   bun docs/bun-bugs/inspect-shows-non-enumerable-properties.ts
 *
 * Exits 1 while the behaviour is present, 0 once it is fixed.
 */
import process from "node:process";
import { inspect } from "node:util";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)})`);

/** Defines `hidden` as a non-enumerable property holding a marker. */
function hide<T extends object>(target: T): T {
  Object.defineProperty(target, "hidden", {
    value: "MARKER",
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return target;
}

class Thing {
  visible = 1;
}

const cases: [string, object][] = [
  ["plain object", hide({ visible: 1 })],
  ["class instance", hide(new Thing())],
  ["Error (control)", hide(new Error("e"))],
];

let present = false;
for (const [name, value] of cases) {
  const bun = Bun.inspect(value).includes("MARKER");
  const node = inspect(value).includes("MARKER");
  const differs = bun !== node;
  if (differs) present = true;
  console.log(
    `${differs ? "DIFF" : "same"}  ${name.padEnd(16)} Bun.inspect shows it: ${bun}, util.inspect shows it: ${node}`,
  );
}
process.exit(present ? 1 : 0);
