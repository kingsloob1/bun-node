/**
 * Server-sent events (bun-native-routes plan §16, PR-sse2), published as
 * the browser-safe subpath `@kingsleyweb/bun-common/sse` and re-exported
 * from the package root:
 *
 * - the declaration: `sse({ … })`, a route's events (re-exported by the
 *   root as ever), so a module shared with a typed client declares them
 *   once, browser-safe; `sseVariants({ … })`, an event declared as several
 *   whole variants;
 * - the wire format: `formatSseEvent`, `encodeSseEvent`, `SseMessage`;
 * - the writer: `SseWriter` (what `res.sse()` returns), and
 *   `sseResponse()` for a standalone `Response`;
 * - the reader: `SseParser` and `readSse` (the HTML standard's parsing
 *   rules, lifted from bun-jobs).
 *
 * ```ts
 * app.get("/events", (req, res) => {
 *   const stream = res.sse({ contract: Events, ids: "auto" });
 *   const off = feed.subscribe(async (item) => {
 *     if (!(await stream.send({ event: "item", data: item }))) off(); // false: closed
 *   });
 *   stream.onClose(off);
 * });
 * ```
 *
 * Browser-safe: nothing here imports a Bun or Node API
 * (`__tests__/sse/browserSafety.test.ts`).
 */
export {
  sse,
  type SseDataFormat,
  type SseEventMap,
  type SseEvents,
  type SseOptions,
  type SseVariants,
  type SseVariantSpec,
  sseVariants,
} from "./declaration";
export { encodeSseEvent, formatSseEvent, type SseMessage } from "./format";
export {
  readSse,
  type SseEvent,
  type SseItem,
  SseParser,
  type SseParserOptions,
} from "./parser";
export {
  type SseIdleTimeoutServer,
  sseResponse,
  type SseResponseInit,
  type SseSource,
} from "./response";
export {
  type SseContractEvent,
  type SseReplay,
  type SseSendOf,
  SseWriter,
  type SseWriterInit,
  type SseWriterOptions,
} from "./writer";
