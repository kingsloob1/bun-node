/**
 * A small client for the management API's live-events socket.
 *
 * It is the platform `WebSocket`, wrapped only enough to parse each frame as
 * the protocol's `JobsApiServerMessage` and to let an example wait for "the
 * frame I care about" instead of wiring listeners every time. The message
 * types are exported by `@kingsleyweb/bun-jobs` precisely so a client can be
 * written against them.
 */
import type {
  JobsApiClientMessage,
  JobsApiServerMessage,
} from "@kingsleyweb/bun-jobs";
import { waitFor } from "../../shared/console";

/** One kind of server frame, narrowed by its `type`. */
export type Frame<T extends JobsApiServerMessage["type"]> = Extract<
  JobsApiServerMessage,
  { type: T }
>;

/** How the connection ended. */
export interface SocketClose {
  /** The close code; `1006` when the socket was dropped without a close frame. */
  code: number;
  /** The reason the server gave, `""` when none. */
  reason: string;
}

/** Options for {@link connectJobsSocket}. */
export interface ConnectOptions {
  /** Headers sent with the upgrade request, e.g. an `authorization` token. */
  headers?: Record<string, string>;
  /** Subprotocols to offer. The API accepts `bun-jobs.v1`, or none at all. */
  protocols?: string[];
}

/** A connected client and everything it has received. */
export interface JobsSocket {
  /** The underlying `WebSocket`. */
  socket: WebSocket;
  /** Every frame received, parsed, in order. */
  frames: JobsApiServerMessage[];
  /** How the connection closed, or `undefined` while it is open. */
  closed: SocketClose | undefined;
  /** Sends one client message (`subscribe`, `unsubscribe`, `ping`). */
  send: (message: JobsApiClientMessage) => void;
  /** Every frame of one type received so far. */
  all: <T extends JobsApiServerMessage["type"]>(type: T) => Frame<T>[];
  /**
   * Resolves with the first frame of `type` matching `predicate` — one already
   * received, or the next to arrive. Rejects, naming `type`, if none does.
   */
  next: <T extends JobsApiServerMessage["type"]>(
    type: T,
    predicate?: (frame: Frame<T>) => boolean,
  ) => Promise<Frame<T>>;
  /** Resolves once the connection has closed, with how it ended. */
  waitClosed: () => Promise<SocketClose>;
  /** Closes the connection from this side. */
  close: () => void;
}

/**
 * Opens a client to a management API's socket and resolves once it is open.
 *
 * Rejects when the server refuses the upgrade — the guard answers an ordinary
 * HTTP problem response (401, 403, 404, 429) before any socket exists, so a
 * refusal arrives as an `error` event rather than a close code.
 */
export async function connectJobsSocket(
  url: string,
  options: ConnectOptions = {},
): Promise<JobsSocket> {
  const socket = new WebSocket(url, {
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.protocols ? { protocols: options.protocols } : {}),
  } as unknown as string[]);

  const client: JobsSocket = {
    socket,
    frames: [],
    closed: undefined,
    send: (message) => socket.send(JSON.stringify(message)),
    all: <T extends JobsApiServerMessage["type"]>(type: T) =>
      client.frames.filter((frame): frame is Frame<T> => frame.type === type),
    next: async (type, predicate) => {
      let found: JobsApiServerMessage | undefined;
      await waitFor(`a ${type} frame`, () => {
        found = client
          .all(type)
          .find((frame) => !predicate || predicate(frame as never));
        return found !== undefined;
      });
      return found as never;
    },
    waitClosed: async () => {
      await waitFor(`${url} to close`, () => client.closed !== undefined);
      return client.closed!;
    },
    close: () => socket.close(),
  };

  socket.addEventListener("message", (event) => {
    client.frames.push(JSON.parse(String(event.data)) as JobsApiServerMessage);
  });
  socket.addEventListener("close", (event) => {
    client.closed = { code: event.code, reason: event.reason };
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`The upgrade was refused: ${url}`)),
      { once: true },
    );
  });

  return client;
}
