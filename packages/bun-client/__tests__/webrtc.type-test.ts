/**
 * Compile-time assertions for `./webrtc` (PR-R1): `connectPeer` takes a
 * channel opened on bun-common's `signallingContract()` and refuses any
 * other; its `offer` takes the received `offer` message; `rtc` types the
 * connection (node-datachannel's polyfill here; the browser's is
 * `browser/webrtc.dom.type-test.ts`). Checked by `bun run check` /
 * `bun scripts/typecheck.ts`, not by `bun test`; every `@ts-expect-error` is
 * a negative control.
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import { channelContract } from "@kingsleyweb/bun-contract";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { channel } from "../lib/channel";
import { createClient } from "../lib/index";
import { connectPeer } from "../lib/webrtc";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const api = createClient({ baseUrl: "http://127.0.0.1:1" });
const sig = channel(api, signallingContract({ path: "/rtc/:room" }), {
  params: { room: "r" },
});

// The signalling channel is typed by the contract: join answered by peers.
export const joined = () => sig.request("join", { peer: "alice" });
export type _peers = Expect<
  Equal<Awaited<ReturnType<typeof joined>>, { peers: string[] }>
>;

// A connection typed by `rtc`.
const peer = connectPeer(sig, { to: "bob", rtc: RTCPeerConnection });
export type _connection = Expect<
  Equal<typeof peer.connection, RTCPeerConnection>
>;
export const dc = peer.createDataChannel("chat", { ordered: true });
export type _dc = Expect<
  Equal<typeof dc, ReturnType<RTCPeerConnection["createDataChannel"]>>
>;
export type _to = Expect<Equal<typeof peer.to, string>>;

// The received offer is what `offer` takes.
sig.on("offer", (offer) => {
  connectPeer(sig, { to: offer.from, offer, rtc: RTCPeerConnection });
  connectPeer(sig, {
    to: offer.from,
    offer: offer.description,
    rtc: RTCPeerConnection,
  });
});

// Only a signalling channel.
declare const Say: StandardSchemaV1<{ text: string }>;
const chat = channel(
  api,
  channelContract({
    path: "/chat",
    receives: { say: Say },
    sends: { say: Say },
  }),
);
// @ts-expect-error a channel that is not a signalling one
connectPeer(chat, { to: "bob", rtc: RTCPeerConnection });
// @ts-expect-error `to` is required
connectPeer(sig, { rtc: RTCPeerConnection });
