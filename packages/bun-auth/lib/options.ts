/**
 * The options every mount shares, resolved once, and the checks of the app's
 * better-auth configuration that end in a warning. Nothing here changes the
 * app's configuration: it is read, never written.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-common/lib/errors";
import { resolveLogger } from "@kingsleyweb/bun-common/lib/logging";
import type { AuthInstance, BunAuthOptions } from "./types";

/** The header bun-auth sets to the client's address, unless told otherwise. */
export const DEFAULT_CLIENT_IP_HEADER = "x-bun-auth-client-ip";

/** better-auth's own default base path. */
export const BETTER_AUTH_BASE_PATH = "/api/auth";

/** An HTTP header name (RFC 9110 `token`). */
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;

/** The kinds of warning bun-auth logs, each at most once per mount. */
export type WarningKind =
  "error-handling" | "client-address" | "body-bytes" | "rate-limit";

/** {@link BunAuthOptions}, resolved. */
export interface ResolvedAuthOptions {
  /** The path the handler answers under, without a trailing slash. */
  readonly basePath: string;
  /** The client-address header, lower case. */
  readonly clientIpHeader: string;
  /** Whether warnings are logged. */
  readonly warn: boolean;
  /** Where warnings and errors go, named `bun-auth`. */
  readonly logger: Logger;
}

/** Throws bun-common's `ConfigError` unless `auth` looks like a better-auth instance. */
export function assertAuthInstance(auth: unknown, where: string): void {
  const candidate = auth as Partial<AuthInstance> | null | undefined;
  if (
    typeof candidate?.handler !== "function" ||
    typeof candidate.api?.getSession !== "function" ||
    typeof candidate.options !== "object"
  ) {
    throw new ConfigError(
      `${where}: auth must be the instance betterAuth({...}) returns`,
      { received: typeof auth },
    );
  }
}

/** The path of better-auth's base URL, as better-auth works it out. */
export function instanceBasePath(auth: AuthInstance): string {
  const { baseURL, basePath } = auth.options;
  if (typeof baseURL === "string") {
    try {
      const path = trimSlashes(new URL(baseURL).pathname);
      if (path !== "") return path;
    } catch {
      // better-auth refuses it itself, on its first request.
    }
  }
  if (typeof basePath === "string" && basePath !== "" && basePath !== "/") {
    return trimSlashes(basePath.startsWith("/") ? basePath : `/${basePath}`);
  }
  return BETTER_AUTH_BASE_PATH;
}

/** `path` without trailing slashes (`""` for the root). */
function trimSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/** Checks and resolves `options`; `fallbackLogger` is used when none is given. */
export function resolveOptions(
  auth: AuthInstance,
  options: BunAuthOptions | undefined,
  where: string,
  fallbackLogger?: Logger,
): ResolvedAuthOptions {
  const basePath = options?.basePath ?? instanceBasePath(auth);
  if (typeof basePath !== "string" || !basePath.startsWith("/")) {
    throw new ConfigError(`${where}: basePath must be a path starting with /`, {
      basePath,
    });
  }
  const header = options?.clientIpHeader ?? DEFAULT_CLIENT_IP_HEADER;
  if (typeof header !== "string" || !HEADER_NAME.test(header)) {
    throw new ConfigError(`${where}: clientIpHeader must be a header name`, {
      clientIpHeader: header,
    });
  }
  const warn = options?.warn ?? true;
  if (typeof warn !== "boolean") {
    throw new ConfigError(`${where}: warn must be a boolean`, { warn });
  }
  const logger = resolveLogger(options?.logger, fallbackLogger).child(
    {},
    { name: "bun-auth" },
  );
  return {
    basePath: trimSlashes(basePath) || "/",
    clientIpHeader: header.toLowerCase(),
    warn,
    logger,
  };
}

/** Whether `auth` hands its internal errors to the host (`onAPIError.throw`). */
export function throwsErrors(auth: AuthInstance): boolean {
  return auth.options.onAPIError?.throw === true;
}

/** Logs each warning once: a set per mount. */
export function createWarner(
  options: ResolvedAuthOptions,
): (
  kind: WarningKind,
  message: string,
  fields?: Record<string, unknown>,
) => void {
  const warned = new Set<WarningKind>();
  return (kind, message, fields) => {
    if (!options.warn || warned.has(kind)) return;
    warned.add(kind);
    options.logger.warn(message, { warning: kind, ...fields });
  };
}

/**
 * The warnings the instance's options call for, known at mount: errors that
 * never reach the host, and a client address read from a header bun-auth does
 * not set.
 */
export function configurationWarnings(
  auth: AuthInstance,
  options: ResolvedAuthOptions,
): Array<[WarningKind, string, Record<string, unknown>]> {
  const found: Array<[WarningKind, string, Record<string, unknown>]> = [];
  if (!throwsErrors(auth)) {
    found.push([
      "error-handling",
      "bun-auth: better-auth answers an internal error with an empty 500 and " +
        "prints it to the console, out of reach of this app's error handlers " +
        "and logger. Set onAPIError: { throw: true } in betterAuth({...}) to " +
        "hand it to them.",
      {},
    ]);
  }
  const ip = auth.options.advanced?.ipAddress;
  if (ip?.disableIpTracking !== true) {
    const headers = (ip?.ipAddressHeaders ?? ["x-forwarded-for"]).map(
      (header) => header.toLowerCase(),
    );
    const others = headers.filter(
      (header) => header !== options.clientIpHeader,
    );
    if (others.length > 0 || headers.length === 0) {
      found.push([
        "client-address",
        `bun-auth: better-auth reads the client's address from ${others.join(", ") || "no header"}, ` +
          `which a client can send itself, for its rate limiter and the ` +
          `session's ipAddress. bun-auth sets ${options.clientIpHeader} to ` +
          `the address bun-common resolved: set advanced: { ipAddress: { ` +
          `ipAddressHeaders: ["${options.clientIpHeader}"] } } in betterAuth({...}).`,
        { ipAddressHeaders: headers, expected: options.clientIpHeader },
      ]);
    }
  }
  return found;
}

/** The rate-limit warning: better-auth's limiter and another on the same request. */
export function rateLimitWarning(other: string): string {
  return (
    `bun-auth: better-auth's own rate limiter is on, and ${other} also ` +
    `counted this request, so a sign-in is counted twice, by two rules ` +
    `(better-auth's keyed by its own reading of the client). Let one own ` +
    `the limits: set rateLimit: { enabled: false } in betterAuth({...}).`
  );
}
