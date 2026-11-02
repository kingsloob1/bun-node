# Typed client: WebRTC, what can be typed and what cannot

A sub-plan of [`README.md`](README.md) (**TC**). The user asked for "auto
typings, validation for all kind of request. Http, websocket, webrtc, …".
This document says honestly what of WebRTC a typed client can type, what Bun
supports, and the smallest useful scope.

Written 2026-11-02 against `develop` at `e80ab379`. **No product code was
changed.** Markings as in TC. Evidence:
[`evidence/transports/webrtc/`](evidence/transports/README.md) (`bun
webrtc/spike.ts`, results in `webrtc/results.txt`).

**Status (2026-11-02): approved by the user** (TC §14, Q23–Q24; names as in
TC §16). **Nothing is built.** The next PRs are TC's **PR-K**,
**PR-M1** and **PR-C1**; this sub-plan's PRs follow them as TC §15 orders.

---

## 1. Summary

WebRTC has three layers, and only two of them carry data a schema can
describe:

| Layer | What travels | Typable? | Where it runs |
|---|---|---|---|
| **Signalling** (offer, answer, ICE candidates, join/leave) | JSON messages over a channel the app chooses: usually a WebSocket, sometimes HTTP | **Yes**: it is an ordinary typed channel ([`websocket.md`](websocket.md)) | the server (any Bun app) and each peer |
| **Data channels** (`RTCDataChannel`) | text or binary messages between peers, reliable or not, ordered or not | **Yes** for JSON messages (the channel envelope and its guards); **the frame kind and size only** for binary | peers only |
| **Media tracks** (audio, video) | RTP-encoded media | **No**: there is no message to validate; what can be typed is the *metadata about* tracks, sent over signalling (`{ kind, mid, label }`) | peers only |

**Bun has no WebRTC of its own**, so a Bun process is a peer only through a
library. Measured on Bun 1.4.4-canary.1+11c367163 [M,
`webrtc/results.txt`]: `typeof RTCPeerConnection` and `typeof RTCDataChannel`
are `"undefined"`; two libraries work as peers (§2).

**The smallest useful scope** [D]: (1) a ready-made, typed **signalling
contract** and its relay for bun-common, which needs no WebRTC on the server
at all; (2) a **typed data-channel wrapper** in the client that puts the
channel envelope, its guards and real backpressure over any
`RTCDataChannel`-shaped object (a browser's, or a Bun library's). No media,
no SFU or TURN, and no WebRTC dependency in any published package.

---

## 2. Bun and WebRTC today

- **No native API.** Bun exposes neither `RTCPeerConnection` nor
  `RTCDataChannel` [M]. Bun's roadmap issue has a request for data channels,
  with no plan attached (oven-sh/bun#159) [V]; an older report of
  `@roamhq/wrtc` crashing Bun is closed (oven-sh/bun#24609) [V]. Nothing to
  file: this is a missing feature, not a bug.
- **Two libraries work as Bun peers** (the spike runs both, and across):

| Pair (offerer–answerer) | Library kind | Open (signalling over a real `defineChannel`, trickle ICE, host candidates) | 1,000 checked JSON messages | Binary frame arrives as |
|---|---|---|---|---|
| node-datachannel 0.33.6 – node-datachannel | libdatachannel, a prebuilt N-API binary per platform (`@node-datachannel/linux-x64-gnu` etc.), W3C polyfill | 121–123 ms | 19 ms | `ArrayBuffer` |
| werift 0.26.0 – werift | pure TypeScript | 357–364 ms | 1,140–1,146 ms | `Uint8Array` (ignores `binaryType`) |
| node-datachannel – werift | interop | 215–219 ms | 13–20 ms | `Uint8Array` |

  Three runs each [M]. In every pair the invalid message (`text: ""`,
  `at: 1.5`) and the undeclared type (`shout`) were refused by the receiving
  guard with their issues, the sending guard refused the invalid message
  before the wire, and all 1,000 valid messages arrived checked.
- **Findings that shape the design** [M]:
  - **Trickle candidates race the description.** A candidate relayed before
    the answerer applied the offer made libdatachannel throw "Got a remote
    candidate without remote description"; queueing candidates until
    `setRemoteDescription` resolves fixed it. The signalling helper does
    this (§3).
  - **Candidate formats differ between stacks.** libdatachannel refused 5 of
    werift's candidates per run ("Failed to parse ICE candidate"); the pair
    connected on the rest. The helper reports refused candidates instead of
    failing.
  - **`binaryType` is not honoured everywhere** (werift delivers
    `Uint8Array`), so the wrapper normalises binary to `Uint8Array`.
  - werift is ~60× slower per message than libdatachannel here; it needs no
    native binary.
- **What a server-side peer would need**: one of these libraries as the
  app's own dependency (node-datachannel for speed; werift for no native
  code), a STUN/TURN server for anything beyond one host, and, for media, an
  SFU (out of scope). bun-node ships none of it [D].

---

## 3. Signalling: a typed contract and a relay [D]

```ts
// bun-common ./webrtc (browser-safe half), built on channelContract():
export const signalling = signallingContract({ path: "/rtc/:room" });
// receives & sends: join, leave, offer {to, description}, answer {to, description},
// candidate {to, candidate}, peers (the room's list), error

// server: one line, no WebRTC needed
app.ws(...signallingRelay(signalling, { authorize, maxPeersPerRoom: 8 }));

// client
const sig = channel(api, signalling, { params: { room } });
const peer = connectPeer(sig, { to: "bob", iceServers, rtc: RTCPeerConnection });
```

- **The contract** uses the browser's own shapes: `RTCSessionDescriptionInit`
  (`type`, `sdp`) and `RTCIceCandidateInit` (`candidate`, `sdpMid`,
  `sdpMLineIndex`), as zod-free schemas built with the contract core's
  `documented()`/`toStandardSchema` so bun-common takes no vendor
  dependency [D]. The spike's version is zod (`webrtc/spike.ts`).
- **The relay** (`signallingRelay`): a `defineChannel` handler that forwards
  `offer`/`answer`/`candidate` to the named peer in the same room, announces
  `join`/`leave`, and checks every frame both ways. It holds no media and
  runs on any adapter. Measured in the spike: 0 signalling frames refused in
  9 connections [M].
- **The client helper** (`connectPeer`, in bun-client's `./webrtc`): perfect
  negotiation is the app's (glare handling varies); the helper does the
  offer/answer exchange and **queues candidates until the remote description
  is set** (§2's finding), reports refused candidates, and takes the
  `RTCPeerConnection` constructor as an option, so the same code runs in a
  browser and in Bun with a library [D].

## 4. Data channels: the envelope, guards and backpressure [D]

```ts
const chat = channelContract({ path: "/dc/chat", receives: { say: Say }, sends: { said: Said } });
const dc = typedDataChannel(peer.createDataChannel("chat"), chat, { side: "client" });
dc.send("say", { text: "hi" });                  // checked, typed
dc.on("said", (m) => …);
await dc.sendWhenReady("say", big);              // waits on bufferedamountlow
```

- **The same envelope and guards as a WebSocket channel** (`{ type, id?,
  data }`, `createSender`/`createReceiver`), so a contract can be shared
  between a channel and a data channel, and request/response with an id
  works peer to peer. Measured: 13–20 ms for 1,000 checked messages on
  libdatachannel [M].
- **Symmetric channels**: between two peers there is no server, so a
  contract's `receives` and `sends` are read from the point of view of the
  side named by `side: "client" | "server"` (one peer plays each), or both
  are the same map (`symmetric: true`, the spike's case) [D].
- **Backpressure is real here**: `RTCDataChannel.bufferedAmount`,
  `bufferedAmountLowThreshold` and the `bufferedamountlow` event [V, MDN];
  `sendWhenReady` waits on the event, not by polling, unlike a WebSocket
  (`websocket.md` §8).
- **Unreliable channels** (`maxRetransmits: 0`, `ordered: false`) lose and
  reorder messages; request/response over one is refused by the wrapper
  (requests need reliability) [D].
- **Binary**: a contract may declare `binary: { maxBytes }` for raw binary
  frames; the wrapper checks the kind and the size, normalises to
  `Uint8Array`, and leaves the content to the app. A schema for binary
  content (a codec such as CBOR) is out of scope.

## 5. Out of scope [D]

- **Media**: no typing of tracks; track metadata goes in signalling messages
  the app declares.
- **A WebRTC stack in bun-node**, native or bundled; an SFU; TURN/STUN
  servers; perfect negotiation; WHIP/WHEP.
- **Server-side peers as a feature**: documented as "bring node-datachannel
  or werift", with the wrapper working over either, and the spike as the
  recipe.

## 6. Tests

- Signalling: the relay against two clients on port 0 (forward to the named
  peer only; a frame for a peer in another room refused; join/leave);
  candidate queueing (control: without the queue, libdatachannel's error).
- Data channels: run against node-datachannel in bun-client's tests, as a
  **devDependency of bun-client only** (prebuilt binary; no published
  package depends on it), and against a fake `RTCDataChannel` for the
  backpressure event. Werift once, for interop.
- A browser case in Chrome through `Bun.WebView`, as bun-jobs-ui's e2e tests
  run: two in-page peers over the relay [I: `Bun.WebView` exposes Chrome's
  `RTCPeerConnection`; PR-R1 verifies].

## 7. PRs and effort

| PR | What | Depends on | Effort |
|---|---|---|---|
| **PR-R1** signalling | `signallingContract`, `signallingRelay` (bun-common `./webrtc`); `connectPeer` (bun-client `./webrtc`) | PR-W1, PR-W2 | ~2 d |
| **PR-R2** data channels | `typedDataChannel`: envelope, guards, request/response, `sendWhenReady`, binary kind/size | PR-W2 | ~2 d |

Questions: answered 2026-11-02 (TC §14 Q23–Q24, approved as recommended). Names: TC §16, approved 2026-11-02.
