/**
 * Compile-time assertions for a broadcast channel with a contract
 * (bun-native-routes plan §16.14.8, PR-sse2c): `createSseChannel({ contract:
 * sse({ … }) })` types `send()`, `sendList()` and `initial` by the declared
 * events, as a typed writer's `send()` is; without a contract anything goes.
 * Checked by `bun run check` / `bun scripts/typecheck.ts`, not by `bun test`;
 * every `@ts-expect-error` is a negative control that fails the build if the
 * error it expects ever disappears.
 */
import type { SseChannel } from "../../lib/sse";
import { z } from "zod";
import { createSseChannel, sse, sseVariants } from "../../lib/sse";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const Prices = sse({
  tick: z.object({ p: z.number() }),
  message: z.string(),
  gap: null,
  quote: sseVariants({
    bid: { data: z.object({ bid: z.number() }) },
    ask: { data: z.object({ ask: z.number() }), when: () => false },
  }),
});

const typed = createSseChannel({
  contract: Prices,
  initial: [{ event: "tick", data: { p: 1 } }],
});
export type _typed = Expect<Equal<typeof typed, SseChannel<typeof Prices>>>;
export type _contract = Expect<
  Equal<typeof typed.contract, typeof Prices | undefined>
>;

typed.send({ event: "tick", data: { p: 1 } });
typed.send({ event: "tick", data: { p: 1 }, id: "a" }, { topic: "t" });
typed.send({ data: "hello" });
typed.send({ event: "gap" });
typed.send({ event: "quote", data: { bid: 1 } });
typed.send({ event: "quote", variant: "ask", data: { ask: 1 } });

// @ts-expect-error data of the wrong type for the event
typed.send({ event: "tick", data: { p: "1" } });
// @ts-expect-error an undeclared event
typed.send({ event: "other", data: 1 });
// @ts-expect-error a null event with data
typed.send({ event: "gap", data: 1 });
// @ts-expect-error a variant's data under another variant's name
typed.send({ event: "quote", variant: "ask", data: { bid: 1 } });

typed.sendList([{ p: 1 }, { p: 2 }], { event: "tick" });
// @ts-expect-error an item that is not the event's data
typed.sendList([{ p: "1" }], { event: "tick" });
// @ts-expect-error an undeclared event name
typed.sendList([1], { event: "other" });

typed.setInitial(() => [{ event: "tick", data: { p: 2 } }]);
// @ts-expect-error an initial event the contract does not declare
typed.setInitial([{ event: "other", data: 1 }]);

// Without a contract: any message, any list.
const loose = createSseChannel();
export type _loose = Expect<Equal<typeof loose, SseChannel>>;
loose.send({ event: "anything", data: { x: 1 } });
loose.sendList([1, "two", { three: 3 }], { event: "row" });
// @ts-expect-error not a message
loose.send("text");
