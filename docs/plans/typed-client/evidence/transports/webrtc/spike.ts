/**
 * WebRTC under Bun: can a Bun process be a WebRTC peer, and can the
 * signalling messages and the data-channel messages be typed and validated
 * with bun-common's contract core?
 *
 *   cd docs/plans/typed-client/evidence/transports && bun install
 *   bun webrtc/spike.ts                 # every pair
 *   bun webrtc/spike.ts ndc-ndc         # one pair: ndc-ndc | werift-werift | ndc-werift
 *
 * - Signalling: a real `BunHttpAdapter` serving a `defineChannel()` channel
 *   (offer / answer / candidate, zod schemas), relaying between two peers
 *   that connect with Bun's WebSocket client. Trickle ICE, host candidates
 *   only (no STUN server: both peers are on this machine).
 * - Peers: `node-datachannel` (libdatachannel, a prebuilt N-API binary; its
 *   W3C polyfill) and `werift` (pure TypeScript). Bun has no
 *   `RTCPeerConnection` of its own (checked first, below).
 * - Data channel: one reliable ordered channel carrying the channel envelope
 *   (`{ type, id?, data }`) as JSON text, checked with `createSender` /
 *   `createReceiver` from `@kingsleyweb/bun-common/contract` over a
 *   `channelContract()`; plus binary frames.
 */
import type { ServerWebSocket } from "bun";
import { BunHttpAdapter, defineChannel } from "@kingsleyweb/bun-common";
import type { WebSocketClientData } from "@kingsleyweb/bun-common";
import {
  channelContract,
  ContractError,
  createReceiver,
  createSender,
} from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

console.log(
  `bun ${Bun.version} (${Bun.revision.slice(0, 9)}), ${process.platform}-${process.arch}`,
);
console.log(
  `globalThis.RTCPeerConnection: ${typeof (globalThis as Record<string, unknown>).RTCPeerConnection}, RTCDataChannel: ${typeof (globalThis as Record<string, unknown>).RTCDataChannel}`,
);

/* ---------------------------------------------------------------- *
 * Signalling: a typed channel on the real adapter
 * ---------------------------------------------------------------- */

const Sdp = z.object({ type: z.enum(["offer", "answer"]), sdp: z.string().min(1) });
const Candidate = z.object({
  candidate: z.string(),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().nullable().optional(),
});

const signal = defineChannel({
  path: "/signal/:room",
  receives: {
    offer: z.object({ to: z.string(), description: Sdp }),
    answer: z.object({ to: z.string(), description: Sdp }),
    candidate: z.object({ to: z.string(), candidate: Candidate }),
  },
  sends: {
    offer: z.object({ from: z.string(), description: Sdp }),
    answer: z.object({ from: z.string(), description: Sdp }),
    candidate: z.object({ from: z.string(), candidate: Candidate }),
  },
  meta: { name: "signal", description: "WebRTC signalling, relayed" },
});

interface Session {
  /** The peer's name, from `?peer=`. */
  peer: string;
}
const sockets = new Map<string, ServerWebSocket<never>>();
const nameOf = (ws: ServerWebSocket<never>): string =>
  (ws.data as WebSocketClientData<Session>).custom.peer;

const adapter = new BunHttpAdapter<Session>(0);
adapter.webSocketAdapter.on("open", (ws) => {
  sockets.set(ws.data.custom.peer, ws as unknown as ServerWebSocket<never>);
});
let rejectedSignals = 0;
adapter.ws(
  signal.path,
  signal.checks(),
  signal.handler({
    offer(ws, m) {
      const to = sockets.get(m.to);
      if (to) signal.send(to, "offer", { from: nameOf(ws), description: m.description });
    },
    answer(ws, m) {
      const to = sockets.get(m.to);
      if (to) signal.send(to, "answer", { from: nameOf(ws), description: m.description });
    },
    candidate(ws, m) {
      const to = sockets.get(m.to);
      if (to) signal.send(to, "candidate", { from: nameOf(ws), candidate: m.candidate });
    },
  }),
  signal.options((req) => ({ custom: { peer: String(req.query.peer) } })),
);
await adapter.listen(0);
const wsBase = `${adapter.url.replace(/^http/, "ws")}/signal/room1`;

/** A signalling client: typed send, and the server's frames by type. */
async function signalling(peer: string) {
  const ws = new WebSocket(`${wsBase}?peer=${peer}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("signalling socket failed"));
  });
  const handlers = new Map<string, (data: never) => void>();
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as { type: string; data: never };
    if (frame.type === "error") rejectedSignals++;
    handlers.get(frame.type)?.(frame.data);
  };
  return {
    send(type: string, data: unknown): void {
      ws.send(JSON.stringify({ type, data }));
    },
    on(type: string, fn: (data: never) => void): void {
      handlers.set(type, fn);
    },
    close: () => ws.close(),
    raw: ws,
  };
}

/* ---------------------------------------------------------------- *
 * The data channel's contract: the channel envelope, both directions
 * ---------------------------------------------------------------- */

const Chat = z.object({ text: z.string().min(1).max(500), at: z.number().int() });
const dc = channelContract({
  path: "/dc/chat", // a name only: a data channel has no route
  receives: { chat: Chat, ping: z.object({ n: z.number().int() }) },
  sends: { chat: Chat, ping: z.object({ n: z.number().int() }) },
});
// A peer-to-peer channel is symmetric: what one peer sends, the other receives.
const sendGuard = createSender(dc.contract, "inbound");
const receiveGuard = createReceiver(dc.contract, "inbound");

/* ---------------------------------------------------------------- *
 * Peers
 * ---------------------------------------------------------------- */

type Lib = "ndc" | "werift";

/** The W3C surface both libraries offer, as far as the spike uses it. */
interface PeerLike {
  createDataChannel(label: string): ChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d: unknown): Promise<unknown>;
  setRemoteDescription(d: unknown): Promise<unknown>;
  addIceCandidate(c: unknown): Promise<unknown>;
  localDescription: { type: string; sdp: string } | null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null;
  ondatachannel: ((e: { channel: ChannelLike }) => void) | null;
  close(): void | Promise<void>;
}
interface ChannelLike {
  binaryType?: string;
  readyState: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

async function makePeer(lib: Lib): Promise<PeerLike> {
  if (lib === "ndc") {
    const { RTCPeerConnection } = await import("node-datachannel/polyfill");
    return new RTCPeerConnection({ iceServers: [] }) as unknown as PeerLike;
  }
  const { RTCPeerConnection } = await import("werift");
  return new RTCPeerConnection({ iceServers: [] }) as unknown as PeerLike;
}

function candidateJson(c: unknown): z.infer<typeof Candidate> | undefined {
  if (c === null || c === undefined) return undefined;
  const x = (typeof (c as { toJSON?: () => unknown }).toJSON === "function"
    ? (c as { toJSON: () => unknown }).toJSON()
    : c) as { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null };
  if (!x.candidate) return undefined;
  return { candidate: x.candidate, sdpMid: x.sdpMid ?? null, sdpMLineIndex: x.sdpMLineIndex ?? null };
}

async function pair(a: Lib, b: Lib) {
  const name = `${a}-${b}`;
  const t0 = performance.now();
  const sigA = await signalling(`${name}-A`);
  const sigB = await signalling(`${name}-B`);
  const pa = await makePeer(a);
  const pb = await makePeer(b);

  pa.onicecandidate = (e) => {
    const c = candidateJson(e.candidate);
    if (c) sigA.send("candidate", { to: `${name}-B`, candidate: c });
  };
  pb.onicecandidate = (e) => {
    const c = candidateJson(e.candidate);
    if (c) sigB.send("candidate", { to: `${name}-A`, candidate: c });
  };
  // Trickle ICE: a candidate can arrive before the remote description it
  // belongs to (measured: libdatachannel throws "Got a remote candidate
  // without remote description"), so each side queues until it has one.
  const candidateErrors: string[] = [];
  const queueing = (peer: PeerLike) => {
    let ready = false;
    const queue: unknown[] = [];
    const add = (c: unknown) =>
      peer.addIceCandidate(c).catch((e: Error) => candidateErrors.push(e.message));
    return {
      take: (c: unknown) => (ready ? void add(c) : void queue.push(c)),
      ready: () => {
        ready = true;
        for (const c of queue.splice(0)) void add(c);
      },
    };
  };
  const qa = queueing(pa);
  const qb = queueing(pb);
  sigA.on("candidate", (m: { candidate: unknown }) => qa.take(m.candidate));
  sigB.on("candidate", (m: { candidate: unknown }) => qb.take(m.candidate));

  const received: unknown[] = [];
  const rejected: string[] = [];
  const binaries: string[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let expect = 0;

  const bOpen = new Promise<ChannelLike>((resolve) => {
    pb.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = "arraybuffer";
      ch.onmessage = async (ev) => {
        if (typeof ev.data !== "string") {
          const d = ev.data as ArrayBuffer | Uint8Array;
          binaries.push(`${Object.prototype.toString.call(d)}:${d.byteLength}`);
          return;
        }
        const verdict = await receiveGuard(JSON.parse(ev.data));
        if (verdict instanceof ContractError) rejected.push(verdict.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
        else received.push(verdict);
        if (received.length + rejected.length >= expect) resolveDone();
      };
      if (ch.readyState === "open") resolve(ch);
      else ch.onopen = () => resolve(ch);
    };
  });

  const chA = pa.createDataChannel("chat");
  const aOpen = new Promise<void>((resolve) => {
    chA.onopen = () => resolve();
  });

  sigB.on("offer", async (m: { description: unknown }) => {
    await pb.setRemoteDescription(m.description);
    qb.ready();
    const answer = await pb.createAnswer();
    await pb.setLocalDescription(answer);
    const local = pb.localDescription ?? answer;
    sigB.send("answer", { to: `${name}-A`, description: { type: "answer", sdp: local.sdp } });
  });
  sigA.on("answer", async (m: { description: unknown }) => {
    await pa.setRemoteDescription(m.description);
    qa.ready();
  });

  const offer = await pa.createOffer();
  await pa.setLocalDescription(offer);
  const local = pa.localDescription ?? offer;
  sigA.send("offer", { to: `${name}-B`, description: { type: "offer", sdp: local.sdp } });

  const timeout = (ms: number, what: string) =>
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms));
  await Promise.race([Promise.all([aOpen, bOpen]), timeout(15_000, `${name} open`)]);
  const openMs = performance.now() - t0;

  // 1000 checked messages, one invalid, one undeclared type; then a binary frame.
  const N = 1000;
  expect = N + 2;
  const t1 = performance.now();
  for (let i = 0; i < N; i++) {
    const msg = { type: "chat" as const, data: { text: `hello ${i}`, at: i } };
    const ok = await sendGuard(msg);
    if (ok instanceof ContractError) throw ok;
    chA.send(JSON.stringify(ok));
  }
  // What a sender guard refuses never reaches the wire; send these raw, as a
  // peer without the guard (or a hostile one) would.
  chA.send(JSON.stringify({ type: "chat", data: { text: "", at: 1.5 } }));
  chA.send(JSON.stringify({ type: "shout", data: {} }));
  await Promise.race([done, timeout(15_000, `${name} messages`)]);
  const msgMs = performance.now() - t1;
  chA.send(new Uint8Array([1, 2, 3, 4, 5]));
  await Bun.sleep(200);

  const senderRefuses = (await sendGuard({ type: "chat", data: { text: "", at: 0 } } as never)) instanceof ContractError;

  console.log(
    `${name.padEnd(14)} open ${openMs.toFixed(0).padStart(5)} ms | ${N} checked msgs ${msgMs.toFixed(0).padStart(4)} ms ` +
      `| received ${received.length}, rejected ${rejected.length} [${rejected.join(" | ")}] ` +
      `| sender guard refuses bad: ${senderRefuses} | binary: ${binaries.join(",") || "none"}` +
      ` | candidates refused: ${candidateErrors.length}${candidateErrors.length ? ` (${[...new Set(candidateErrors)].join("; ")})` : ""}`,
  );
  chA.close();
  await pa.close();
  await pb.close();
  sigA.close();
  sigB.close();
}

const only = process.argv[2];
const pairs: [Lib, Lib][] = [
  ["ndc", "ndc"],
  ["werift", "werift"],
  ["ndc", "werift"],
];
for (const [a, b] of pairs) {
  if (only && only !== `${a}-${b}`) continue;
  try {
    await pair(a, b);
  } catch (error) {
    console.log(`${a}-${b}`.padEnd(14), "FAILED:", (error as Error).message);
  }
}
console.log(`signalling frames rejected by the channel: ${rejectedSignals}`);
await adapter.close();
process.exit(0);
