/**
 * Compile-time checks for the adapter's before-read and before-write hooks
 * (checked by `bun run check`; `bun test` never reads a `*.type-test.ts`).
 */
import type {
  BeforeReadHook,
  BeforeWriteContext,
  BeforeWriteHook,
  BeforeWritePhase,
  BunRequest,
  BunResponse,
} from "../lib/index";
import { BunHttpAdapter } from "../lib/index";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const assert = <T extends true>(_: T) => _;

const adapter = new BunHttpAdapter<{ user: string }>();

// Every shape a hook naturally takes: nothing returned, an answer on one
// branch, an async body with no return, and a promise of an answer.
adapter.addBeforeReadHook(() => {});
adapter.addBeforeReadHook((request) => {
  if (request.method === "TRACE") return new Response(null, { status: 405 });
});
adapter.addBeforeReadHook(async () => {
  await Bun.sleep(1);
});
adapter.addBeforeReadHook(async () => new Response("later"));

// The server is the adapter's, typed with its WebSocket data.
adapter.addBeforeReadHook((request, server) => {
  const peer: string | undefined = server.requestIP(request)?.address;
  void peer;
});

// A hook written for any adapter fits this one.
const anyAdapterHook: BeforeReadHook = () => undefined;
adapter.addBeforeReadHook(anyAdapterHook);

// Negative controls: an answer is a Response, never a status or a string.
// @ts-expect-error a number is not an answer
adapter.addBeforeReadHook(() => 403);
// @ts-expect-error a string is not an answer
adapter.addBeforeReadHook(async () => "refused");

// The remover.
const remove: () => void = adapter.addBeforeReadHook(() => {});
remove();

adapter.addBeforeWriteHook((context) => {
  assert<Equal<typeof context, BeforeWriteContext>>(true);
  assert<Equal<typeof context.phase, BeforeWritePhase>>(true);
  assert<Equal<typeof context.request, Request>>(true);
  assert<Equal<typeof context.req, BunRequest | undefined>>(true);
  assert<Equal<typeof context.res, BunResponse | undefined>>(true);
  assert<Equal<typeof context.response, Response>>(true);
  context.response.headers.set("x-content-type-options", "nosniff");
});
adapter.addBeforeWriteHook(({ response }) =>
  response.status >= 500
    ? new Response(null, { status: response.status })
    : undefined,
);
adapter.addBeforeWriteHook(async () => {
  await Bun.sleep(1);
});
assert<Equal<BeforeWritePhase, "early" | "response" | "error">>(true);

adapter.addBeforeWriteHook((context) => {
  // @ts-expect-error the context is read-only: a replacement is returned, not assigned
  context.response = new Response();
});
// @ts-expect-error a boolean is not a verdict
adapter.addBeforeWriteHook(() => true);

const writeHook: BeforeWriteHook = () => undefined;
adapter.addBeforeWriteHook(writeHook)();
