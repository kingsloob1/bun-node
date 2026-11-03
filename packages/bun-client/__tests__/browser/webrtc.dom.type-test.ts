/**
 * Compile-time assertions for `./webrtc` under the DOM lib, no Bun types
 * (PR-R1): the browser's own `RTCPeerConnection` is what `connectPeer` takes
 * as `rtc` and defaults to, and `peer.createDataChannel` is the browser's,
 * returning an `RTCDataChannel`. Checked by this directory's project (`bun
 * run check`, `scripts/typecheck.ts`).
 */
import type { ChannelClient } from "../../lib/channel";
import type { SignallingEntry } from "../../lib/webrtc";
import { connectPeer } from "../../lib/webrtc";

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
