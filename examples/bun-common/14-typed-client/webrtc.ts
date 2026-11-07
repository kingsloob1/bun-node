/**
 * A typed WebRTC data channel, headless — two peers connect through bun-common's
 * `signallingRelay` (a typed WebSocket channel, no WebRTC on the server),
 * `connectPeer` runs the offer/answer/ICE exchange, and `typedDataChannel`
 * puts a channel contract over the data channel: typed, checked messages and
 * a request/reply, peer to peer. Each step is asserted.
 *
 * ```bash
 * bun 14-typed-client/webrtc.ts
 * ```
 *
 * - **Bun has no `RTCPeerConnection`.** The peers bring their own: here
 *   `node-datachannel/polyfill` (libdatachannel, a prebuilt binary), which
 *   is a dev dependency of `@kingsleyweb/bun-client` and reaches this folder
 *   through the root `node_modules`. Both peers run in this process and talk
 *   over loopback, so no STUN server is used. Where the library or its binary
 *   is missing, the example prints a `skipped:` line and exits 0; the
 *   signalling half (the relay's `peers` and `join` frames) is checked first,
 *   and needs no WebRTC at all.
 * - **The signalling contract** (`signallingContract`) is shared by the relay
 *   and by `channel()`; the peers' messages are the browser's shapes.
 * - **One socket is one peer**: `channel()` shares a socket per URL, so the two
 *   peers of one process open the signalling channel with different queries.
 * - **`typedDataChannel(dc, contract, { side })`**: between peers there is no
 *   server, so `side` says which end of the contract this peer plays. The
 *   `"client"` sends `receives` and may `request()` what `replies` maps; the
 *   `"server"` sends `sends` and answers with its listener's return value.
 */
import { createClient, ValidationError } from "@kingsleyweb/bun-client";
import { channel } from "@kingsleyweb/bun-client/channel";
import { connectPeer, typedDataChannel } from "@kingsleyweb/bun-client/webrtc";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { signallingContract } from "@kingsleyweb/bun-common/lib/webrtc/signalling";
import { signallingRelay } from "@kingsleyweb/bun-common/webrtc";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("A typed WebRTC data channel (headless)");

/** The signalling channel both peers and the relay share. */
const signalling = signallingContract({ path: "/rtc/:room" });

/** The data channel's contract: a name for a path, since a data channel has no route. */
const chat = channelContract({
  path: "/dc/chat",
  receives: {
    say: z.object({ text: z.string().min(1) }),
    ask: z.object({ q: z.string() }),
  },
  sends: {
    said: z.object({ by: z.string(), text: z.string() }),
    answer: z.object({ a: z.string() }),
  },
  replies: { ask: "answer" },
});

/* ------------------------------------------------------------------ */
step("The relay, and the typed signalling channel");

const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.ws(...signallingRelay(signalling));
const server = await adapter.listen(0);
const api = createClient({ baseUrl: `http://127.0.0.1:${server.port}` });

/** Opens the signalling channel as `peer` and joins `room`. */
const sigAs = (peer: string) =>
  channel(api, signalling, { params: { room: "lobby" }, query: { as: peer } });
const aliceSig = sigAs("alice");
const bobSig = sigAs("bob");

/** Everything to close at the end. */
const closers: (() => void)[] = [() => aliceSig.close(), () => bobSig.close()];

try {
  const first = await aliceSig.request("join", { peer: "alice" });
  checkEqual(
    "alice joins an empty room (the reply is `peers`)",
    first.peers,
    [],
  );
  const joined: string[] = [];
  aliceSig.on("join", (m) => void joined.push(m.peer));
  const second = await bobSig.request("join", { peer: "bob" });
  checkEqual("bob's `peers` names alice", second.peers, ["alice"]);
  await waitFor("alice to be told bob joined", () => joined.length === 1);
  checkEqual("alice is told, with a typed `join` push", joined, ["bob"]);

  /* ---------------------------------------------------------------- */
  const webrtc = await import("node-datachannel/polyfill").catch(
    () => undefined,
  );
  if (webrtc === undefined) {
    console.log(
      "skipped: node-datachannel is not installed here, so there is no RTCPeerConnection in Bun; the signalling half above ran",
    );
  } else {
    step("connectPeer: offer, answer and ICE over the relay");

    const { RTCPeerConnection } = webrtc;
    const errors: unknown[] = [];
    type Dc = ReturnType<
      InstanceType<typeof RTCPeerConnection>["createDataChannel"]
    >;

    // Bob answers whoever calls, and takes the data channel the offer carries.
    const bobChannel = new Promise<Dc>((resolve) => {
      bobSig.on("offer", (offer) => {
        const peer = connectPeer(bobSig, {
          to: offer.from,
          offer,
          rtc: RTCPeerConnection,
          onError: (error) => void errors.push(error),
          onCandidateError: (error) => void errors.push(error),
        });
        closers.push(() => peer.close());
        peer.connection.addEventListener("datachannel", (event) =>
          resolve((event as unknown as { channel: Dc }).channel),
        );
      });
    });
    // Alice offers once she has a data channel to offer.
    const alice = connectPeer(aliceSig, {
      to: "bob",
      rtc: RTCPeerConnection,
      onError: (error) => void errors.push(error),
    });
    closers.push(() => alice.close());
    const aliceDc = alice.createDataChannel("chat");
    const bobDc = await bobChannel;
    await waitFor(
      "both ends of the data channel to open",
      () => aliceDc.readyState === "open" && bobDc.readyState === "open",
    );
    checkEqual(
      "both ends are open",
      [aliceDc.readyState, bobDc.readyState],
      ["open", "open"],
    );
    checkEqual("and no signalling error was reported", errors, []);

    /* -------------------------------------------------------------- */
    step("typedDataChannel: typed messages and a request/reply, peer to peer");

    const a = typedDataChannel(aliceDc, chat, {
      side: "client",
      mode: "development",
    });
    const b = typedDataChannel(bobDc, chat, {
      side: "server",
      mode: "development",
    });

    const atBob: string[] = [];
    b.on("say", (data) => void atBob.push(data.text));
    // The listener of an answered type returns the answer (or a promise of it).
    b.on("ask", (data) => ({ a: `bob says: ${data.q.toUpperCase()}` }));
    const atAlice: string[] = [];
    a.on("said", (data) => void atAlice.push(`${data.by}: ${data.text}`));

    a.send("say", { text: "hello, bob" });
    await waitFor("bob to receive the message", () => atBob.length === 1);
    checkEqual("alice's message reached bob, typed", atBob, ["hello, bob"]);

    b.send("said", { by: "bob", text: "hello, alice" });
    await waitFor("alice to receive the push", () => atAlice.length === 1);
    checkEqual("bob's push reached alice", atAlice, ["bob: hello, alice"]);

    const answer = await a.request("ask", { q: "ready?" });
    show("the answer", answer);
    checkEqual("request() resolves bob's listener's return", answer, {
      a: "bob says: READY?",
    });

    let refused: unknown;
    try {
      a.send("say", { text: "" });
    } catch (error) {
      refused = error;
    }
    check(
      "a message failing the contract is refused before the wire",
      refused instanceof ValidationError,
      refused,
    );
    await Bun.sleep(50);
    checkEqual("and bob never saw it", atBob.length, 1);

    /* -------------------------------------------------------------- */
    step("The type-level half");

    const refusedByTypes = async (): Promise<void> => {
      // @ts-expect-error -- as the client side, alice cannot send what only the server sends
      a.send("said", { by: "a", text: "b" });
      // @ts-expect-error -- `say` is not in `replies`, so it cannot be requested
      await a.request("say", { text: "x" });
      // @ts-expect-error -- `ask`'s data is { q: string }
      await a.request("ask", { q: 1 });
      // @ts-expect-error -- as the server side, bob receives `say`; his listener's data has no `by`
      b.on("say", (data) => void data.by);
    };
    void refusedByTypes;
    show("four refusals at compile time (see the source)");
  }
} finally {
  for (const close of closers.reverse()) close();
  await adapter.close();
  // node-datachannel's native threads keep the process alive until cleaned up.
  const native = await import("node-datachannel").catch(() => undefined);
  native?.cleanup();
}

summary();
