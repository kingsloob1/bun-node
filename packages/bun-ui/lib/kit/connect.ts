/**
 * The `connect-src` sources a UI's shell allows after `'self'`, one helper
 * per shape of UI: {@link connectSources} for a UI talking to an API and its
 * socket (the jobs UI; bun-security's UI will be the same shape), and
 * {@link documentOriginSource} for one fetching a document (the docs viewer).
 * Each drops anything that is not a well-formed source rather than writing it
 * into the header.
 */

/**
 * A `Host` value usable as a CSP host-source: a DNS name or IPv4 address of
 * letters, digits, `-` and `.` (no empty label, no trailing dot), and an
 * optional port. IPv6 literals are left out — CSP's host-source grammar has
 * no form for them, and `'self'` still covers the page in current browsers.
 */
const HOST =
  /^([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*)(?::(\d{1,5}))?$/i;

/** Inputs to {@link connectSources}. */
export interface ConnectSourcesOptions {
  /**
   * The request's `Host` (`host[:port]`), i.e. the page's origin as the
   * browser loaded it. Attacker-controlled on a misrouted request, so anything
   * outside the `host[:port]` grammar is ignored, never copied into the header.
   */
  host: string | undefined;
  /** Whether the page is `https`: its socket sources are then `wss:`, else `ws:`. */
  secure: boolean;
  /**
   * The API's origin when it is elsewhere (`"https://api.example"`); added in
   * its `http(s)` and `ws(s)` forms. Omitted for a same-origin API.
   */
  apiOrigin?: string;
  /**
   * A dedicated socket port (`config.websocket.port`); adds that port's
   * `ws(s)` origin on the page's hostname. Omitted when the socket shares the
   * page's port.
   */
  websocketPort?: number | null;
}

/**
 * The `connect-src` sources after `'self'`: the `ws(s)` form of the page's own
 * origin (older WebKit does not let `'self'` match `ws:`/`wss:`), a dedicated
 * socket port on the same hostname, and a cross-origin API in both forms.
 * Never a bare `ws:` or `wss:`, which would allow a socket to any host.
 */
export function connectSources(options: ConnectSourcesOptions): string[] {
  const sources: string[] = [];
  const socket = options.secure ? "wss" : "ws";
  const match = HOST.exec(options.host ?? "");
  const port = match?.[2] === undefined ? undefined : Number(match[2]);
  if (match && (port === undefined || (port >= 1 && port <= 65535))) {
    const hostname = match[1].toLowerCase();
    sources.push(
      `${socket}://${hostname}${port === undefined ? "" : `:${port}`}`,
    );
    const dedicated = options.websocketPort;
    if (
      typeof dedicated === "number" &&
      Number.isInteger(dedicated) &&
      dedicated >= 1 &&
      dedicated <= 65535
    ) {
      sources.push(`${socket}://${hostname}:${dedicated}`);
    }
  }
  if (options.apiOrigin !== undefined) {
    const api = new URL(options.apiOrigin);
    sources.push(
      api.origin,
      `${api.protocol === "https:" ? "wss" : "ws"}://${api.host}`,
    );
  }
  return sources;
}

/**
 * The origin a cross-origin document URL adds to `connect-src`, or
 * `undefined` for a same-origin one (`/jobs-api/openapi.json`). The viewer
 * fetches the document from the page; a thunk is served same-origin by the
 * router itself. Anything malformed is dropped rather than written into the
 * header.
 */
export function documentOriginSource(documentUrl: string): string | undefined {
  if (!/^https?:\/\//i.test(documentUrl)) {
    return undefined;
  }
  try {
    return new URL(documentUrl).origin;
  } catch {
    return undefined;
  }
}
