import { ConfigError } from "./errors";

/**
 * Describing a connection.
 *
 * Every driver accepts either a URL or a set of fields, because both are
 * normal: a URL is what a platform hands you in an environment variable, and
 * fields are what a config file or a secrets manager gives you a piece at a
 * time. Neither should force the caller to assemble or take apart the other.
 *
 * ```ts
 * { url: "postgres://user:pass@db:5432/jobs" }
 * { connection: { host: "db", user: "user", password: pass, database: "jobs" } }
 * ```
 */

/** A connection described as fields rather than a URL. */
export interface ConnectionOptions {
  /** Host to connect to. Defaults to the driver's own default. */
  host?: string;
  /** Port to connect to. Defaults to the backend's standard port. */
  port?: number;
  /** User to authenticate as. */
  user?: string;
  /** Password for that user. */
  password?: string;
  /** Database (or, for Redis, the numbered database) to use. */
  database?: string | number;
  /** Connect over TLS. */
  tls?: boolean;
  /**
   * Extra query parameters, for whatever the backend supports that these
   * fields do not name — `authSource`, `replicaSet`, `sslmode` and so on.
   */
  params?: Record<string, string | number | boolean>;
  /** Additional hosts, for a replica set or a cluster. */
  hosts?: { host: string; port?: number }[];
  /**
   * Let the client fetch the server's RSA public key, so it can send a
   * password over a connection without TLS. MySQL and MariaDB only; ignored by
   * every other backend. Defaults to false.
   *
   * MySQL 8's `caching_sha2_password` (the default since 8.0, and the only
   * choice in 8.4) will not accept a password in the clear, so without TLS the
   * client must encrypt it with a key the server sends. Nothing authenticates
   * that key: someone able to intercept the connection can substitute their
   * own and read the password. Fine for a trusted local connection or a test
   * server; in production, prefer TLS (`tls: true`), which needs none of this.
   *
   * The URL form is the query parameter `allowPublicKeyRetrieval=true`. A plain
   * boolean, so it survives the `JSON.stringify` a spawned child's driver
   * config goes through.
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

/** Builds a connection URL from fields. */
export function toConnectionUrl(
  connection: ConnectionOptions,
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
  connection?: ConnectionOptions;
}

/**
 * Resolves either form into a URL.
 *
 * A URL wins when both are given, so an environment variable can override a
 * config file without the config having to be rewritten — which is the usual
 * reason both are present at once.
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

  throw new ConfigError(`${what} needs either a url or a connection object`, {
    what,
  });
}

/**
 * Takes a boolean query parameter out of a connection URL.
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
      throw new ConfigError(
        `The connection URL's ${name} parameter must be true or false`,
        { parameter: name, value: raw },
      );
    }
  }

  const rest = kept.length > 0 ? `?${kept.join("&")}` : "";
  return { url: `${url.slice(0, at)}${rest}${hash}`, value };
}

/** The database named in a URL's path, when it has one. */
export function databaseFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.replace(/^\//, "");
    return path.length > 0 ? decodeURIComponent(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the names of a backend's tables or collections.
 *
 * Both a prefix and explicit names are supported, because they answer
 * different questions: a prefix keeps several deployments apart in one
 * database, while an explicit name fits an existing schema that was not
 * chosen here. An explicit name is used exactly as given, prefix and all.
 */
export function resolveNames<TName extends string>(
  names: readonly TName[],
  options: {
    /** Prepended to every name that was not given explicitly. */
    prefix?: string;
    /** Names to use instead of `${prefix}${name}`. */
    overrides?: Partial<Record<TName, string>>;
    /** The prefix used when none is given. */
    defaultPrefix: string;
  },
): Record<TName, string> {
  const prefix = options.prefix ?? options.defaultPrefix;
  const resolved = {} as Record<TName, string>;

  for (const name of names) {
    const override = options.overrides?.[name];

    if (override !== undefined && override.length === 0) {
      throw new ConfigError(`The name for "${name}" cannot be empty`, { name });
    }

    resolved[name] = override ?? `${prefix}${name}`;
  }

  return resolved;
}
