/**
 * Shared test helpers for constructing {@link BunRequest}/{@link BunResponse}
 * instances without standing up a full HTTP server per test.
 */
import type { Server } from "bun";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";

/** The options object accepted by {@link BunRequest}'s constructor. */
type BunRequestOptions = ConstructorParameters<typeof BunRequest>[2];

/** A long-lived loopback server reused as the `server` argument for requests. */
export const testServer: Server<unknown> = Bun.serve({
  port: 0,
  fetch: () => new Response("ok"),
  websocket: {
    message: () => {},
    open: () => {},
    close: () => {},
    drain: () => {},
  },
});

export interface MakeRequestInit {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  /**
   * The request body, in any shape `Bun.serve` accepts.
   *
   * `Bun.BodyInit`, not the bare global: that one only exists when `lib.dom`
   * is loaded, and this package compiles against `lib: ["ESNext"]`. It is also
   * the more accurate type — Bun accepts async iterables and generators the
   * DOM union does not.
   */
  body?: Bun.BodyInit;
  /** Extra {@link BunRequest} options, merged over the helper defaults. */
  options?: Partial<NonNullable<BunRequestOptions>>;
}

/** Builds and fully initialises a {@link BunRequest}. */
export async function makeRequest(
  init: MakeRequestInit = {},
): Promise<BunRequest> {
  const request = new Request(init.url ?? "http://localhost/", {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });

  return BunRequest.init(request, testServer, {
    parseBody: !!init.body,
    parseCookies: true,
    parseQuery: true,
    ...init.options,
  });
}

/** Builds a {@link BunResponse} bound to a fresh request. */
export async function makeResponse(
  init: MakeRequestInit = {},
): Promise<BunResponse> {
  const request = await makeRequest(init);
  return new BunResponse(request);
}

/** The head of a raw HTTP response, as {@link rawUpgrade} read it off the wire. */
export interface RawResponseHead {
  /** The status line, e.g. `HTTP/1.1 101 Switching Protocols`. */
  statusLine: string;
  /** Every header line in wire order, names lower-cased, values trimmed. */
  headers: [name: string, value: string][];
}

/**
 * Sends a WebSocket upgrade request over a plain TCP socket and returns the
 * response head exactly as the server wrote it — every header, in order,
 * duplicates included, which a `WebSocket` client never exposes.
 *
 * `protocols` become one `Sec-WebSocket-Protocol` offer, in the order given.
 */
export async function rawUpgrade(
  port: number,
  path: string,
  protocols: string[] = [],
  timeoutMs = 2000,
): Promise<RawResponseHead> {
  let buffered = "";
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const timer = setTimeout(
    () => reject(new Error(`no response head within ${timeoutMs}ms`)),
    timeoutMs,
  );
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        buffered += chunk.toString("latin1");
        const end = buffered.indexOf("\r\n\r\n");
        if (end !== -1) {
          resolve(buffered.slice(0, end));
        }
      },
      close() {
        reject(
          new Error(`connection closed before a response head: ${buffered}`),
        );
      },
      error(_socket, error) {
        reject(error);
      },
    },
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...(protocols.length > 0
        ? [`Sec-WebSocket-Protocol: ${protocols.join(", ")}`]
        : []),
      "",
      "",
    ].join("\r\n"),
  );
  try {
    const head = await promise;
    const [statusLine = "", ...lines] = head.split("\r\n");
    return {
      statusLine,
      headers: lines.map((line) => {
        const colon = line.indexOf(":");
        return [
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim(),
        ];
      }),
    };
  } finally {
    clearTimeout(timer);
    socket.end();
  }
}

/**
 * Opens a `WebSocket` offering `protocols` and resolves the subprotocol the
 * server selected (`ws.protocol`) once it is open; the socket is then closed.
 */
export async function negotiatedProtocol(
  url: string,
  protocols: string[],
): Promise<string> {
  const client = new WebSocket(url, protocols);
  try {
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve(), { once: true });
      client.addEventListener(
        "error",
        () => reject(new Error(`no upgrade at ${url}`)),
        { once: true },
      );
    });
    return client.protocol;
  } finally {
    client.close();
  }
}
