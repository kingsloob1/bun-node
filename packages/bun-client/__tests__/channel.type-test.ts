/**
 * `channel()`'s types (typed-client plan, `websocket.md` §3, §12 "Types"):
 * the spike's controls (an unknown type, missing data, `request` on a type
 * with no reply, a wrong field type), `Jsonify` on a received `Date`, a
 * `null` message taking no data, the options required when a URL part is,
 * listeners typed by name, and the generated map and the inferred client
 * agreeing (`Equal`) for the same contract. Checked by `bun run check`
 * (`bun test --check` reads no `*.type-test.ts`). Each `@ts-expect-error` is
 * a negative control: remove the refusal it covers and the check fails on
 * the unused directive.
 */
import type {
  ChannelClient,
  ChannelEntryOf,
  ChannelError,
  ChannelClosedError,
} from "../lib/channel";
import type { ValidationError } from "../lib/index";
import type { Channels } from "./codegen/fixtures/channels.gen";
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";
import { channel } from "../lib/channel";
import { createClient } from "../lib/index";
import { room, ticker } from "./codegen/fixtures/channels.contract";
import { channels } from "./codegen/fixtures/channels.gen";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const api = createClient();

const chat = channelContract({
  path: "/rooms/:room",
  receives: {
    say: z.object({ text: z.string(), page: z.coerce.number() }),
    typing: null,
  },
  sends: {
    said: z.object({ by: z.string(), at: z.date() }),
    someoneTyping: z.object({ by: z.string() }),
  },
  replies: { say: "said" },
});

const r = channel(api, chat, { params: { room: "lobby" } });

/* Sending: each field's wire input; a coercion sends its output. */
r.send("say", { text: "hi", page: 2 });
r.send("typing");
r.send("typing", undefined, { validate: false });
// @ts-expect-error an unknown type
r.send("shout", { text: "hi" });
// @ts-expect-error missing data
r.send("say");
// @ts-expect-error a wrong field type
r.send("say", { text: 1, page: 2 });
// @ts-expect-error a received type is not sent
r.send("said", { by: "x", at: "y" });
// @ts-expect-error a `null` message takes no data
r.send("typing", { any: 1 });

/* Requests: only a replied type; the reply's data after JSON. */
async function requests() {
  const _said = await r.request("say", { text: "hi", page: 1 }, { timeout: 5 });
  type _Reply = Expect<Equal<typeof _said, { by: string; at: string }>>;
  // @ts-expect-error `typing` has no reply
  await r.request("typing");
}
void requests;

/* Receiving: `Jsonify` of the wire type, so a `Date` arrives as a string. */
r.on("said", (_data, _frame) => {
  type _Data = Expect<Equal<typeof _data, { by: string; at: string }>>;
  type _Frame = Expect<Equal<typeof _frame, { type: "said"; id?: string }>>;
});
r.on("$state", (_state) => {
  type _State = Expect<
    Equal<typeof _state, "connecting" | "open" | "reconnecting" | "closed">
  >;
});
r.on("$error", (_error) => {
  type _Error = Expect<
    Equal<typeof _error, ChannelError | ValidationError | ChannelClosedError>
  >;
});
r.on("$invalid", (_error) => {
  type _Invalid = Expect<Equal<typeof _error, ValidationError>>;
});
// @ts-expect-error a sent type is not received
r.on("say", () => {});
// @ts-expect-error an unknown client event
r.on("$open", () => {});

async function iterate() {
  for await (const _data of r.messages("someoneTyping")) {
    type _One = Expect<Equal<typeof _data, { by: string }>>;
  }
  for await (const message of r.messages()) {
    if (message.type === "said") {
      type _Narrowed = Expect<
        Equal<typeof message.data, { by: string; at: string }>
      >;
    }
  }
}
void iterate;

/* The options: params required when the path has one, typed. */
// @ts-expect-error the room param is required
channel(api, chat);
// @ts-expect-error params are typed
channel(api, chat, { params: { room: 1 } });
channel(api, ticker);
channel(api, ticker, { reconnect: false, offline: "fail" });
// @ts-expect-error the heartbeat's type is a received one
channel(api, chat, {
  params: { room: "x" },
  heartbeat: { type: "say", intervalMs: 1 },
});
channel(api, chat, {
  params: { room: "x" },
  heartbeat: { type: "someoneTyping", intervalMs: 1 },
  ping: { type: "typing", intervalMs: 1 },
  resubscribe: (again) => again.send("typing"),
});

/* The query, when the upgrade declares one: required keys required. */
// @ts-expect-error the query's `name` is required
channel(api, room, { params: { room: "x" } });
channel(api, room, { params: { room: "x" }, query: { name: "ada" } });

/* Generated and inferred agree, entry by entry (W-D1). */
type _Room = Expect<
  Equal<Channels["/rooms/:room"], ChannelEntryOf<typeof room.spec>>
>;
type _Ticker = Expect<
  Equal<Channels["/ticker"], ChannelEntryOf<typeof ticker.spec>>
>;
type _Clients = Expect<
  Equal<
    ChannelClient<Channels["/rooms/:room"]>,
    ChannelClient<ChannelEntryOf<typeof room.spec>>
  >
>;
// Control: a generated entry differing in one field type does not agree.
type _Differs = Expect<
  Equal<
    Equal<
      Omit<Channels["/ticker"], "sends"> & {
        sends: { tick: { symbol: string; price: string } };
      },
      ChannelEntryOf<typeof ticker.spec>
    >,
    false
  >
>;

/* A generated descriptor types the client as the contract does. */
const fromDescriptor = channel(api, channels["/rooms/:room"], {
  params: { room: "x" },
  query: { name: "ada" },
});
fromDescriptor.send("join", { as: { name: "ada", age: null } });
// @ts-expect-error the generated descriptor's types hold too
fromDescriptor.send("join", { as: { name: "ada" } });
async function generatedRequest() {
  const _joined = await fromDescriptor.request("join", {
    as: { name: "a", age: 1 },
  });
  type _Joined = Expect<Equal<typeof _joined, { count: number }>>;
}
void generatedRequest;
