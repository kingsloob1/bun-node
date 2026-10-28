/**
 * Connection plumbing for the SQL drivers, **copied** from bun-jobs rather
 * than shared (plan §8.3, Q2 "not now"): bun-cache's SQL surface is a handful
 * of tables and statements, and depending on a 48k-line queue package for a
 * few hundred lines of helpers is the wrong trade. Each copy names its origin;
 * the one behavioural difference is the error class (bun-jobs' `ConfigError`
 * is a `TypeError` here — bun-cache has no config error, and a malformed
 * connection is a programmer's mistake). `__tests__/drivers/sql-connection.test.ts`
 * is the drift test: it runs the same inputs through both copies and fails
 * when they stop agreeing — behaviour, not text.
 *
 * When bun-cache's schema first changes, these move with bun-jobs' schema
 * sync engine into one shared package (plan §8.3); until then, a fix to one
 * copy is a fix to both.
 */
import type { SQL } from "bun";
import { SQL as BunSQL } from "bun";

/* ------------------------------------------------------------------ */
/* Copied from bun-jobs/lib/shared/connection.ts@4ec90b1e              */
/* ------------------------------------------------------------------ */

/**
 * A connection described as fields rather than a URL (copied from bun-jobs'
 * `ConnectionOptions`).
 *
 * ```ts
 * { url: "postgres://user:pass@db:5432/app" }
 * { connection: { host: "db", user: "user", password: pass, database: "app" } }
 * ```
 */
export interface SqlConnectionOptions {
  /** Host to connect to. Defaults to `127.0.0.1`. */
  host?: string;
  /** Port to connect to. Defaults to the backend's standard port (5432, 3306). */
  port?: number;
  /** User to authenticate as. */
  user?: string;
  /** Password for that user. */
  password?: string;
  /** Database to use. */
  database?: string | number;
  /** Connect over TLS (adds `tls=true` to the URL). */
  tls?: boolean;
  /**
   * Extra query parameters, for whatever the backend supports that these
   * fields do not name — `sslmode` and so on.
   */
  params?: Record<string, string | number | boolean>;
  /** Additional hosts. */
  hosts?: { host: string; port?: number }[];
  /**
   * Let the client fetch the server's RSA public key, so it can send a
   * password over a connection without TLS. MySQL and MariaDB only; ignored by
   * Postgres. Defaults to false.
   *
   * MySQL 8's `caching_sha2_password` (the default since 8.0, and the only
   * choice in 8.4) will not accept a password in the clear, so without TLS the
   * client must encrypt it with a key the server sends. Nothing authenticates
   * that key: someone able to intercept the connection can substitute their
   * own and read the password. Fine for a trusted local connection or a test
   * server; in production, prefer TLS (`tls: true`), which needs none of this.
   *
   * The URL form is the query parameter `allowPublicKeyRetrieval=true`, which
   * the driver takes out of the URL and passes as the client option Bun
   * honours: **Bun ignores it in a URL**.
   */
  allowPublicKeyRetrieval?: boolean;
}

/** What a backend needs in order to build a URL from fields. */
export interface UrlDefaults {
  /** URL scheme, e.g. `postgres`. */
  scheme: string;
  /** Scheme to use when `tls` is set, when the backend has a separate one. */
  tlsScheme?: string;
  /** Host used when none is given. */
  host?: string;
  /** Port used when none is given. */
  port?: number;
  /** Whether the database belongs in the path (as opposed to a parameter). */
  databaseInPath?: boolean;
}

/** Builds a connection URL from fields. Copied from bun-jobs' `toConnectionUrl`. */
export function toConnectionUrl(
  connection: SqlConnectionOptions,
  defaults: UrlDefaults,
): string {
  const scheme =
    connection.tls && defaults.tlsScheme ? defaults.tlsScheme : defaults.scheme;

  const credentials = connection.user
    ? `${encodeURIComponent(connection.user)}${
        connection.password ? `:${encodeURIComponent(connection.password)}` : ""
      }@`
    : "";

  const primary = {
    host: connection.host ?? defaults.host ?? "127.0.0.1",
    port: connection.port ?? defaults.port,
  };

  const hosts = [primary, ...(connection.hosts ?? [])]
    .map((entry) => {
      const port = entry.port ?? defaults.port;
      return port === undefined ? entry.host : `${entry.host}:${port}`;
    })
    .join(",");

  const path =
    defaults.databaseInPath !== false && connection.database !== undefined
      ? `/${String(connection.database)}`
      : "/";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(connection.params ?? {})) {
    params.set(key, String(value));
  }

  // TLS without a scheme of its own becomes a parameter the backend reads.
  if (connection.tls && !defaults.tlsScheme && !params.has("tls")) {
    params.set("tls", "true");
  }

  const query = params.size > 0 ? `?${params.toString()}` : "";

  return `${scheme}://${credentials}${hosts}${path}${query}`;
}

/** A driver option that accepts either form. */
export interface ConnectionInput {
  /** A complete connection URL. */
  url?: string;
  /** The connection described as fields, used when `url` is absent. */
  connection?: SqlConnectionOptions;
}

/**
 * Resolves either form into a URL. Copied from bun-jobs'
 * `resolveConnectionUrl`; throws a `TypeError` where bun-jobs throws its
 * `ConfigError`.
 *
 * A URL wins when both are given, so an environment variable can override a
 * config file without the config having to be rewritten.
 */
export function resolveConnectionUrl(
  input: ConnectionInput,
  defaults: UrlDefaults,
  what: string,
): string {
  if (input.url) {
    return input.url;
  }

  if (input.connection) {
    return toConnectionUrl(input.connection, defaults);
  }

  throw new TypeError(`${what} needs either a url or a connection object`);
}

/**
 * Takes a boolean query parameter out of a connection URL. Copied from
 * bun-jobs' `takeBooleanParam`; throws a `TypeError` where bun-jobs throws its
 * `ConfigError`.
 *
 * Returns the URL without it, and its value: `true` for `true`/`1`/`yes`,
 * `false` for `false`/`0`/`no`, `undefined` when absent. For a parameter the
 * driver understands and the client does not — the client would ignore it, so
 * a URL carrying it would connect as though it were not there. Every other
 * parameter, `sslmode` and `tls` included, is left exactly as written. The
 * query is edited as text, so the rest of the URL (a password with escapes, a
 * host list) is never reparsed or re-encoded.
 */
export function takeBooleanParam(
  url: string,
  name: string,
): { url: string; value: boolean | undefined } {
  const at = url.indexOf("?");
  if (at < 0) {
    return { url, value: undefined };
  }

  const hashAt = url.indexOf("#", at);
  const query = url.slice(at + 1, hashAt < 0 ? undefined : hashAt);
  const hash = hashAt < 0 ? "" : url.slice(hashAt);

  let value: boolean | undefined;
  const kept: string[] = [];

  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq));

    if (key !== name) {
      if (pair !== "") {
        kept.push(pair);
      }
      continue;
    }

    const raw = decodeURIComponent(eq < 0 ? "" : pair.slice(eq + 1))
      .trim()
      .toLowerCase();

    if (["true", "1", "yes"].includes(raw)) {
      value = true;
    } else if (["false", "0", "no"].includes(raw)) {
      value = false;
    } else {
      throw new TypeError(
        `The connection URL's ${name} parameter must be true or false`,
      );
    }
  }

  const rest = kept.length > 0 ? `?${kept.join("&")}` : "";
  return { url: `${url.slice(0, at)}${rest}${hash}`, value };
}

/* ------------------------------------------------------------------ */
/* After bun-jobs/lib/drivers/sql/sql-driver.ts@4ec90b1e openSqlClient */
/* ------------------------------------------------------------------ */

/** The engines the SQL drivers speak. */
export type SqlCacheAdapter = "postgres" | "mysql" | "mariadb";

/** Default port per engine, for building a URL from connection fields. */
const DEFAULT_PORTS: Record<SqlCacheAdapter, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
};

/**
 * What `new SQL(...)` receives for a connection: the URL, and on MySQL and
 * MariaDB the `allowPublicKeyRetrieval` option taken out of it. Pure, so the
 * drift test can compare it with bun-jobs' handling without a server.
 *
 * On MySQL and MariaDB, `allowPublicKeyRetrieval` comes from the URL's query
 * parameter or, for a connection given as fields, from that field — the URL
 * wins, as it does for everything else. Bun's client ignores the parameter in
 * a URL, so it is taken out and passed as the client option it has to be.
 * Every other parameter, `ssl`/`tls`/`sslmode` included, stays in the URL for
 * the client to read.
 */
export function sqlClientOptions(
  adapter: SqlCacheAdapter,
  input: ConnectionInput,
  what: string,
): { url: string; allowPublicKeyRetrieval?: boolean } {
  const resolved = resolveConnectionUrl(
    input,
    { scheme: adapter, host: "127.0.0.1", port: DEFAULT_PORTS[adapter] },
    what,
  );

  if (adapter === "postgres") {
    return { url: resolved };
  }

  const { url, value } = takeBooleanParam(resolved, "allowPublicKeyRetrieval");
  const allowPublicKeyRetrieval =
    value ??
    (input.url ? undefined : input.connection?.allowPublicKeyRetrieval);

  return allowPublicKeyRetrieval === undefined
    ? { url }
    : { url, allowPublicKeyRetrieval };
}

/** Opens a client for a connection, with `max` connections in its pool when given. */
export function openSqlClient(
  adapter: SqlCacheAdapter,
  input: ConnectionInput,
  what: string,
  max: number | undefined,
): SQL {
  return new BunSQL({
    ...sqlClientOptions(adapter, input, what),
    ...(max === undefined ? {} : { max }),
  });
}

/**
 * Whether an error is Bun's MySQL client refusing to fetch the server's RSA
 * key: MySQL 8's `caching_sha2_password` asked for it over a connection
 * without TLS, and `allowPublicKeyRetrieval` was not set. Read through the
 * `cause` chain. Copied from bun-jobs' `isPublicKeyRetrievalRefusal`.
 */
export function isPublicKeyRetrievalRefusal(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }
    if (
      (at as { code?: unknown }).code ===
      "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED"
    ) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Copied from bun-jobs/lib/drivers/sql/dialect.ts@4ec90b1e            */
/* ------------------------------------------------------------------ */

/** How many times {@link withLockRetry} tries before giving up. */
const LOCK_RETRIES = 12;

/**
 * Server error numbers that mean "the statement was fine, the timing was not".
 *
 * MySQL and MariaDB report them as a numeric `errno`: 1213 is a deadlock, 1205
 * a lock wait timeout, and 1020 is MariaDB's "record has changed since last
 * read" — what `innodb_snapshot_isolation`, on by default since 11.6, raises
 * when a transaction writes a row another committed after its snapshot.
 * Postgres puts its SQLSTATE in `errno` as a string: `40001` serialization
 * failure, `40P01` deadlock.
 */
const TRANSIENT_ERRNOS = new Set<unknown>([1213, 1205, 1020, "40001", "40P01"]);

/**
 * The same conditions as a `code` or `sqlState`: SQLSTATE `40001` is what
 * MySQL sends alongside 1213, and Postgres's `code` carries the SQLSTATE too.
 */
const TRANSIENT_STATES = new Set<unknown>(["40001", "40P01"]);

/**
 * Whether an error is the database saying "someone else had it, try again"
 * (a deadlock, a lock wait timeout, a serialization failure). Walks the
 * `cause` chain and checks codes before wording. Copied from bun-jobs'
 * `isTransientLockError`.
 */
export function isTransientLockError(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }

    const { errno, code, sqlState, message } = at as {
      errno?: unknown;
      code?: unknown;
      sqlState?: unknown;
      message?: unknown;
    };

    if (
      TRANSIENT_ERRNOS.has(errno) ||
      TRANSIENT_STATES.has(code) ||
      TRANSIENT_STATES.has(sqlState) ||
      // `SQLITE_BUSY_SNAPSHOT` and the other extended forms mean the same.
      (typeof code === "string" && code.startsWith("SQLITE_BUSY"))
    ) {
      return true;
    }

    if (
      /deadlock|try restarting transaction|lock wait timeout|could not serialize access|database (?:is|table is) locked/i.test(
        String(message ?? ""),
      )
    ) {
      return true;
    }

    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Retries `work` while the database keeps saying it was busy. Everything the
 * drivers retry is idempotent or conditional, so repeating it is safe; the
 * backoff is jittered so two losers do not collide again. Copied from
 * bun-jobs' `withLockRetry`.
 */
export async function withLockRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;

      if (!isTransientLockError(error)) {
        throw error;
      }

      await Bun.sleep(Math.random() * 15 * attempt);
    }
  }

  throw lastError;
}
