/**
 * Two node-datachannel peers, connected for real: bun-common's
 * `signallingRelay` on port 0, this package's `channel()` and `connectPeer`,
 * and one data channel open between them. For `dataChannel.test.ts`.
 */
import type { RTCDataChannel } from "node-datachannel/polyfill";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { signallingRelay } from "@kingsleyweb/bun-common/webrtc";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { channel } from "../../lib/channel";
import { createClient } from "../../lib/index";
import { connectPeer } from "../../lib/webrtc";

/** The signalling contract the pair connects over. */
const signalling = signallingContract({ path: "/rtc/:room" });

/** A connected pair: the offering side's data channel, the answering side's, and the clean-up. */
export interface Pair {
  /** Alice's data channel (she created it). */
  readonly a: RTCDataChannel;
  /** Bob's (from his `datachannel` event). */
  readonly b: RTCDataChannel;
  /** Closes both peers, the signalling channels and the relay. */
  readonly close: () => Promise<void>;
}

/** Rejects after `ms` with `what`, else resolves with `run`. */
async function within<T>(
  what: string,
  ms: number,
  run: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what}: timed out after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once `dc` is open. */
function opened(dc: RTCDataChannel): Promise<void> {
  return dc.readyState === "open"
    ? Promise.resolve()
    : new Promise((resolve) => dc.addEventListener("open", () => resolve()));
}

/** Connects two peers and opens one data channel, `label`, with `init`: resolves once it is open on both sides. */
export async function connectedPair(
  label = "chat",
  init: { ordered?: boolean; maxRetransmits?: number } = {},
): Promise<Pair> {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.ws(...signallingRelay(signalling));
  const server = await adapter.listen(0);
  const api = createClient({ baseUrl: `http://127.0.0.1:${server.port}` });
  const aliceSig = channel(api, signalling, {
    params: { room: "r" },
    query: { as: "alice" },
  });
  const bobSig = channel(api, signalling, {
    params: { room: "r" },
    query: { as: "bob" },
  });
  await aliceSig.request("join", { peer: "alice" });
  await bobSig.request("join", { peer: "bob" });
  const peers: { close: () => void }[] = [];
  const bobChannel = new Promise<RTCDataChannel>((resolve) => {
    bobSig.on("offer", (offer) => {
      const peer = connectPeer(bobSig, {
        to: offer.from,
        offer,
        rtc: RTCPeerConnection,
      });
      peers.push(peer);
      peer.connection.addEventListener("datachannel", (event) =>
        resolve((event as unknown as { channel: RTCDataChannel }).channel),
      );
    });
  });
  const alice = connectPeer(aliceSig, { to: "bob", rtc: RTCPeerConnection });
  peers.push(alice);
  const a = alice.createDataChannel(label, init);
  const b = await within("bob's data channel", 15_000, bobChannel);
  await within("both open", 15_000, Promise.all([opened(a), opened(b)]));
  return {
    a,
    b,
    close: async () => {
      for (const peer of peers) peer.close();
      aliceSig.close();
      bobSig.close();
      await adapter.close();
    },
  };
}
