/**
 * bun-client's `Jsonify` is a copy of bun-common's (D17: the client never
 * imports bun-common). This holds the two equal over a corpus covering every
 * branch, so a change made to one copy alone fails `bun run check`. The
 * `@ts-expect-error` is the negative control: a deliberately different type
 * must not pass for equal.
 */
import type { Jsonify as ClientJsonify } from "../lib/index";
import type { Jsonify as CommonJsonify } from "@kingsleyweb/bun-common";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** Both copies give the same type for `T`. */
type Same<T> = Equal<ClientJsonify<T>, CommonJsonify<T>>;

interface WithToJson {
  toJSON: () => { when: string };
}

type _corpus = [
  Expect<Same<string>>,
  Expect<Same<number | null>>,
  Expect<Same<boolean>>,
  Expect<Same<"a" | 1 | true>>,
  Expect<Same<unknown>>,
  // `any` stays `any` in both.
  Expect<Same<any>>,
  Expect<Same<undefined>>,
  Expect<Same<() => void>>,
  Expect<Same<symbol>>,
  Expect<Same<bigint>>,
  Expect<Same<Date>>,
  Expect<Same<WithToJson>>,
  Expect<Same<Map<string, number>>>,
  Expect<Same<Set<string>>>,
  Expect<Same<readonly string[]>>,
  Expect<Same<[Date, undefined, () => void]>>,
  Expect<Same<(string | undefined)[]>>,
  Expect<
    Same<{
      a: Date;
      b?: number;
      c: undefined;
      d: string | undefined;
      e: () => void;
      [k: symbol]: string;
    }>
  >,
  Expect<
    Same<{ readonly nested: { at: Date; list: { x: bigint | number }[] } }>
  >,
  Expect<Same<{ u: unknown; maybe?: unknown }>>,
  Expect<Same<{ a: string } | { b: Date }>>,
  Expect<Same<Record<string, Date>>>,
];

// @ts-expect-error -- negative control: a Date is not left a Date
type _control = Expect<Equal<ClientJsonify<{ at: Date }>, { at: Date }>>;
