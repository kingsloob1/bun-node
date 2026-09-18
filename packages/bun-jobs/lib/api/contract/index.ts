/**
 * `@kingsleyweb/bun-jobs/api/contract`: the management API's wire contract,
 * safe to import in a browser.
 *
 * Constants (action names, protocol version, socket subprotocol and close
 * codes, job states, event names), a named type for every HTTP request and
 * response, and every WebSocket frame and event. Nothing here imports a driver, bun-common, or any `node:*` or
 * `bun:*` module — only its own sibling files — so a client bundle stays free
 * of the server. The server itself imports these constants from here, so the
 * two cannot disagree.
 */

export * from "./constants";
export type * from "./types";
export type * from "./ws";
