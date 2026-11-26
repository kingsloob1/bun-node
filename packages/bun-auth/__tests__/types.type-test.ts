/**
 * Compile-time checks, read by `bun run check` (never by `bun test`): a real
 * `betterAuth()` instance is an `AuthInstance`, the session is typed from the
 * instance's plugins, and a route handler can declare `AuthRequest`. Each
 * `@ts-expect-error` is a negative control: it fails the check if the error
 * it expects goes away.
 */
import type { BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { betterAuth } from "better-auth";
import type { AuthInstance, AuthRequest, AuthSession } from "../lib";
import { getAuthSession, mountAuth, requireSession } from "../lib";
import { withAuth } from "../lib/serve";
import type { AppAuth } from "./helpers";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

declare const plugged: AppAuth;
const plain = betterAuth({ emailAndPassword: { enabled: true } });

// Both instances are AuthInstances, plugins or not.
export const _instances: AuthInstance[] = [plugged, plain];

// The admin plugin's fields are on the plugged session's user, typed.
export const _role: Equal<
  AuthSession<AppAuth>["user"]["role"],
  string | null | undefined
> = true;
// …and not on the plain one's.
// @ts-expect-error `role` comes only with the admin plugin.
export type _noRole = AuthSession<typeof plain>["user"]["role"];

// The organization plugin's field is on the plugged session.
export const _org: Equal<
  AuthSession<AppAuth>["session"]["activeOrganizationId"],
  string | null | undefined
> = true;

// A route handler can declare its request as AuthRequest.
const app = new BunHttpAdapter(0);
mountAuth(app, plugged);
app.get(
  "/me",
  requireSession(plugged),
  (req: AuthRequest<AppAuth>, res: BunResponse) => {
    const email: string | undefined = req.user?.email;
    res.json({ email });
  },
);

// getAuthSession is typed from its argument.
declare const req: AuthRequest<AppAuth>;
export const found = getAuthSession<AppAuth>(req);
export const _found: Equal<typeof found, AuthSession<AppAuth> | null> = true;

// Not a better-auth instance.
// @ts-expect-error `handler`, `api` and `options` are missing.
mountAuth(app, { handler: async () => new Response() });

// withAuth's returned fetch takes what Bun.serve passes.
export const _serve = Bun.serve({
  port: 0,
  fetch: withAuth(plain, () => new Response()),
});
