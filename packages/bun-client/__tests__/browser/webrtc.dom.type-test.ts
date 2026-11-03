/**
 * Compile-time assertions for `./webrtc` under the DOM lib, no Bun types
 * (PR-R1): the browser's own `RTCPeerConnection` is what `connectPeer` takes
 * as `rtc` and defaults to, and `peer.createDataChannel` is the browser's,
 * returning an `RTCDataChannel`, which `typedDataChannel` takes (PR-R2). Checked by this directory's project (`bun
 * run check`, `scripts/typecheck.ts`).
 */
import type { ChannelClient } from "../../lib/channel";
import type { SignallingEntry } from "../../lib/webrtc";
import { channelContract } from "@kingsleyweb/bun-contract";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-contract";
import { connectPeer, typedDataChannel } from "../../lib/webrtc";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

declare const sig: ChannelClient<SignallingEntry>;

const peer = connectPeer(sig, { to: "bob", rtc: RTCPeerConnection });
export type _connection = Expect<
  Equal<typeof peer.connection, RTCPeerConnection>
>;
export const dc = peer.createDataChannel("chat", { ordered: false });
export type _dc = Expect<Equal<typeof dc, RTCDataChannel>>;

declare const Say: StandardSchemaV1<{ text: string }>;
const chat = channelContract({
  path: "/dc/chat",
  receives: { say: Say },
  sends: { say: Say },
});
export const typed = typedDataChannel(dc, chat, { side: "client" });
typed.send("say", { text: "hi" });
