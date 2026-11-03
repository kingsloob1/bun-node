/**
 * The page `webrtc.e2e.test.ts` loads in Chrome: two in-page peers, alice and
 * bob, each on its own signalling channel to the relay that served the page
 * (`channel()` shares a socket per URL, so the query keeps them apart), both
 * on the browser's own `RTCPeerConnection` (connectPeer's default). Alice
 * offers with a data channel; bob answers, echoes what arrives. The outcome
 * lands on `globalThis.__webrtc` as a promise.
 */
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { channel } from "../../lib/channel";
import { createClient } from "../../lib/index";
import { connectPeer } from "../../lib/webrtc";

/** The data channel surface the page uses (the browser's `RTCDataChannel`). */
interface PageChannel {
  /** Sends text. */
  send: (data: string) => void;
  /** The message handler. */
  onmessage: ((event: { data: unknown }) => void) | null;
  /** The open handler. */
  onopen: (() => void) | null;
}

/** What the page reports. */
export interface PageOutcome {
  /** What bob received. */
  atBob?: unknown;
  /** What alice got back. */
  reply?: unknown;
  /** The negotiation's errors and refused candidates. */
  errors: string[];
  /** `typeof RTCPeerConnection` in the page. */
  rtc: string;
  /** A failure, when the run threw. */
  error?: string;
}

const signalling = signallingContract({ path: "/rtc/:room" });

/** Runs the two peers. */
async function run(): Promise<PageOutcome> {
  const errors: string[] = [];
  const report = (error: unknown): void => {
    errors.push(String(error));
  };
  const origin = (globalThis as unknown as { location: { origin: string } })
    .location.origin;
  const api = createClient({ baseUrl: origin });
  const a = channel(api, signalling, {
    params: { room: "page" },
    query: { as: "alice" },
  });
  const b = channel(api, signalling, {
    params: { room: "page" },
    query: { as: "bob" },
  });
  await a.request("join", { peer: "alice" });
  await b.request("join", { peer: "bob" });

  const atBob = new Promise<unknown>((resolve) => {
    b.on("offer", (offer) => {
      const peer = connectPeer(b, {
        to: offer.from,
        offer,
        onError: report,
        onCandidateError: report,
      });
      (
        peer.connection as unknown as {
          ondatachannel: (event: { channel: PageChannel }) => void;
        }
      ).ondatachannel = (event) => {
        event.channel.onmessage = (message) => {
          event.channel.send(`echo:${String(message.data)}`);
          resolve(message.data);
        };
      };
    });
  });
  const alice = connectPeer(a, {
    to: "bob",
    onError: report,
    onCandidateError: report,
  });
  const dc = alice.createDataChannel("chat") as PageChannel;
  const reply = new Promise<unknown>((resolve) => {
    dc.onmessage = (message) => resolve(message.data);
  });
  dc.onopen = () => dc.send("ping");
  return {
    atBob: await atBob,
    reply: await reply,
    errors,
    rtc: typeof (globalThis as { RTCPeerConnection?: unknown })
      .RTCPeerConnection,
  };
}

(globalThis as { __webrtc?: Promise<PageOutcome> }).__webrtc = run().catch(
  (error: unknown) => ({ errors: [], rtc: "", error: String(error) }),
);
