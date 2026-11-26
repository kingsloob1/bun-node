/**
 * better-auth on bun-common (plan §4): `authHandler` is the middleware that
 * hands each request under the base path to better-auth, and `mountAuth`
 * registers it on a router or adapter with the checks that need the app.
 */
import type {
  BunRequest,
  BunResponse,
  BunRouter,
  Logger,
  NextFunction,
  RouterHandler,
} from "@kingsleyweb/bun-common";
import { webRequestSource } from "@kingsleyweb/bun-common/lib/webRequest";
import { reportServerError, withClientAddress } from "./handover";
import type { LimiterCheck } from "./limiter";
import { createLimiterCheck } from "./limiter";
import {
  assertAuthInstance,
  configurationWarnings,
  createWarner,
  rateLimitWarning,
  resolveOptions,
  throwsErrors,
} from "./options";
import type { ResolvedAuthOptions, WarningKind } from "./options";
import type { AuthInstance, BunAuthOptions } from "./types";

/** The warning for a body that reached bun-auth without its bytes. */
const BODY_BYTES_WARNING =
  "bun-auth: request bodies reach better-auth rebuilt from their parsed " +
  "value, not as sent, because the adapter reads them before any " +
  "middleware without keeping their bytes (request: { retainBuffer: false } " +
  "without deferBody). better-auth reads such a JSON or form body " +
  "correctly; to hand over the exact bytes, leave retainBuffer at its " +
  "default or set deferBody: true.";

/** What a mount keeps between requests. */
interface MountState {
  /** The resolved options. */
  readonly options: ResolvedAuthOptions;
  /** Logs each warning once. */
  readonly warn: (
    kind: WarningKind,
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** Whether better-auth throws its internal errors (`onAPIError.throw`). */
  readonly throws: boolean;
  /** The two-limiters check, while it still has to run. */
  readonly limiter: LimiterCheck;
}

/** Sets up one mount: resolves the options and logs the configuration warnings. */
function createMount(
  auth: AuthInstance,
  options: BunAuthOptions | undefined,
  where: string,
  fallbackLogger?: Logger,
): MountState {
  assertAuthInstance(auth, where);
  const resolved = resolveOptions(auth, options, where, fallbackLogger);
  const warn = createWarner(resolved);
  for (const [kind, message, fields] of configurationWarnings(auth, resolved)) {
    warn(kind, message, fields);
  }
  return {
    options: resolved,
    warn,
    throws: throwsErrors(auth),
    limiter: createLimiterCheck(auth),
  };
}

/** The request to hand over: the body as received, `undefined` when it must wait for the read. */
function webRequestOf(req: BunRequest): Request | undefined {
  try {
    return req.webRequest();
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

/** The middleware itself, over a set-up mount. */
function handlerFor(auth: AuthInstance, mount: MountState): RouterHandler {
  const { options, warn, limiter } = mount;
  return async (req: BunRequest, res: BunResponse, next: NextFunction) => {
    let response: Response;
    let request: Request;
    try {
      let received = webRequestOf(req);
      if (received === undefined) {
        // A read still in progress: wait for it, then the bytes are kept.
        await req.ready();
        received = req.webRequest();
      }
      if (webRequestSource(received) === "parsed") {
        warn("body-bytes", BODY_BYTES_WARNING, {});
      }
      request = withClientAddress(
        received,
        options.clientIpHeader,
        req.clientAddress,
      );
      if (options.warn) {
        const other = await limiter.check(req);
        if (other !== undefined) {
          warn("rate-limit", rateLimitWarning(other), { other });
          limiter.done();
        }
      }
      response = await auth.handler(request);
    } catch (error) {
      // With onAPIError: { throw: true }, better-auth's internal errors land
      // here, for the app's error handlers and its logger.
      next(error as Error);
      return;
    }
    reportServerError(options.logger, request, response, mount.throws);
    res.send(response);
  };
}

/**
 * The middleware that answers every request it sees with better-auth's
 * handler: the request handed over with its body as received
 * (`req.webRequest()`, whatever the adapter's body options) and with the
 * client's address, as bun-common resolved it (`req.clientAddress`, through
 * `trustProxy`), in the `clientIpHeader` header in place of any copy the
 * client sent. Register it with `use` on better-auth's base path, which
 * {@link mountAuth} does for you:
 *
 * ```ts
 * app.use("/api/auth", authHandler(auth, { logger: app.logger }));
 * ```
 *
 * better-auth's own answers (`4xx` included) are sent as they are. An error
 * better-auth throws (`onAPIError: { throw: true }`) goes to the error
 * handlers; a `5xx` it answers itself is logged. The configuration warnings
 * are logged once, when this is called; see {@link BunAuthOptions.warn}.
 *
 * @throws ConfigError (bun-common's) for an invalid option or a value that is
 * not a better-auth instance.
 */
export function authHandler(
  auth: AuthInstance,
  options?: BunAuthOptions,
): RouterHandler {
  return handlerFor(auth, createMount(auth, options, "authHandler()"));
}

/** Request options of an adapter, if `app` is one (`BunHttpAdapter#requestOpts`). */
function adapterBodyOptions(
  app: BunRouter,
): { retainBuffer?: boolean; deferBody?: boolean } | undefined {
  const opts = (
    app as { requestOpts?: { retainBuffer?: boolean; deferBody?: boolean } }
  ).requestOpts;
  return typeof opts === "object" && opts !== null ? opts : undefined;
}

/**
 * Mounts better-auth on a bun-common router or adapter: {@link authHandler}
 * registered with `app.use(basePath, …)` on the instance's base path (or
 * `options.basePath`), logging to the router's logger unless
 * `options.logger` is given. It reads the app's better-auth configuration and
 * never changes it. Beside the configuration warnings it warns, once, when
 * the adapter reads bodies without keeping their bytes (`retainBuffer: false`
 * without `deferBody`): better-auth then gets a body rebuilt from its parsed
 * value, which it reads correctly, but not byte for byte.
 *
 * ```ts
 * export const auth = betterAuth({
 *   database,
 *   emailAndPassword: { enabled: true },
 *   onAPIError: { throw: true },
 *   advanced: { ipAddress: { ipAddressHeaders: ["x-bun-auth-client-ip"] } },
 * });
 * mountAuth(app, auth);
 * app.get("/me", requireSession(auth), (req: AuthRequest<typeof auth>, res) => res.json(req.user));
 * ```
 *
 * Mount it ahead of the routes that need a session and after any CORS
 * middleware: better-auth answers no preflight itself.
 *
 * @throws ConfigError (bun-common's) for an invalid option or a value that is
 * not a better-auth instance.
 */
export function mountAuth(
  app: BunRouter,
  auth: AuthInstance,
  options?: BunAuthOptions,
): void {
  const mount = createMount(auth, options, "mountAuth()", app.logger);
  const body = adapterBodyOptions(app);
  if (body?.retainBuffer === false && body.deferBody !== true) {
    mount.warn("body-bytes", BODY_BYTES_WARNING, {});
  }
  app.use(mount.options.basePath, handlerFor(auth, mount));
}
