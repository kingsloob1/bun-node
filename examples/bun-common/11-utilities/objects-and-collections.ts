/**
 * Objects and collections — the type guards and lodash-style helpers that
 * replaced lodash-es in bun-common, and where they differ from lodash.
 *
 * ```bash
 * bun 11-utilities/objects-and-collections.ts
 * ```
 *
 * Every helper here is a few lines over the standard library, so the useful
 * thing to know is not *what* each does but the edges:
 *
 * - `isObject` follows lodash: arrays and functions are objects, `null` is not.
 *   `isNumber(NaN)` is `true`; `isNumeric` is the one that means "a finite
 *   number, or a string of one".
 * - `get` returns the default only for `undefined` — a stored `null` wins.
 * - `set` builds arrays only for numeric segments in an **array** path. A
 *   string path like `"list[0]"` yields string segments, so it builds objects.
 * - `merge` mutates and returns its target, merges arrays index by index,
 *   skips `undefined` and assigns non-plain objects (a `Date`) by reference.
 * - `cloneDeep` is `structuredClone`: `Date`/`Map`/`Set` survive, a class
 *   instance comes back a plain object, a function throws. `jsonClone` is the
 *   lossy JSON round trip — what a value looks like after crossing a wire.
 */
import type { JsonValue } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import {
  cloneDeep,
  each,
  first,
  flattenDeep,
  get,
  isAnyArrayBuffer,
  isArray,
  isArrayBufferView,
  isAsyncGeneratorFunction,
  isAsyncIterable,
  isBinaryBody,
  isBoolean,
  isBuffer,
  isError,
  isFunction,
  isMap,
  isNull,
  isNumber,
  isNumeric,
  isObject,
  isString,
  isUndefined,
  jsonClone,
  keys,
  lastIndexOf,
  merge,
  omit,
  orderBy,
  pick,
  set,
  unset,
  values,
} from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Objects and collections");

/* ------------------------------------------------------------------ */
step("Type guards: one question each, narrowing the type as they answer");

/** A few awkward values, each run past every guard. */
// `unknown` on purpose: a guard's job is to answer questions about any value.
const samples: [string, unknown][] = [
  ["[]", []],
  ["{}", {}],
  ["null", null],
  ["undefined", undefined],
  ["() => {}", () => {}],
  ["NaN", Number.NaN],
  ['"42"', "42"],
  ["new Map()", new Map()],
  ["Buffer", Buffer.from("x")],
  ["new Error()", new Error("x")],
];

for (const [label, value] of samples) {
  const yes = Object.entries({
    isArray: isArray(value),
    isObject: isObject(value),
    isNull: isNull(value),
    isUndefined: isUndefined(value),
    isFunction: isFunction(value),
    isNumber: isNumber(value),
    isNumeric: isNumeric(value),
    isString: isString(value),
    isBoolean: isBoolean(value),
    isMap: isMap(value),
    isBuffer: isBuffer(value),
    isError: isError(value),
  })
    .filter(([, answer]) => answer)
    .map(([name]) => name);
  show(label.padEnd(12), yes.join(", ") || "(none)");
}

// Narrowing: inside the branch `value` is a string, no cast needed.
const input: unknown = "  12.5 ";
if (isString(input) && isNumeric(input)) {
  show("isNumeric accepts padded numeric text", Number(input.trim()));
}
show("isNumeric rejects blank text, Infinity and NaN", [
  isNumeric(""),
  isNumeric("   "),
  isNumeric(Infinity),
  isNumeric(Number.NaN),
]);

/* ------------------------------------------------------------------ */
step("Binary and streaming bodies: what Bun can write to a socket");

const bytes = new TextEncoder().encode("hello");
show("isArrayBufferView", {
  Uint8Array: isArrayBufferView(bytes),
  Buffer: isArrayBufferView(Buffer.from("x")),
  DataView: isArrayBufferView(new DataView(bytes.buffer)),
  ArrayBuffer: isArrayBufferView(bytes.buffer),
});
show("isAnyArrayBuffer", {
  ArrayBuffer: isAnyArrayBuffer(new ArrayBuffer(4)),
  SharedArrayBuffer: isAnyArrayBuffer(new SharedArrayBuffer(4)),
  Uint8Array: isAnyArrayBuffer(bytes),
});
show("isBinaryBody (either of the above)", {
  Uint8Array: isBinaryBody(bytes),
  ArrayBuffer: isBinaryBody(new ArrayBuffer(4)),
  string: isBinaryBody("hello"),
  arrayLike: isBinaryBody({ length: 1 }),
});

/** An async generator function: Bun's `Response` can pull a body from one. */
async function* chunks(): AsyncGenerator<string> {
  yield "a";
  yield "b";
}
show("isAsyncGeneratorFunction", {
  asyncGeneratorFunction: isAsyncGeneratorFunction(chunks),
  runningGenerator: isAsyncGeneratorFunction(chunks()),
  asyncArrow: isAsyncGeneratorFunction(async () => {}),
});
show("isAsyncIterable", {
  runningGenerator: isAsyncIterable(chunks()),
  readableStream: isAsyncIterable(new Response("x").body),
  array: isAsyncIterable([1, 2]),
});

/* ------------------------------------------------------------------ */
step("keys / values / first / flattenDeep / lastIndexOf / each");

show("keys and values tolerate null", [keys(null), values(undefined)]);
show("keys of a string are its indexes", keys("ab"));
show("first works on any array-like", [first([3, 4]), first("xyz"), first([])]);
show("flattenDeep, however deep", flattenDeep([1, [2, [3, [4, [5]]]]]));
show("lastIndexOf, array and string", [
  lastIndexOf([1, 2, 1, 3], 1),
  lastIndexOf("a.b.c", "."),
]);

const visited: string[] = [];
each(["x", "y"], (value, index) => {
  visited.push(`${index}=${value}`);
});
each({ a: 1, b: 2 }, (value, key) => {
  visited.push(`${key}=${value}`);
});
each(null, () => {
  visited.push("never");
});
show("each visits arrays by index, objects by key, null not at all", visited);

/* ------------------------------------------------------------------ */
step("get / set / unset: property paths");

const config = {
  server: { port: 8080, tls: null, hosts: [{ name: "a" }, { name: "b" }] },
};
show("dotted and bracket paths", get<string>(config, "server.hosts[1].name"));
show("an array path", get<number>(config, ["server", "port"]));
show("a missing path takes the default", get(config, "server.x.y", "default"));
show("a stored null is not missing", get(config, "server.tls", "default"));

const built: Record<string, JsonValue> = {};
set(built, "db.pool.max", 10);
set(built, ["replicas", 0, "host"], "r1"); // a number segment: an array
set(built, "shards[0].host", "s1"); // a string path: "0" is a key
show("set creates what is missing", built);

show("unset deletes and reports whether it could", [
  unset(built, "shards"),
  unset("not an object", "length"),
]);
show("after unset", built);

/* ------------------------------------------------------------------ */
step("pick / omit: shallow, by own key");

const user = { id: 7, name: "Ada", password: "hunter2" };
show("pick", pick(user, ["id", "name", "missing"]));
show("omit", omit(user, ["password"]));
show("both tolerate null", [pick(null, ["a"]), omit(undefined, ["a"])]);

/* ------------------------------------------------------------------ */
step("merge: deep, in place, arrays by index");

const defaults = {
  retries: 3,
  tags: ["a", "b"],
  http: { timeout: 1_000, headers: { accept: "json" } },
};
const merged = merge(
  defaults,
  { http: { headers: { "x-id": "1" } } },
  { tags: [undefined, "B", "c"], retries: undefined, at: new Date(0) },
);
show("merged", merged);
show("it is the target, mutated", merged === defaults);

/* ------------------------------------------------------------------ */
step("orderBy: several keys, each with its own direction, stable");

const scores = [
  { team: "blue", points: 3, name: "c" },
  { team: "red", points: 9, name: "a" },
  { team: "blue", points: 7, name: "b" },
  { team: "blue", points: 7, name: "d" },
];
show(
  "team asc, points desc",
  orderBy(
    scores,
    [(row) => row.team, (row) => row.points],
    ["asc", "desc"],
  ).map((row) => row.name),
);
show(
  "the input is not reordered",
  scores.map((row) => row.name),
);

/* ------------------------------------------------------------------ */
step("cloneDeep vs jsonClone: in-process copy vs what crosses a wire");

/** A class, to see what each clone does with a prototype. */
class Point {
  /** Horizontal position. */
  x = 1;
}

const rich = {
  when: new Date(0),
  lookup: new Map([["k", 1]]),
  point: new Point(),
  missing: undefined,
};
const structured = cloneDeep(rich);
show("cloneDeep keeps Date and Map", [
  structured.when instanceof Date,
  structured.lookup.get("k"),
]);
show("but not the class", structured.point instanceof Point);
show("jsonClone flattens everything to JSON", jsonClone(rich));

try {
  cloneDeep({ fn: () => 1 });
} catch (error) {
  show("cloneDeep of a function throws", (error as Error).name);
}
