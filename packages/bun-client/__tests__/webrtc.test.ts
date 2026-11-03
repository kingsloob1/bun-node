/**
 * `connectPeer` (lib/webrtc.ts, PR-R1), two ways:
 *
 * - **Real peers**: node-datachannel's `RTCPeerConnection` polyfill (a
 *   devDependency of this package only) on both sides, signalling through
 *   bun-common's `signallingRelay` on port 0 and this package's `channel()`:
 *   the pair connects and a data channel carries a message each way; a
 *   candidate the remote stack refuses is reported and not fatal.
 * - **A scripted connection** (`FakePeer`), for what a real stack makes a
 *   race of: remote candidates are added only once `setRemoteDescription`
 *   has resolved, local ones sent only once this side's description has
 *   gone out; only `to`'s frames are taken; glare is reported; `close()`
 *   stops everything.
 */
import type { BunHttpAdapter as Adapter } from "@kingsleyweb/bun-common";
import type {
  IceCandidateInit,
  PeerConnectionLike,
  SessionDescriptionInit,
} from "../lib/webrtc";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { signallingRelay } from "@kingsleyweb/bun-common/webrtc";
import { cleanup } from "node-datachannel";
import type { RTCDataChannel } from "node-datachannel/polyfill";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { channel } from "../lib/channel";
import { createClient } from "../lib/index";
import { connectPeer } from "../lib/webrtc";

/** The shared, browser-safe contract: what both peers' modules import. */
const signalling = signallingContract({ path: "/rtc/:room" });

/** Servers and channels to close after each test. */
const adapters: Adapter[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) close();
  for (const adapter of adapters.splice(0)) await adapter.close();
});

// node-datachannel's native threads keep the process alive until cleaned up.
afterAll(() => cleanup());

/** Serves a relay on an OS-assigned port; resolves with a client for it. */
async function serve() {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.ws(...signallingRelay(signalling));
  const server = await adapter.listen(0);
  adapters.push(adapter);
  return createClient({ baseUrl: `http://127.0.0.1:${server.port}` });
}

/** Opens the signalling channel on `room` and joins it as `peer`. */
async function join(
  api: ReturnType<typeof createClient>,
  room: string,
  peer: string,
) {
  // One socket is one peer, and channel() shares a socket per URL: the
  // query keeps two peers of one process apart.
  const sig = channel(api, signalling, {
    params: { room },
    query: { as: peer },
  });
  closers.push(() => sig.close());
  await sig.request("join", { peer });
  return sig;
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

/** A data channel of node-datachannel's polyfill. */
type Dc = RTCDataChannel;

/** The data channel a `datachannel` event carries. */
const channelOf = (event: Event): Dc =>
  (event as unknown as { channel: Dc }).channel;

/** Resolves once `dc` is open. */
function opened(dc: Dc): Promise<void> {
  return dc.readyState === "open"
    ? Promise.resolve()
    : new Promise((resolve) => dc.addEventListener("open", () => resolve()));
}

/** Resolves with the next text message on `dc`. */
function nextMessage(dc: Dc): Promise<string> {
  return new Promise((resolve) =>
    dc.addEventListener("message", (event) =>
      resolve(String((event as MessageEvent).data)),
    ),
  );
}

describe("connectPeer between two node-datachannel peers over the relay", () => {
  it("connects: the offer, the answer and trickled candidates, then a data channel both ways", async () => {
    const api = await serve();
    const aliceSig = await join(api, "r1", "alice");
    const bobSig = await join(api, "r1", "bob");
    const errors: unknown[] = [];

    const bobChannel = new Promise<Dc>((resolve) => {
      bobSig.on("offer", (offer) => {
        const peer = connectPeer(bobSig, {
          to: offer.from,
          offer,
          rtc: RTCPeerConnection,
          onError: (error) => errors.push(error),
          onCandidateError: (error) => errors.push(error),
        });
        closers.push(() => peer.close());
        peer.connection.addEventListener("datachannel", (event) =>
          resolve(channelOf(event)),
        );
      });
    });
    const alice = connectPeer(aliceSig, {
      to: "bob",
      rtc: RTCPeerConnection,
      onError: (error) => errors.push(error),
      onCandidateError: (error) => errors.push(error),
    });
    closers.push(() => alice.close());
    const aliceChannel = alice.createDataChannel("chat");

    const bob = await within("bob's data channel", 15_000, bobChannel);
    await within(
      "both open",
      15_000,
      Promise.all([opened(aliceChannel), opened(bob)]),
    );
    expect(bob.label).toBe("chat");
    const atBob = nextMessage(bob);
    aliceChannel.send("hello bob");
    expect(await within("alice → bob", 5_000, atBob)).toBe("hello bob");
    const atAlice = nextMessage(aliceChannel);
    bob.send("hello alice");
    expect(await within("bob → alice", 5_000, atAlice)).toBe("hello alice");
    expect(errors).toEqual([]);
  }, 30_000);

  it("queues the candidates that arrive while the remote description is set (libdatachannel refuses them otherwise)", async () => {
    const api = await serve();
    const aliceSig = await join(api, "r1", "alice");
    const bobSig = await join(api, "r1", "bob");
    const refused: string[] = [];
    // An answerer slow to apply the offer: alice's trickled candidates
    // arrive meanwhile, as the spike saw (webrtc.md §2).
    class SlowPeer extends RTCPeerConnection {
      override async setRemoteDescription(
        description: Parameters<RTCPeerConnection["setRemoteDescription"]>[0],
      ): Promise<void> {
        await Bun.sleep(300);
        return super.setRemoteDescription(description);
      }
    }
    const bobChannel = new Promise<Dc>((resolve) => {
      bobSig.on("offer", (offer) => {
        const peer = connectPeer(bobSig, {
          to: offer.from,
          offer,
          rtc: SlowPeer,
          onCandidateError: (error) => refused.push(String(error)),
        });
        closers.push(() => peer.close());
        peer.connection.addEventListener("datachannel", (event) =>
          resolve(channelOf(event)),
        );
      });
    });
    let trickled = 0;
    bobSig.on("candidate", () => trickled++);
    const alice = connectPeer(aliceSig, { to: "bob", rtc: RTCPeerConnection });
    closers.push(() => alice.close());
    const aliceChannel = alice.createDataChannel("chat");
    const bob = await within("bob's data channel", 15_000, bobChannel);
    await within(
      "both open",
      15_000,
      Promise.all([opened(aliceChannel), opened(bob)]),
    );
    expect(trickled).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  }, 30_000);

  it("reports a candidate the remote stack refuses, and connects on the rest", async () => {
    const api = await serve();
    const aliceSig = await join(api, "r1", "alice");
    const bobSig = await join(api, "r1", "bob");
    const refused: { error: unknown; candidate: IceCandidateInit }[] = [];
    const bobChannel = new Promise<Dc>((resolve) => {
      bobSig.on("offer", (offer) => {
        const peer = connectPeer(bobSig, {
          to: offer.from,
          offer,
          rtc: RTCPeerConnection,
          onCandidateError: (error, candidate) =>
            refused.push({ error, candidate }),
        });
        closers.push(() => peer.close());
        peer.connection.addEventListener("datachannel", (event) =>
          resolve(channelOf(event)),
        );
        // A candidate libdatachannel cannot parse, as another stack's might
        // be (webrtc.md §2: werift's, 5 a run), sent once bob has answered.
        aliceSig.send("candidate", {
          to: "bob",
          candidate: { candidate: "candidate:garbage", sdpMid: "0" },
        });
      });
    });
    const alice = connectPeer(aliceSig, { to: "bob", rtc: RTCPeerConnection });
    closers.push(() => alice.close());
    const aliceChannel = alice.createDataChannel("chat");
    const bob = await within("bob's data channel", 15_000, bobChannel);
    await within(
      "both open",
      15_000,
      Promise.all([opened(aliceChannel), opened(bob)]),
    );
    expect(refused.map((r) => r.candidate.candidate)).toEqual([
      "candidate:garbage",
    ]);
    expect(String(refused[0]?.error)).toContain("candidate");
  }, 30_000);
});

/* ------------------------------------------------------------------------ */
/* A scripted connection                                                     */
/* ------------------------------------------------------------------------ */

/** A deferred promise. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An `RTCPeerConnection` whose descriptions resolve when the test says, recording every call. */
class FakePeer extends EventTarget implements PeerConnectionLike {
  /** The configurations constructed with, by every instance. */
  static configurations: Record<string, unknown>[] = [];
  /** Every call, in order (`addIceCandidate:<line>`, `setRemoteDescription:<type>`, …). */
  readonly calls: string[] = [];
  /** Resolves the pending `setRemoteDescription`. */
  remote = deferred();
  /** Lines `addIceCandidate` refuses. */
  readonly refuse = new Set<string>();
  localDescription: SessionDescriptionInit | null = null;
  constructor(configuration: Record<string, unknown>) {
    super();
    FakePeer.configurations.push(configuration);
  }
  async createOffer(): Promise<SessionDescriptionInit> {
    this.calls.push("createOffer");
    return { type: "offer", sdp: "offer-sdp" };
  }
  async createAnswer(): Promise<SessionDescriptionInit> {
    this.calls.push("createAnswer");
    return { type: "answer", sdp: "answer-sdp" };
  }
  async setLocalDescription(description: SessionDescriptionInit) {
    this.calls.push(`setLocalDescription:${description.type}`);
    this.localDescription = description;
  }
  async setRemoteDescription(description: SessionDescriptionInit) {
    this.calls.push(`setRemoteDescription:${description.type}`);
    await this.remote.promise;
  }
  async addIceCandidate(candidate: IceCandidateInit) {
    this.calls.push(`addIceCandidate:${candidate.candidate}`);
    if (this.refuse.has(candidate.candidate)) throw new Error("refused");
  }
  createDataChannel(label: string): { label: string } {
    this.calls.push(`createDataChannel:${label}`);
    this.dispatchEvent(new Event("negotiationneeded"));
    return { label };
  }
  close() {
    this.calls.push("close");
  }
  /** Fires a gathered local candidate. */
  gather(line: string | null) {
    const event = new Event("icecandidate") as Event & { candidate: unknown };
    event.candidate =
      line === null
        ? null
        : {
            candidate: line,
            sdpMid: "0",
            sdpMLineIndex: 0,
            toJSON() {
              return { candidate: line, sdpMid: "0", sdpMLineIndex: 0 };
            },
          };
    this.dispatchEvent(event);
  }
}

/** A signalling channel stub: records sends, and delivers frames to the listeners. */
function stubChannel() {
  const sent: { type: string; data: unknown }[] = [];
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const sig = {
    send: (type: string, data: unknown) => sent.push({ type, data }),
    on: (type: string, listener: (data: unknown) => void) => {
      let set = listeners.get(type);
      if (set === undefined) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
  };
  const deliver = (type: string, data: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(data);
  };
  return {
    sig: sig as unknown as Parameters<typeof connectPeer>[0],
    sent,
    deliver,
    listeners,
  };
}

/** Lets queued promise jobs run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("connectPeer, scripted", () => {
  it("answers an offer, adding remote candidates only once the remote description is set", async () => {
    const { sig, sent, deliver } = stubChannel();
    const peer = connectPeer(sig, {
      to: "alice",
      offer: { description: { type: "offer", sdp: "o" } },
      rtc: FakePeer,
    });
    const fake = peer.connection;
    deliver("candidate", { from: "alice", candidate: { candidate: "c1" } });
    deliver("candidate", { from: "carol", candidate: { candidate: "x" } });
    fake.gather("local-1");
    await flush();
    // Still waiting on setRemoteDescription: nothing added, nothing sent.
    expect(fake.calls).toEqual(["setRemoteDescription:offer"]);
    expect(sent).toEqual([]);
    fake.remote.resolve();
    await flush();
    deliver("candidate", { from: "alice", candidate: { candidate: "c2" } });
    fake.gather("local-2");
    fake.gather(null);
    await flush();
    expect(fake.calls).toEqual([
      "setRemoteDescription:offer",
      "addIceCandidate:c1",
      "createAnswer",
      "setLocalDescription:answer",
      "addIceCandidate:c2",
    ]);
    // The answer first, then the candidates gathered before it, then the rest.
    expect(sent).toEqual([
      {
        type: "answer",
        data: {
          to: "alice",
          description: { type: "answer", sdp: "answer-sdp" },
        },
      },
      {
        type: "candidate",
        data: {
          to: "alice",
          candidate: { candidate: "local-1", sdpMid: "0", sdpMLineIndex: 0 },
        },
      },
      {
        type: "candidate",
        data: {
          to: "alice",
          candidate: { candidate: "local-2", sdpMid: "0", sdpMLineIndex: 0 },
        },
      },
    ]);
    peer.close();
  });

  it("offers on negotiationneeded, applies only its peer's answer, and passes the configuration", async () => {
    const { sig, sent, deliver } = stubChannel();
    FakePeer.configurations = [];
    const peer = connectPeer(sig, {
      to: "bob",
      rtc: FakePeer,
      iceServers: [{ urls: "stun:stun.example:3478" }],
      configuration: { iceTransportPolicy: "relay" },
    });
    expect(FakePeer.configurations).toEqual([
      {
        iceTransportPolicy: "relay",
        iceServers: [{ urls: "stun:stun.example:3478" }],
      },
    ]);
    peer.connection.gather("early");
    peer.createDataChannel("chat");
    await flush();
    expect(sent).toEqual([
      {
        type: "offer",
        data: { to: "bob", description: { type: "offer", sdp: "offer-sdp" } },
      },
      {
        type: "candidate",
        data: {
          to: "bob",
          candidate: { candidate: "early", sdpMid: "0", sdpMLineIndex: 0 },
        },
      },
    ]);
    deliver("answer", {
      from: "carol",
      description: { type: "answer", sdp: "x" },
    });
    deliver("answer", {
      from: "bob",
      description: { type: "answer", sdp: "a" },
    });
    deliver("answer", {
      from: "bob",
      description: { type: "answer", sdp: "again" },
    });
    peer.connection.remote.resolve();
    await flush();
    expect(
      peer.connection.calls.filter((c) => c.startsWith("setRemote")),
    ).toEqual(["setRemoteDescription:answer"]);
    peer.close();
  });

  it("reports a refused candidate to onCandidateError and goes on", async () => {
    const { sig, deliver } = stubChannel();
    const refused: string[] = [];
    const { connection: fake } = connectPeer(sig, {
      to: "alice",
      offer: { type: "offer", sdp: "o" },
      rtc: class extends FakePeer {
        constructor(c: Record<string, unknown>) {
          super(c);
          this.refuse.add("bad");
          this.remote.resolve();
        }
      },
      onCandidateError: (_error, candidate) =>
        refused.push(candidate.candidate),
    });
    await flush();
    deliver("candidate", { from: "alice", candidate: { candidate: "bad" } });
    deliver("candidate", { from: "alice", candidate: { candidate: "good" } });
    await flush();
    expect(refused).toEqual(["bad"]);
    expect(fake.calls).toContain("addIceCandidate:good");
  });

  it("reports glare: an offer while its own waits for the answer is ignored", async () => {
    const { sig, sent, deliver } = stubChannel();
    const errors: unknown[] = [];
    const peer = connectPeer(sig, {
      to: "bob",
      rtc: FakePeer,
      onError: (error) => errors.push(error),
    });
    peer.createDataChannel("chat");
    await flush();
    deliver("offer", { from: "bob", description: { type: "offer", sdp: "b" } });
    await flush();
    expect(String(errors[0])).toContain("glare");
    expect(sent.map((s) => s.type)).toEqual(["offer"]);
  });

  it("answers the given offer once when opened from the channel's own offer listener", async () => {
    const { sig, sent, deliver } = stubChannel();
    let peer: ReturnType<typeof connectPeer> | undefined;
    sig.on("offer", (offer) => {
      peer ??= connectPeer(sig, {
        to: offer.from,
        offer,
        rtc: class extends FakePeer {
          constructor(c: Record<string, unknown>) {
            super(c);
            this.remote.resolve();
          }
        },
      });
    });
    // The stub, like the channel, calls a listener added while it dispatches.
    deliver("offer", {
      from: "alice",
      description: { type: "offer", sdp: "o" },
    });
    await flush();
    expect(sent.map((s) => s.type)).toEqual(["answer"]);
    peer?.close();
  });

  it("close() stops listening and closes the connection", async () => {
    const { sig, sent, deliver, listeners } = stubChannel();
    const peer = connectPeer(sig, { to: "bob", rtc: FakePeer });
    peer.close();
    peer.close();
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    peer.createDataChannel("late");
    deliver("answer", {
      from: "bob",
      description: { type: "answer", sdp: "a" },
    });
    await flush();
    expect(sent).toEqual([]);
    expect(peer.connection.calls.filter((c) => c === "close")).toEqual([
      "close",
    ]);
  });

  it("throws a TypeError without rtc where the runtime has no RTCPeerConnection (Bun)", () => {
    const { sig } = stubChannel();
    expect(
      (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection,
    ).toBeUndefined();
    expect(() => connectPeer(sig, { to: "bob" })).toThrow(TypeError);
  });
});
