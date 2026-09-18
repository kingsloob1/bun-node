// Negative control for bundle-safety.test.ts: a VALUE import from the package
// root drags the server (drivers, bun-common, node:*) into a browser bundle.
export { JOBS_API_WS_SUBPROTOCOL } from "@kingsleyweb/bun-jobs";
