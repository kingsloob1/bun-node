/**
 * `@kingsleyweb/bun-common/webrtc` (typed-client plan, `webrtc.md` §3,
 * PR-R1): typed WebRTC signalling. `signallingContract` is the channel's
 * contract (browser-safe, in `./signalling`, so a shared module a browser
 * imports can take it from `@kingsleyweb/bun-common/lib/webrtc/signalling`
 * with nothing of the server); `signallingRelay` serves it.
 */
export {
  type SignallingMessages,
  type SignallingOptions,
  type SignallingSpec,
  signallingContract,
} from "./signalling";
export {
  type SignallingRelayOptions,
  type SignallingRoute,
  signallingRelay,
} from "./relay";
