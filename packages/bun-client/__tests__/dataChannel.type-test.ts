/**
 * Compile-time assertions for `typedDataChannel` (PR-R2): each side's view
 * of a shared contract (a `"client"` sends `receives` and requests by
 * `replies`; a `"server"` sends `sends` and answers, its listener's return
 * typed as the answer; `symmetric` reads `receives` both ways), data after
 * JSON on arrival, `$binary` as `Uint8Array`, and a side required. Checked
 * by `bun run check` / `bun scripts/typecheck.ts`, not by `bun test`; every
 * `@ts-expect-error` is a negative control.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import type { RTCDataChannel } from "node-datachannel/polyfill";
import { channelContract } from "@kingsleyweb/bun-contract";
import { typedDataChannel } from "../lib/webrtc";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const Say: StandardSchemaV1<{ text: string; at: Date }>;
declare const Ask: StandardSchemaV1<{ q: string }>;
declare const Answer: StandardSchemaV1<{ a: string; at: Date }>;
declare const Said: StandardSchemaV1<{ by: string }>;
const chat = channelContract({
  path: "/dc/chat",
  receives: { say: Say, ask: Ask, nudge: null },
  sends: { said: Said, answer: Answer },
  replies: { ask: "answer" },
});
declare const dc: RTCDataChannel;

// The client side: sends `receives`, requests `ask`, receives `sends` after JSON.
const client = typedDataChannel(dc, chat, { side: "client" });
client.send("say", { text: "hi", at: new Date() });
client.send("nudge");
// @ts-expect-error a type the client does not send
client.send("said", { by: "x" });
// @ts-expect-error wrong data
client.send("say", { text: 1 });
export const asked = client.request("ask", { q: "?" });
export type _reply = Expect<
  Equal<Awaited<typeof asked>, { a: string; at: string }>
>;
// @ts-expect-error not a request (no reply declared)
void client.request("say", { text: "hi", at: new Date() });
client.on("said", (data, frame) => {
  const _data: Expect<Equal<typeof data, { by: string }>> = true;
  const _frame: Expect<Equal<typeof frame.type, "said">> = true;
  void [_data, _frame, data, frame];
});
// @ts-expect-error the client does not receive `say`
client.on("say", () => {});
client.on("$binary", (bytes) => {
  const _bytes: Expect<Equal<typeof bytes, Uint8Array>> = true;
  void [_bytes, bytes];
});
export const ready = client.sendWhenReady(
  "say",
  { text: "x", at: new Date() },
  { highWaterMark: 1024 },
);
export type _state = Expect<
  Equal<typeof client.state, "connecting" | "open" | "closing" | "closed">
>;

// The server side: sends `sends`, answers `ask` with the answer's wire input.
const server = typedDataChannel(dc, chat, { side: "server" });
server.send("said", { by: "bob" });
// @ts-expect-error a type the server does not send
server.send("say", { text: "", at: new Date() });
server.on("ask", (data) => {
  const _q: Expect<Equal<typeof data, { q: string }>> = true;
  void [_q, data];
  return { a: "ok", at: new Date() };
});
server.on("ask", async () => ({ a: "later", at: new Date() }));
// @ts-expect-error the answer's shape is the reply type's
server.on("ask", () => ({ a: 1 }));
// @ts-expect-error the server makes no requests
void server.request("ask", { q: "?" });

// Symmetric: `receives` both ways.
const p2p = channelContract({
  path: "/dc/p2p",
  receives: { ping: Ask, pong: Answer },
  sends: {},
  replies: { ping: "pong" },
});
const peer = typedDataChannel(dc, p2p, { symmetric: true });
peer.send("pong", { a: "x", at: new Date() });
export const pinged = peer.request("ping", { q: "?" });
export type _pong = Expect<
  Equal<Awaited<typeof pinged>, { a: string; at: string }>
>;
peer.on("ping", () => ({ a: "pong", at: new Date() }));

// A side is required, and only one.
// @ts-expect-error no side
typedDataChannel(dc, chat, {});
// @ts-expect-error both a side and symmetric
typedDataChannel(dc, chat, { side: "client", symmetric: true });
