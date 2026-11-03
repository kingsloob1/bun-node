/**
 * Compile-time assertions for `defineChannel`'s typed surface (typed-client
 * `websocket.md` §10, PR-W1): a replied type's handler returns the reply's
 * wire input (or nothing, to answer later); a handler's `ws` is typed with
 * the path literal's params, the declared `request` schemas' parsed output
 * and `handler<TCustom>()`'s custom data; `send` takes `{ id }` and resolves
 * to the send status, as `publish` does, on a socket or a server;
 * `defineChannel(contract)` types the channel exactly as the inline form.
 * Checked by `bun run check` / `bun scripts/typecheck.ts`, not by `bun test`;
 * every `@ts-expect-error` is a negative control that fails the build if the
 * error it expects ever disappears.
 */
import type { Server, ServerWebSocket } from "bun";
import type { Channel, ChannelSocket } from "../lib/channel";
import type { BunHttpAdapter } from "../lib/BunHttpAdapter";
import type { BunRequest } from "../lib/BunRequest";
import { z } from "zod";
import { defineChannel } from "../lib/channel";
import { channelContract } from "../lib/contract/channel";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** `say`'s data: a coercion, so the wire input differs from the output. */
const Say = z.object({ text: z.string(), at: z.coerce.date() });
/** `said`, the reply: `at` is a `Date` out, anything `z.coerce` takes in. */
const Said = z.object({ by: z.string(), text: z.string() });

/** The spec, declared once and shared by both forms. */
const spec = {
  path: "/rooms/:room/:kind?",
  request: {
    params: z.object({ room: z.string(), kind: z.string().optional() }),
    query: z.object({ page: z.coerce.number() }),
  },
  receives: { say: Say, typing: null, ping: null },
  sends: {
    said: Said,
    someoneTyping: z.object({ by: z.string() }),
    pong: null,
  },
  replies: { say: "said", ping: "pong" },
} as const;

/** The shared, browser-safe contract. */
const shared = channelContract(spec);
/** The inline form and the contract form. */
const inline = defineChannel(spec);
const fromContract = defineChannel(shared);

/** Both forms are the same channel type. */
export type _sameChannel = Expect<Equal<typeof inline, typeof fromContract>>;
export type _channelOfSpec = Expect<
  Equal<typeof fromContract, Channel<typeof spec>>
>;

/** The custom data a route's onUpgrade hook would set. */
interface Session {
  /** The speaker. */
  name: string;
}

export const handlers = fromContract.handler<Session>({
  say(ws, msg, _frame) {
    // The socket, typed by the channel.
    type _params = Expect<
      Equal<typeof ws.data.params, { room: string; kind?: string }>
    >;
    type _validParams = Expect<
      Equal<typeof ws.data.valid.params, { room: string; kind?: string }>
    >;
    // The parsed upgrade: the coerced query is a number.
    type _validQuery = Expect<
      Equal<typeof ws.data.valid.query, { page: number }>
    >;
    type _custom = Expect<Equal<typeof ws.data.custom, Session>>;
    type _frameShape = Expect<
      Equal<
        typeof _frame,
        { readonly type: "say"; readonly id: string | undefined }
      >
    >;
    // @ts-expect-error — the channel declares no `headers` request schema
    void ws.data.valid.headers;
    // The parsed data: the coercion's output.
    type _msg = Expect<Equal<typeof msg, { text: string; at: Date }>>;
    // A replied type returns the reply's wire input...
    return { by: ws.data.custom.name, text: msg.text };
  },
  typing(ws, _data, _frame) {
    type _dataType = Expect<Equal<typeof _data, undefined>>;
    type _frameType = Expect<Equal<typeof _frame.type, "typing">>;
    // An unreplied type may return anything; it is ignored.
    void ws;
    return 42;
  },
  // A data-less reply (`pong: null`) is sent on `null`.
  ping: () => null,
});

export const answerLater = inline.handler({
  // ...or nothing, to answer later with `send(…, { id })`.
  say(ws, msg, frame) {
    setTimeout(() => {
      void inline.send(
        ws,
        "said",
        { by: "later", text: msg.text },
        { id: frame.id },
      );
    }, 1);
  },
  async ping() {
    await Bun.sleep(1);
    return null;
  },
});

export const wrongReply = inline.handler({
  // @ts-expect-error — "said" is { by: string; text: string }: a number is not its wire input
  say: () => ({ by: 42, text: "x" }),
});

export const wrongNullReply = inline.handler({
  // @ts-expect-error — a data-less reply is sent on `null`, not on data
  ping: () => ({ some: "data" }),
});

export const wrongAsyncReply = inline.handler({
  // @ts-expect-error — the reply is checked through a promise too
  say: async () => ({ by: "x" }),
});

/** Without a `request`, `ws.data.valid` is whatever another validator parsed, if any; the params still come from the path. */
const bare = defineChannel({
  path: "/feed/*rest",
  receives: { hello: null },
  sends: { news: z.object({ headline: z.string() }) },
});
export const bareHandlers = bare.handler({
  hello(_ws) {
    type _params = Expect<Equal<typeof _ws.data.params, { rest: string[] }>>;
    type _valid = Expect<
      Equal<typeof _ws.data.valid, Record<string, unknown> | undefined>
    >;
    type _custom = Expect<Equal<typeof _ws.data.custom, unknown>>;
    // No reply is declared: the return is unchecked.
    return "ignored";
  },
});

/** `send`, `publish`: the status, `{ id }`, the targets. */
export function sends(
  ws: ChannelSocket<typeof spec, Session>,
  other: ServerWebSocket<{ anything: true }>,
  server: Server<unknown>,
  req: BunRequest,
  adapter: BunHttpAdapter,
): void {
  const _sent = inline.send(ws, "said", { by: "a", text: "b" });
  type _status = Expect<Equal<typeof _sent, Promise<number>>>;
  void inline.send(ws, "said", { by: "a", text: "b" }, { id: "m-1" });
  // A data-less type takes its options only.
  void inline.send(ws, "pong", { id: "m-2" });
  void inline.send(ws, "pong");
  // Any socket, not only the channel's own.
  void inline.send(other, "said", { by: "a", text: "b" });
  // @ts-expect-error — `id` is a string
  void inline.send(ws, "said", { by: "a", text: "b" }, { id: 7 });
  // @ts-expect-error — a data-less type takes no data
  void inline.send(ws, "pong", { by: "a" }, { id: "m-3" });

  const _published = inline.publish(ws, "room:a", "said", {
    by: "a",
    text: "b",
  });
  type _publishedStatus = Expect<Equal<typeof _published, Promise<number>>>;
  // A server: Bun's, a route handler's `req.server`, an adapter's.
  void inline.publish(server, "room:a", "said", { by: "a", text: "b" });
  if (req.server !== undefined) {
    void inline.publish(req.server, "room:a", "said", { by: "a", text: "b" });
  }
  if (adapter.server !== undefined) {
    void inline.publish(adapter.server, "room:a", "someoneTyping", { by: "a" });
  }
  void inline.publish(ws, "room:a", "pong");
  // @ts-expect-error — "nope" is not one of the channel's sends
  void inline.publish(server, "room:a", "nope", {});
  // @ts-expect-error — a topic is a string
  void inline.publish(server, 42, "pong");
}
