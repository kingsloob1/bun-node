/**
 * Compile-time assertions for `@kingsleyweb/bun-common/webrtc` (typed-client
 * `webrtc.md` §3, PR-R1): `signallingContract` keeps the path literal and the
 * options given, with the fixed messages typed; `signallingRelay` spreads
 * into `ws()` on an adapter and a router, its path the literal, and takes
 * only a signalling contract. Checked by `bun run check` /
 * `bun scripts/typecheck.ts`, not by `bun test`; every `@ts-expect-error` is
 * a negative control that fails the build if the error it expects ever
 * disappears.
 */
import type { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import type { BunRouter } from "../../lib/BunRouter";
import type { StandardSchemaV1 } from "../../lib/types/standardSchema";
import { z } from "zod";
import { channelContract } from "../../lib/contract/channel";
import { signallingContract, signallingRelay } from "../../lib/webrtc";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const signalling = signallingContract({ path: "/rtc/:room" });

// The path literal and the fixed messages.
export type _path = Expect<Equal<typeof signalling.spec.path, "/rtc/:room">>;
export type _offerIn = Expect<
  Equal<
    StandardSchemaV1.InferOutput<typeof signalling.spec.receives.offer>,
    { to: string; description: { type: "offer"; sdp: string } }
  >
>;
export type _candidateOut = Expect<
  Equal<
    StandardSchemaV1.InferOutput<
      typeof signalling.spec.sends.candidate
    >["from"],
    string
  >
>;
export type _leave = Expect<Equal<typeof signalling.spec.receives.leave, null>>;
export type _replies = Expect<
  Equal<typeof signalling.spec.replies, { readonly join: "peers" }>
>;

// The options given are kept.
const Room = z.object({ room: z.string() });
const withRequest = signallingContract({
  path: "/signal/:room",
  request: { params: Room },
});
export type _request = Expect<
  Equal<typeof withRequest.spec.request, { readonly params: typeof Room }>
>;

// The route spreads into `ws()`, on an adapter and on a router.
declare const adapter: BunHttpAdapter;
declare const router: BunRouter;
adapter.ws(...signallingRelay(signalling, { maxPeersPerRoom: 4 }));
router.ws(
  ...signallingRelay(withRequest, {
    authorize: (_req, _res, next) => next(),
  }),
);
export const route = signallingRelay(signalling);
export type _routePath = Expect<Equal<(typeof route)[0], "/rtc/:room">>;

// Only a signalling contract.
const chat = channelContract({ path: "/chat", receives: {}, sends: {} });
// @ts-expect-error a channel that is not a signalling one
signallingRelay(chat);
// @ts-expect-error an option the relay does not take
signallingRelay(signalling, { rooms: 3 });
