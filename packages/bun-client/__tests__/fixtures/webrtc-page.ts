/**
 * The page `webrtc.e2e.test.ts` loads in Chrome: two in-page peers, alice and
 * bob, each on its own signalling channel to the relay that served the page
 * (`channel()` shares a socket per URL, so the query keeps them apart), both
 * on the browser's own `RTCPeerConnection` (connectPeer's default). Alice
 * offers with a data channel; bob answers, echoes what arrives. Then (PR-R2)
 * a second data channel, wrapped by `typedDataChannel` on both sides (alice
 * the contract's client, bob its server): a request bob's listener answers,
 * and a binary frame, which arrives as a `Uint8Array`. The outcome lands on
 * `globalThis.__webrtc` as a promise.
 */
import type { DataChannelLike } from "../../lib/webrtc";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { channelContract } from "@kingsleyweb/bun-contract";
import { z } from "zod/mini";
import { channel } from "../../lib/channel";
import { createClient } from "../../lib/index";
import { connectPeer, typedDataChannel } from "../../lib/webrtc";

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
  /** The typed request's reply (PR-R2). */
  typedReply?: unknown;
  /** The binary frame bob received: its constructor's name and bytes. */
  binary?: { kind: string; bytes: number[] };
  /** A failure, when the run threw. */
  error?: string;
}

const signalling = signallingContract({ path: "/rtc/:room" });

/** The typed data channel's contract (PR-R2). */
const ask = channelContract({
  path: "/dc/ask",
  receives: { ask: z.object({ q: z.string() }) },
  sends: { answer: z.object({ a: z.string() }) },
  replies: { ask: "answer" },
});

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

  let resolveBinary!: (value: { kind: string; bytes: number[] }) => void;
  const binary = new Promise<{ kind: string; bytes: number[] }>((resolve) => {
    resolveBinary = resolve;
  });
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
          ondatachannel: (event: {
            channel: PageChannel & DataChannelLike & { label: string };
          }) => void;
        }
      ).ondatachannel = (event) => {
        if (event.channel.label === "typed") {
          const typed = typedDataChannel(event.channel, ask, {
            side: "server",
            binary: { maxBytes: 16 },
          });
          typed.on("ask", (data) => ({ a: `re:${data.q}` }));
          typed.on("$binary", (bytes) => {
            resolveBinary({
              kind: bytes.constructor.name,
              bytes: [...bytes],
            });
          });
          return;
        }
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
  const atBobValue = await atBob;
  const replyValue = await reply;
  // PR-R2: a second channel, typed; sends before it opens wait for it.
  const typed = typedDataChannel(
    alice.createDataChannel("typed") as DataChannelLike,
    ask,
    { side: "client", binary: { maxBytes: 16 } },
  );
  const typedReply = await typed.request("ask", { q: "browser" });
  await typed.sendWhenReady("ask", { q: "no reply awaited" });
  typed.sendBinary(new Uint8Array([7, 8, 9]));
  return {
    atBob: atBobValue,
    reply: replyValue,
    typedReply,
    binary: await binary,
    errors,
    rtc: typeof (globalThis as { RTCPeerConnection?: unknown })
      .RTCPeerConnection,
  };
}

(globalThis as { __webrtc?: Promise<PageOutcome> }).__webrtc = run().catch(
  (error: unknown) => ({ errors: [], rtc: "", error: String(error) }),
);
