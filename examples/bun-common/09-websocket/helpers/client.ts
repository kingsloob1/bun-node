/**
 * A small WebSocket client for the WebSocket examples and the option tour.
 *
 * It is the platform `WebSocket` — the same one a browser has, plus Bun's
 * `ping`/`pong`/`pause`/`resume` extensions — wrapped only enough to buffer
 * what arrives and record how the connection ended, so an example can wait on
 * "the client received X" instead of wiring event listeners every time.
 */
import { waitFor } from "../../shared/console";

/** How a connection ended, as the client saw it. */
export interface ClientClose {
  /** The close code received; `1006` when the socket was dropped without a close frame. */
  code: number;
  /** The close reason, `""` when none was sent. */
  reason: string;
  /** Whether the closing handshake completed. */
  wasClean: boolean;
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  /** Extra headers sent with the upgrade request. */
  headers?: Record<string, string>;
  /**
   * Whether the client offers `permessage-deflate`. Omitted means Bun's
   * default, which is to offer it.
   */
  perMessageDeflate?: boolean;
  /**
   * Subprotocols offered, in order, as one `Sec-WebSocket-Protocol` header.
   * The one the server chose is `client.socket.protocol`. Default: none.
   */
  protocols?: string[];
}

/** A connected client and everything it has received. */
export interface Client {
  /** The underlying platform `WebSocket`. */
  socket: WebSocket;
  /** Every message received, in order: text as `string`, binary as `Uint8Array`. */
  messages: (string | Uint8Array)[];
  /** How the connection closed; `undefined` while it is still open. */
  closed: ClientClose | undefined;
  /** The text messages received so far, in order. */
  texts: () => string[];
  /**
   * Resolves with the first text message (already received or still to come)
   * that satisfies `predicate`. `what` names it in the timeout error.
   */
  waitForText: (
    what: string,
    predicate: (text: string) => boolean,
  ) => Promise<string>;
  /** Resolves with how the connection closed, once it has. */
  waitClosed: (options?: {
    /** Give up after this many milliseconds. Defaults to `15000`. */
    timeout?: number;
  }) => Promise<ClientClose>;
}

/**
 * Opens a WebSocket to `url` and resolves once it is open. Rejects when the
 * server refuses the upgrade (an HTTP response instead of `101`).
 */
export async function connect(
  url: string,
  options: ConnectOptions = {},
): Promise<Client> {
  // Only set what was asked for: Bun treats an explicit
  // `perMessageDeflate: undefined` as `false`.
  // Built in one literal: `protocols` belongs to one branch of the options
  // union, so it cannot be assigned onto an already-typed object.
  const init: Bun.WebSocketOptions = {
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.perMessageDeflate !== undefined
      ? { perMessageDeflate: options.perMessageDeflate }
      : {}),
    ...(options.protocols ? { protocols: options.protocols } : {}),
  };

  const socket = new WebSocket(url, init);
  socket.binaryType = "arraybuffer";

  const client: Client = {
    socket,
    messages: [],
    closed: undefined,
    texts: () => {
      return client.messages.filter(
        (message): message is string => typeof message === "string",
      );
    },
    waitForText: async (what, predicate) => {
      let found: string | undefined;
      await waitFor(what, () => {
        found = client.texts().find(predicate);
        return found !== undefined;
      });
      if (found === undefined) {
        throw new Error(`Never received: ${what}`);
      }
      return found;
    },
    waitClosed: async (waitOptions) => {
      await waitFor(
        `${url} to close`,
        () => {
          return client.closed !== undefined;
        },
        { timeout: waitOptions?.timeout },
      );
      if (!client.closed) {
        throw new Error(`${url} never closed`);
      }
      return client.closed;
    },
  };

  socket.addEventListener("message", (event) => {
    // `binaryType` is "arraybuffer", so a frame is text or an ArrayBuffer.
    const data: string | ArrayBuffer = event.data;
    client.messages.push(
      typeof data === "string" ? data : new Uint8Array(data),
    );
  });

  socket.addEventListener("close", (event) => {
    client.closed = {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    };
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`The server refused the upgrade: ${url}`)),
      { once: true },
    );
  });

  return client;
}

/** The head of an upgrade response, exactly as the server wrote it. */
export interface UpgradeHead {
  /** The status line, e.g. `HTTP/1.1 101 Switching Protocols`. */
  statusLine: string;
  /** Every header line in wire order, names lower-cased, duplicates kept. */
  headers: [name: string, value: string][];
  /** Every value of the header `name` (lower-case), in wire order. */
  values: (name: string) => string[];
}

/**
 * Sends an upgrade request for `url` (`ws://host:port/path`) over a plain TCP
 * socket and returns the response head. A `WebSocket` exposes only the
 * negotiated protocol, so this is how an example shows every header of a
 * `101`. `protocols` become one `Sec-WebSocket-Protocol` offer.
 */
export async function upgradeHead(
  url: string,
  protocols: string[] = [],
): Promise<UpgradeHead> {
  const target = new URL(url);
  let buffered = "";
  const head = Promise.withResolvers<string>();
  const socket = await Bun.connect({
    hostname: target.hostname,
    port: Number(target.port),
    socket: {
      data(_socket, chunk) {
        buffered += chunk.toString("latin1");
        const end = buffered.indexOf("\r\n\r\n");
        if (end !== -1) {
          head.resolve(buffered.slice(0, end));
        }
      },
      close() {
        head.reject(new Error(`closed before a response head: ${url}`));
      },
      error(_socket, error) {
        head.reject(error);
      },
    },
  });
  socket.write(
    [
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
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
    const [statusLine = "", ...lines] = (await head.promise).split("\r\n");
    const headers = lines.map((line): [string, string] => {
      const colon = line.indexOf(":");
      return [
        line.slice(0, colon).trim().toLowerCase(),
        line.slice(colon + 1).trim(),
      ];
    });
    return {
      statusLine,
      headers,
      values: (name) =>
        headers.filter(([key]) => key === name).map(([, value]) => value),
    };
  } finally {
    socket.end();
  }
}
