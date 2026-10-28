/**
 * The cache decorators' keys (plan §10.2): positional templates, and the
 * default key's stable serialisation of the arguments.
 */
import { describe, expect, it } from "bun:test";
import {
  compileKeyTemplate,
  defaultKey,
  stableSerialize,
} from "../lib/cache/keys";

const at = "Svc.m";

describe("key templates", () => {
  it("fills positional placeholders and property paths", () => {
    const key = compileKeyTemplate("orgs:{0}:page:{1.page}:{1.sort.by}", at);
    expect(key(["acme", { page: 2, sort: { by: "name" } }], at)).toBe(
      "orgs:acme:page:2:name",
    );
  });

  it("writes literal braces doubled, and text with no placeholder as it is", () => {
    expect(compileKeyTemplate("{{x}}:{0}", at)([7], at)).toBe("{x}:7");
    expect(compileKeyTemplate("plain", at)([], at)).toBe("plain");
  });

  it("writes numbers, bigints, booleans, null and dates", () => {
    const key = compileKeyTemplate("{0}|{1}|{2}|{3}|{4}", at);
    expect(
      key([1.5, 10n, false, null, new Date("2026-01-02T03:04:05Z")], at),
    ).toBe("1.5|10|false|null|2026-01-02T03:04:05.000Z");
  });

  it("refuses malformed templates when compiled (at decoration)", () => {
    expect(() => compileKeyTemplate("user:{id}", at)).toThrow(
      /placeholders are positional/,
    );
    expect(() => compileKeyTemplate("user:{0", at)).toThrow(/unclosed "\{"/);
    expect(() => compileKeyTemplate("user:0}", at)).toThrow(/unmatched "\}"/);
    expect(() => compileKeyTemplate("user:{}", at)).toThrow(
      /placeholders are positional/,
    );
  });

  it("refuses a placeholder out of range on the call", () => {
    const key = compileKeyTemplate("{0}:{2}", at);
    expect(() => key(["a", "b"], at)).toThrow(RangeError);
    expect(() => key(["a", "b"], at)).toThrow(
      /reads \{2\}, but the call passed 2 arguments/,
    );
  });

  it("refuses undefined and objects, which would make keys collide", () => {
    const key = compileKeyTemplate("{0.missing}", at);
    expect(() => key([{}], at)).toThrow(/undefined on this call/);
    expect(() => key([undefined], at)).toThrow(/undefined on this call/);
    expect(() => compileKeyTemplate("{0}", at)([{ a: 1 }], at)).toThrow(
      /which is an object; read one of its properties/,
    );
    expect(() => compileKeyTemplate("{0}", at)([[1]], at)).toThrow(
      /which is an array/,
    );
  });
});

describe("the default key", () => {
  it("is ClassName.method plus a hash, the same for equal arguments", () => {
    const one = defaultKey(at, [1, { a: 1, b: [2, 3] }]);
    expect(one).toMatch(/^Svc\.m:[\w-]{43}$/);
    expect(defaultKey(at, [1, { b: [2, 3], a: 1 }])).toBe(one);
    expect(defaultKey("Svc.other", [1, { a: 1, b: [2, 3] }])).not.toBe(one);
  });

  it("keeps values of different kinds apart", () => {
    const keys = [
      [1],
      ["1"],
      [1n],
      [true],
      ["true"],
      [null],
      [undefined],
      [],
      [Number.NaN],
      [Number.POSITIVE_INFINITY],
      [new Date(0)],
      [0],
      [[1]],
      [{ 0: 1 }],
      [new Uint8Array([1])],
      [new Set([1])],
      [new Map([[1, 1]])],
    ].map((args) => defaultKey(at, args));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("sorts plain objects' keys, but keeps a Map's insertion order (the documented rule)", () => {
    expect(stableSerialize({ b: 1, a: 2 }, new Set())).toBe(
      stableSerialize({ a: 2, b: 1 }, new Set()),
    );
    const ab = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const ba = new Map([
      ["b", 2],
      ["a", 1],
    ]);
    expect(stableSerialize(ab, new Set())).not.toBe(
      stableSerialize(ba, new Set()),
    );
  });

  it("accepts a shared reference, and refuses a cycle", () => {
    const shared = { x: 1 };
    expect(() => defaultKey(at, [shared, shared])).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => defaultKey(at, [cyclic])).toThrow(/cyclic/);
  });
});
