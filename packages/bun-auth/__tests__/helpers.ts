/**
 * Shared fixtures: a real `betterAuth()` on better-auth's memory adapter,
 * and requests shaped the way its routes expect them.
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, organization } from "better-auth/plugins";
import { DEFAULT_CLIENT_IP_HEADER } from "../lib";

/** The origin every fixture serves and trusts. */
export const ORIGIN = "http://localhost";

/** A password better-auth's default rules accept. */
export const PASSWORD = "a long passphrase!";

/** The tables the memory adapter needs for the core, admin and organization. */
function freshTables(): Record<string, Record<string, unknown>[]> {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    rateLimit: [],
    organization: [],
    member: [],
    invitation: [],
  };
}

/** Options every fixture shares: the recommended settings, the limiter off, quiet. */
function baseOptions(db: ReturnType<typeof memoryAdapter>) {
  return {
    baseURL: ORIGIN,
    secret: "x".repeat(40),
    database: db,
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    rateLimit: { enabled: false },
    onAPIError: { throw: true },
    advanced: { ipAddress: { ipAddressHeaders: [DEFAULT_CLIENT_IP_HEADER] } },
  } satisfies BetterAuthOptions;
}

/** A better-auth instance with the admin and organization plugins, on a fresh memory database. */
export function makeAuth() {
  return betterAuth({
    ...baseOptions(memoryAdapter(freshTables())),
    plugins: [admin(), organization()],
  });
}

/** The fixture instance's type, for `AuthRequest<AppAuth>`. */
export type AppAuth = ReturnType<typeof makeAuth>;

/**
 * A plain instance (no plugins) with `overrides` spread over the shared
 * options; `failing` makes the database's reads and writes throw while it is
 * `true`.
 */
export function makePlainAuth(
  overrides: Partial<BetterAuthOptions> = {},
  failing: { on: boolean } = { on: false },
) {
  const base = memoryAdapter(freshTables());
  const database: typeof base = (options) => {
    const adapter = base(options);
    return new Proxy(adapter, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (
          failing.on &&
          typeof value === "function" &&
          ["findOne", "findMany", "create"].includes(String(key))
        ) {
          return async () => {
            throw new Error("db connection lost");
          };
        }
        return value;
      },
    });
  };
  return betterAuth({ ...baseOptions(database), ...overrides });
}

/** A served-shaped JSON `POST` init (a `Content-Length`, as a served request has). */
export function jsonPost(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit & { headers: Record<string, string> } {
  const text = JSON.stringify(body);
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(text).byteLength),
      origin: ORIGIN,
      ...headers,
    },
    body: text,
  };
}

/** A served-shaped urlencoded `POST` init. */
export function formPost(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): RequestInit & { headers: Record<string, string> } {
  const text = new URLSearchParams(fields).toString();
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": String(text.length),
      origin: ORIGIN,
      ...headers,
    },
    body: text,
  };
}

/** The `Cookie` header that carries a response's `Set-Cookie`s back. */
export function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** The warnings a test logger saw, by their `warning` kind. */
export function warningsIn(events: LogEvent[]): string[] {
  return events
    .filter((event) => event.level === "warn")
    .map((event) => String(event.fields?.warning));
}

/** A unique e-mail address per call. */
let users = 0;
export function nextEmail(): string {
  users += 1;
  return `user${users}-${crypto.randomUUID().slice(0, 8)}@example.test`;
}
