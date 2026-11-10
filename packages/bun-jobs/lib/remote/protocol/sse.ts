/**
 * Server-Sent Events for the remote protocol (`remote-transports.md`
 * §7.3–§7.4): the parser the gateway reads an `http-stream` response with,
 * and the encoder an executor writes one with.
 *
 * Both are bun-common's, from its browser-safe `@kingsleyweb/bun-common/sse`
 * entry (bun-native-routes plan §16.7, S8, PR-sse5). The parser was written
 * here and lifted verbatim into bun-common, with its vectors, in PR-sse2;
 * this module now re-exports that one copy, so the reader and the writer of
 * the format cannot drift. bun-common's `__tests__/sse/parser.test.ts`
 * carries the standard's cases; `__tests__/remote/remote-sse.test.ts` keeps
 * the protocol's own (signed text frames as events).
 *
 * Bun has no working `EventSource`: the global is declared by `bun-types`
 * and absent at runtime, so code using it typechecks and then throws. The
 * gateway therefore reads an `http-stream` response itself, over `fetch`, and
 * parses it with {@link SseParser} or {@link readSse}. Nothing under `lib/`
 * may name `EventSource`; `__tests__/remote/remote-eventsource-ban.test.ts`
 * holds it to that.
 *
 * Internal; browser-safe: `@kingsleyweb/bun-common/sse` imports no Bun or
 * Node API, and an app importing only the parser from it bundles the parser
 * alone (bun-common's `__tests__/treeShaking.test.ts`).
 */
export {
  encodeSseEvent,
  formatSseEvent,
  readSse,
  type SseEvent,
  type SseItem,
  type SseMessage,
  SseParser,
  type SseParserOptions,
} from "@kingsleyweb/bun-common/sse";
