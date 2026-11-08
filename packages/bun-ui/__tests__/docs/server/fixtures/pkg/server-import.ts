// Negative control for bundle-safety.test.ts: a VALUE import of bun-common's
// server side drags the router and `node:*` into a browser bundle.
export { BunRouter } from "@kingsleyweb/bun-common";
