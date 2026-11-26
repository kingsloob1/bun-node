/**
 * `@kingsleyweb/bun-auth`: better-auth on bun-node. The app brings its own
 * `betterAuth({...})` instance; bun-auth mounts it on bun-common with the
 * body and the client's address handed over intact, puts the session typed
 * from that instance on the request, and warns about the settings that hide
 * errors or trust a forgeable address. It never changes the app's
 * better-auth configuration. `./serve` does the mounting for a plain
 * `Bun.serve`.
 */
export { authHandler, mountAuth } from "./mount";
export { DEFAULT_CLIENT_IP_HEADER } from "./options";
export { getAuthSession, requireSession, sessionMiddleware } from "./session";
export type {
  AuthInstance,
  AuthRequest,
  AuthSession,
  BunAuthOptions,
  RequireSessionOptions,
} from "./types";
