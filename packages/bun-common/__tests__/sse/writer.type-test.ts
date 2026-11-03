/**
 * Compile-time assertions for the SSE writer's typed surface
 * (typed-client `sse.md` §4.1, bun-validate V11): with `contract:
 * sse({ … })`, `send()` takes a union over the declared events, `event`
 * selecting `data`'s type (the schema's wire input), `message` the one
 * event that may omit `event`, a `null` event no data; `resume` returns
 * those events or `"gap"`; without a contract anything goes. Checked by
 * `bun run check` / `bun scripts/typecheck.ts`, not by `bun test`; every
 * `@ts-expect-error` is a negative control that fails the build if the error
 * it expects ever disappears.
 */
import type { BunResponse } from "../../lib/BunResponse";
import type { SseContractEvent, SseSendOf, SseWriter } from "../../lib/sse";
import { z } from "zod";
import { sse } from "../../lib/responseBodies";
import { sseResponse } from "../../lib/sse";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const Events = sse({
  tick: z.object({ n: z.number(), at: z.coerce.date() }),
  message: z.string(),
  gap: null,
});

declare const res: BunResponse;

const typed = res.sse({ contract: Events, ids: "auto" });
export type _typed = Expect<Equal<typeof typed, SseWriter<typeof Events>>>;

void typed.send({ event: "tick", data: { n: 1, at: new Date() } });
void typed.send({ event: "tick", data: { n: 1, at: new Date() }, id: 5 });
// @ts-expect-error a coercion's input is `unknown`, so the sender is held to its output (a Date)
void typed.send({ event: "tick", data: { n: 1, at: "2026-11-03" } });
void typed.send({ data: "hello" });
void typed.send({ event: "message", data: "hello", retry: 1000 });
void typed.send({ event: "gap" });

// @ts-expect-error data of the wrong type for the event
void typed.send({ event: "tick", data: { n: "1", at: new Date() } });
// @ts-expect-error an undeclared event
void typed.send({ event: "other", data: 1 });
// @ts-expect-error a tick without its data
void typed.send({ event: "tick" });
// @ts-expect-error a null event with data
void typed.send({ event: "gap", data: 1 });
// @ts-expect-error message's data is a string
void typed.send({ data: 1 });
// @ts-expect-error no pre-encoded bytes on a typed writer
void typed.send(new Uint8Array());

export type _union = Expect<
  Equal<SseSendOf<typeof Events>, SseContractEvent<(typeof Events)["events"]>>
>;

res.sse({
  contract: Events,
  resume: (lastEventId) => {
    const _id: string = lastEventId;
    return lastEventId === "0"
      ? "gap"
      : [{ event: "tick", data: { n: 1, at: new Date() } }];
  },
});
res.sse({
  contract: Events,
  async *resume() {
    yield { event: "tick", data: { n: 1, at: new Date() } };
    yield { data: "a message" };
  },
  onError: (_error, writer) => {
    void writer.send({ event: "gap" });
  },
});
res.sse({
  contract: Events,
  // @ts-expect-error a replayed event must be declared
  resume: () => [{ event: "other" }],
});

const untyped = res.sse();
export type _untyped = Expect<Equal<typeof untyped, SseWriter<undefined>>>;
void untyped.send({ event: "anything", data: { any: 1 } });
void untyped.send(new Uint8Array());
// @ts-expect-error not a block
void untyped.send(42);

sseResponse([{ event: "tick", data: { n: 1, at: new Date() } }], {
  contract: Events,
});
// @ts-expect-error a source event must match the contract
sseResponse([{ event: "tick", data: { n: "x", at: new Date() } }], {
  contract: Events,
});
sseResponse(
  async (writer) => {
    await writer.send({ event: "gap" });
    writer.close();
  },
  { contract: Events },
);
