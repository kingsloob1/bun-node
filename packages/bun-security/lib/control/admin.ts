/**
 * `secureAdmin` (README §3.6, topologies.md §2.1): the admin listener, a
 * second `Bun.serve` for the management API and UI, bound to loopback or
 * an internal interface. A public bind is refused unless asked for, with
 * client certificates or a trusted proxy in front.
 */
import type {
  BunRequest,
  BunRouter,
  LoggerLike,
  TrustProxyOption,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter, ConfigError } from "@kingsleyweb/bun-common";
import type { Security } from "../engine/security";
import { installSecurity } from "../http/install";
import { cidrContains, parseAddress, parseCidr } from "../ip/address";
import { INTERNAL_RANGES } from "../policy/internal";

/** Something mounted on the admin listener: the API, the UI. */
export interface AdminMount {
  /** Where it is mounted. */
  readonly basePath: string;
  /** Its router. */
  readonly router: BunRouter;
  /** The management API's live hub, whose WebSocket channel is attached to the listener after the mount. */
  readonly live?: {
    /** Adds the channel to the adapter. */
    readonly attach: (adapter: BunHttpAdapter) => void;
  };
}

/** Options for {@link secureAdmin}. */
export interface SecureAdminOptions {
  /** The interface to bind: loopback or an internal address. Default `127.0.0.1`. */
  readonly hostname?: string;
  /** The port; `0` for one the system picks. */
  readonly port: number;
  /** The management API (`createSecurityApi()`). */
  readonly api: AdminMount;
  /** The UI (`securityUi()` from `@kingsleyweb/bun-ui/security`), when served here. */
  readonly ui?: AdminMount;
  /**
   * Bind a public or wildcard address (`0.0.0.0`, `::`, a public IP, a host
   * name). Refused unless it is set and the listener asks for client
   * certificates (`tls.requestCert`) or sits behind a trusted proxy
   * (`trustProxy`). Default `false`.
   */
  readonly allowPublicBind?: boolean;
  /** TLS, as `Bun.serve` takes it; `requestCert` with `ca` for client certificates. */
  readonly tls?: Readonly<Record<string, unknown>> & {
    readonly requestCert?: boolean;
  };
  /** The proxies in front of the listener (bun-common's trust-proxy). */
  readonly trustProxy?: TrustProxyOption;
  /** An engine of the control plane's own, installed on the listener's routes (control-plane.md §4). */
  readonly security?: Security<BunRequest>;
  /** Where errors are logged. */
  readonly logger?: LoggerLike;
}

/** The running admin listener. */
export interface AdminListener {
  /** Its URL. */
  readonly url: string;
  /** The port it bound. */
  readonly port: number;
  /** The adapter, for more routes. */
  readonly adapter: BunHttpAdapter;
  /** Stops it. */
  readonly close: () => Promise<void>;
}

/** Whether `hostname` binds only loopback or internal addresses. */
export function isPrivateBind(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const parsed = parseAddress(hostname.replaceAll(/^\[|\]$/g, ""));
  if (parsed === null) return false;
  if (hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]")
    return false;
  return INTERNAL_RANGES.some((range) => {
    const cidr = parseCidr(range);
    return cidr !== null && cidrContains(cidr, parsed);
  });
}

/**
 * Starts the admin listener and mounts the API (and the UI) on it. Throws
 * a `ConfigError` for a public bind it was not allowed, or a UI mounted
 * at or under the API's path.
 */
export async function secureAdmin(
  options: SecureAdminOptions,
): Promise<AdminListener> {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!isPrivateBind(hostname)) {
    const guarded =
      options.tls?.requestCert === true || options.trustProxy !== undefined;
    if (options.allowPublicBind !== true || !guarded) {
      throw new ConfigError(
        `secureAdmin(): "${hostname}" is not a loopback or internal address; the control plane never listens publicly unless allowPublicBind is set with client certificates (tls.requestCert) or a trusted proxy`,
        { hostname },
      );
    }
  }
  if (options.ui !== undefined) {
    const api = options.api.basePath.replace(/\/+$/, "");
    const ui = options.ui.basePath.replace(/\/+$/, "");
    if (api === ui || api.startsWith(`${ui}/`) || ui.startsWith(`${api}/`)) {
      throw new ConfigError(
        "secureAdmin(): the API and the UI must be mounted apart",
        {
          api: options.api.basePath,
          ui: options.ui.basePath,
        },
      );
    }
  }
  const adapter = new BunHttpAdapter(0, {
    // Bodies are read on a route's first need, not before routing: an
    // agent's batch is authenticated while its body stream is still unread
    // (bytes the runtime has already buffered from the socket aside).
    request: { deferBody: true },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.trustProxy === undefined
      ? {}
      : { trustProxy: options.trustProxy }),
  });
  if (options.security !== undefined) {
    await installSecurity(
      adapter,
      options.security,
      options.logger === undefined ? {} : { logger: options.logger },
    );
  }
  adapter.use(options.api.basePath, options.api.router);
  // The live channel's socket is the adapter's, added after the mount.
  options.api.live?.attach(adapter);
  if (options.ui !== undefined)
    adapter.use(options.ui.basePath, options.ui.router);
  const server = await adapter.setListenOptions({
    hostname,
    port: options.port,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
  });
  const port = server?.port ?? options.port;
  const scheme = options.tls === undefined ? "http" : "https";
  const host =
    hostname.includes(":") && !hostname.startsWith("[")
      ? `[${hostname}]`
      : hostname;
  return {
    url: `${scheme}://${host}:${port}`,
    port,
    adapter,
    close: async () => {
      await adapter.close();
    },
  };
}
