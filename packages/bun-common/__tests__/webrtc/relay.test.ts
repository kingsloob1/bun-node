/**
 * `signallingRelay` (lib/webrtc/relay.ts), served for real on port 0 with raw
 * WebSocket clients: `join` is answered with the room's other peers and
 * announced to them; an `offer`/`answer`/`candidate` reaches the peer it
 * names and no one else, as `{ from, … }` with the sender's joined name; a
 * frame for a peer in another room (or none, or itself, or before joining)
 * is refused with a value-free `VALIDATION` frame echoing its id; `leave`
 * and a close announce `leave`; a full room and a taken name refuse the
 * join; `authorize` runs before the upgrade. The contract half
 * (lib/webrtc/signalling.ts) is covered in `signalling.test.ts`.
 */
import type { SignallingRelayOptions } from "../../lib/webrtc";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { createTestLogger } from "../../lib/logging";
import { signallingContract, signallingRelay } from "../../lib/webrtc";

/** The contract every test serves. */
const signalling = signallingContract({ path: "/rtc/:room" });

/** A test SDP (any non-empty text: the relay never parses it). */
const SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

/** A connected raw client: its frames as parsed JSON, and a wait for the next one matching. */
interface Client {
  /** The socket. */
  socket: WebSocket;
  /** Every frame received, in order. */
  frames: Record<string, unknown>[];
  /** Sends one frame. */
  send: (frame: Record<string, unknown>) => void;
  /** Resolves with the first frame (from `from` on) for which `match` holds, or fails after 2 s. */
  next: (
    match: (frame: Record<string, unknown>) => boolean,
    from?: number,
  ) => Promise<Record<string, unknown>>;
}

/** Adapters to close after each test. */
const adapters: BunHttpAdapter[] = [];
/** Clients to close after each test. */
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const adapter of adapters.splice(0)) await adapter.close();
});

/** Serves a relay on an OS-assigned port; resolves with the base WebSocket URL. */
async function serve(options?: SignallingRelayOptions): Promise<string> {
  const { logger } = createTestLogger();
  const adapter = new BunHttpAdapter(0, { logger });
  adapter.ws(...signallingRelay(signalling, options));
  const server = await adapter.listen(0);
  adapters.push(adapter);
  return `ws://127.0.0.1:${server.port}`;
}

/** Opens a client on `url`. */
async function open(url: string): Promise<Client> {
  const socket = new WebSocket(url);
  clients.push(socket);
  const frames: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  socket.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error(`${url} failed to open`));
  });
  return {
    socket,
    frames,
    send: (frame) => socket.send(JSON.stringify(frame)),
    async next(match, from = 0) {
      const deadline = Date.now() + 2_000;
      for (;;) {
        const found = frames.slice(from).find(match);
        if (found !== undefined) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `no matching frame; received ${JSON.stringify(frames)}`,
          );
        }
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

/** Opens a client on `room` and joins it as `peer`; resolves with the client and the `peers` reply. */
async function joined(
  base: string,
  room: string,
  peer: string,
): Promise<{ client: Client; peers: unknown }> {
  const client = await open(`${base}/rtc/${room}`);
  client.send({ type: "join", id: `j-${peer}`, data: { peer } });
  const reply = await client.next((f) => f.id === `j-${peer}`);
  return { client, peers: reply };
}

/** Waits a little, for frames that must not arrive. */
const settle = (): Promise<void> => Bun.sleep(100);

describe("signallingRelay: rooms", () => {
  it("answers join with the room's other peers, and announces it to them", async () => {
    const base = await serve();
    const alice = await joined(base, "r1", "alice");
    expect(alice.peers).toEqual({
      type: "peers",
      id: "j-alice",
      data: { peers: [] },
    });
    const bob = await joined(base, "r1", "bob");
    expect(bob.peers).toEqual({
      type: "peers",
      id: "j-bob",
      data: { peers: ["alice"] },
    });
    expect(await alice.client.next((f) => f.type === "join")).toEqual({
      type: "join",
      data: { peer: "bob" },
    });
  });

  it("forwards an offer, an answer and a candidate only to the named peer, from the sender's joined name", async () => {
    const base = await serve();
    const alice = await joined(base, "r1", "alice");
    const bob = await joined(base, "r1", "bob");
    const carol = await joined(base, "r1", "carol");
    const carolSeen = carol.client.frames.length;
    alice.client.send({
      type: "offer",
      // `from` is not a field of a sent offer: dropped, never relayed.
      data: {
        to: "bob",
        from: "mallory",
        description: { type: "offer", sdp: SDP },
      },
    });
    expect(await bob.client.next((f) => f.type === "offer")).toEqual({
      type: "offer",
      data: { from: "alice", description: { type: "offer", sdp: SDP } },
    });
    bob.client.send({
      type: "answer",
      data: { to: "alice", description: { type: "answer", sdp: SDP } },
    });
    expect(await alice.client.next((f) => f.type === "answer")).toEqual({
      type: "answer",
      data: { from: "bob", description: { type: "answer", sdp: SDP } },
    });
    const candidate = {
      candidate: "candidate:1 1 UDP 2122317823 127.0.0.1 50000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    alice.client.send({ type: "candidate", data: { to: "bob", candidate } });
    expect(await bob.client.next((f) => f.type === "candidate")).toEqual({
      type: "candidate",
      data: { from: "alice", candidate },
    });
    await settle();
    // carol saw the joins after hers, nothing addressed to the others.
    expect(carol.client.frames.slice(carolSeen).map((f) => f.type)).toEqual([]);
  });

  it("refuses a frame for a peer in another room, and that peer receives nothing", async () => {
    const base = await serve();
    const alice = await joined(base, "r1", "alice");
    const bob = await joined(base, "r2", "bob");
    expect(bob.peers).toMatchObject({ data: { peers: [] } });
    const bobSeen = bob.client.frames.length;
    alice.client.send({
      type: "offer",
      id: "o1",
      data: { to: "bob", description: { type: "offer", sdp: SDP } },
    });
    expect(await alice.client.next((f) => f.type === "error")).toEqual({
      type: "error",
      id: "o1",
      code: "VALIDATION",
      status: 400,
      issues: [
        {
          target: "data",
          key: "offer",
          path: "to",
          message: "No such peer in this room",
        },
      ],
    });
    await settle();
    expect(bob.client.frames.slice(bobSeen)).toEqual([]);
  });

  it("refuses a frame before join, and one for the sender itself", async () => {
    const base = await serve();
    const lurker = await open(`${base}/rtc/r1`);
    await joined(base, "r1", "bob");
    lurker.send({
      type: "candidate",
      id: "c1",
      data: { to: "bob", candidate: { candidate: "" } },
    });
    expect(await lurker.next((f) => f.id === "c1")).toMatchObject({
      type: "error",
      code: "VALIDATION",
      issues: [{ path: "", message: "Join the room first" }],
    });
    const alice = await joined(base, "r1", "alice");
    alice.client.send({
      type: "offer",
      id: "o2",
      data: { to: "alice", description: { type: "offer", sdp: SDP } },
    });
    expect(await alice.client.next((f) => f.id === "o2")).toMatchObject({
      type: "error",
      issues: [{ path: "to", message: "No such peer in this room" }],
    });
  });

  it("refuses a taken name, a second join, and a join into a full room", async () => {
    const base = await serve({ maxPeersPerRoom: 2 });
    const alice = await joined(base, "r1", "alice");
    const again = await joined(base, "r1", "alice");
    expect(again.peers).toMatchObject({
      type: "error",
      code: "VALIDATION",
      issues: [{ path: "peer", message: "This name is taken in the room" }],
    });
    alice.client.send({ type: "join", id: "j2", data: { peer: "alice2" } });
    expect(await alice.client.next((f) => f.id === "j2")).toMatchObject({
      type: "error",
      issues: [{ message: "Already joined: send leave first" }],
    });
    await joined(base, "r1", "bob");
    const carol = await joined(base, "r1", "carol");
    expect(carol.peers).toMatchObject({
      type: "error",
      issues: [{ path: "", message: "The room is full (2 peers)" }],
    });
    // Another room is not full.
    expect((await joined(base, "r2", "carol")).peers).toMatchObject({
      type: "peers",
    });
  });

  it("announces leave on a leave frame and on a close, and a name may join again after", async () => {
    const base = await serve();
    const alice = await joined(base, "r1", "alice");
    const bob = await joined(base, "r1", "bob");
    const from = alice.client.frames.length;
    bob.client.send({ type: "leave" });
    expect(await alice.client.next((f) => f.type === "leave", from)).toEqual({
      type: "leave",
      data: { peer: "bob" },
    });
    bob.client.send({ type: "join", id: "again", data: { peer: "bob" } });
    expect(await bob.client.next((f) => f.id === "again")).toEqual({
      type: "peers",
      id: "again",
      data: { peers: ["alice"] },
    });
    const later = alice.client.frames.length;
    bob.client.socket.close();
    expect(await alice.client.next((f) => f.type === "leave", later)).toEqual({
      type: "leave",
      data: { peer: "bob" },
    });
    expect((await joined(base, "r1", "bob")).peers).toMatchObject({
      data: { peers: ["alice"] },
    });
  });
});

describe("signallingRelay: checks", () => {
  it("refuses an invalid frame and an undeclared type through the channel, value-free", async () => {
    const base = await serve();
    const alice = await joined(base, "r1", "alice");
    alice.client.send({
      type: "offer",
      id: "bad",
      data: { to: "bob", description: { type: "answer", sdp: "" } },
    });
    const refused = await alice.client.next((f) => f.id === "bad");
    expect(refused).toMatchObject({ type: "error", code: "VALIDATION" });
    expect(
      (refused.issues as { path: string }[]).map((i) => i.path).sort(),
    ).toEqual(["description.sdp", "description.type"]);
    expect(JSON.stringify(refused)).not.toContain("bob");
    alice.client.send({ type: "shout", id: "u", data: {} });
    expect(await alice.client.next((f) => f.id === "u")).toMatchObject({
      type: "error",
      code: "UNKNOWN_MESSAGE",
    });
  });

  it("runs authorize before the upgrade: a 401 refuses the socket, next() lets it through", async () => {
    const base = await serve({
      authorize: (req, res, next) => {
        if (req.query.token === "ok") return next();
        res.status(401).json({ error: "no" });
      },
    });
    await expect(open(`${base}/rtc/r1`)).rejects.toThrow("failed to open");
    const client = await open(`${base}/rtc/r1?token=ok`);
    client.send({ type: "join", id: "j", data: { peer: "a" } });
    expect(await client.next((f) => f.id === "j")).toMatchObject({
      type: "peers",
    });
  });

  it("throws on a maxPeersPerRoom that is not a whole number 1–1024", () => {
    for (const bad of [0, 1.5, 1_025, Number.NaN]) {
      expect(() =>
        signallingRelay(signalling, { maxPeersPerRoom: bad }),
      ).toThrow(TypeError);
    }
  });
});
