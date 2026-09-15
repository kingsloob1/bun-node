/**
 * A small WebSocket client for the WebSocket examples: it speaks the adapter's
 * wire format (`MessageEventTypes` packets as JSON text), buffers every frame
 * it receives, and waits on conditions rather than sleeping.
 *
 * `connect<Receives, Sends>(url)` optionally types it: `Receives` maps each
 * event the server sends to its payload, `Sends` each event the client emits.
 * Both default to "any event, any payload".
 *
 * Not an example on its own — `run-all.ts` skips `fixtures/`.
 */
import type { MessageEventType } from "@kingsleyweb/bun-nest";
import { MessageEventTypes } from "@kingsleyweb/bun-nest";
import { waitFor } from "../../shared/console";

/** One protocol packet as it travels on the wire, in either direction. */
export interface WirePacket {
  /** The packet type — a `MessageEventTypes` ordinal. */
  type: MessageEventTypes;
  /**
   * The namespace the packet names. The adapter echoes it back in replies; it
   * routes by the connection's URL path, not by this field.
   */
  namespace: string;
  /** On an `EVENT`, asks for an `ACK`; on an `ACK`, names what it answers. */
  id?: string | number;
  /**
   * `[event, payload]` for events, the ack arguments for acks, text for errors.
   * Deliberately untyped: this is any frame, including the malformed ones the
   * examples send on purpose. Narrow a received one with a type-guard predicate.
   */
  data?: unknown;
  /** On a `BINARY_EVENT`/`BINARY_ACK`, the positions of the base64 arguments. */
  binary?: number[];
}

/** Event name → the payload that event carries (`data[1]` of its packet). */
export type EventPayloads = Record<string, unknown>;

/** An `EVENT` packet named `TEvent` carrying one `TPayload`. */
export type EventPacket<
  TEvent extends string = string,
  TPayload = unknown,
> = MessageEventType<TEvent, [payload: TPayload]>;

/** The events of `TEvents` whose payload may be left out. */
export type PayloadlessEvent<TEvents extends EventPayloads> = {
  [K in keyof TEvents & string]: undefined extends TEvents[K] ? K : never;
}[keyof TEvents & string];

/** How a socket closed. */
export interface CloseInfo {
  /** The close code, e.g. `1000`. */
  code: number;
  /** The close reason, `""` when none was given. */
  reason: string;
}

/** Options for {@link connect}. */
export interface ConnectOptions {
  /** Give up opening after this many milliseconds. Defaults to `5000`. */
  timeout?: number;
}

/** Options for {@link WsClient.emit}. */
export interface EmitOptions {
  /** Ack id; the handler's `@Ack()` callback answers with an `ACK` of this id. */
  id?: string | number;
  /** The packet's namespace field. Defaults to `"/"`. */
  namespace?: string;
}

/**
 * A connected client. `TReceives` types what the server sends, `TSends` what
 * {@link emit} accepts; see {@link EventPayloads}.
 */
export interface WsClient<
  TReceives extends EventPayloads = EventPayloads,
  TSends extends EventPayloads = EventPayloads,
> {
  /** The Bun `WebSocket` underneath. */
  socket: WebSocket;
  /** Every frame received, parsed from JSON; a frame that is not JSON is kept as text. */
  frames: (WirePacket | string)[];
  /** Sends a packet as JSON text, or a string or bytes exactly as given. */
  send: (frame: WirePacket | string | Uint8Array) => void;
  /** Sends an `EVENT` packet carrying `[event, payload]`. */
  emit: (<TEvent extends keyof TSends & string>(
    event: TEvent,
    payload: TSends[TEvent],
    options?: EmitOptions,
  ) => void) &
    (<TEvent extends PayloadlessEvent<TSends>>(event: TEvent) => void);
  /**
   * Resolves with the first received packet matching a type-guard `predicate`,
   * narrowed to what it asserts, waiting if needed.
   */
  next: (<TPacket extends WirePacket>(
    what: string,
    predicate: (packet: WirePacket) => packet is TPacket,
  ) => Promise<TPacket>) &
    ((
      what: string,
      predicate: (packet: WirePacket) => boolean,
    ) => Promise<WirePacket>);
  /** Resolves with the first `EVENT` packet named `event`. */
  nextEvent: <TEvent extends keyof TReceives & string>(
    event: TEvent,
  ) => Promise<EventPacket<TEvent, TReceives[TEvent]>>;
  /** The payloads of every `EVENT` named `event` received so far, in order. */
  payloadsOf: <TEvent extends keyof TReceives & string>(
    event: TEvent,
  ) => TReceives[TEvent][];
  /** Packets received so far (text frames that were not JSON are left out). */
  packets: () => WirePacket[];
  /** How the socket closed, once it has; `undefined` while open. */
  closed: () => CloseInfo | undefined;
  /** Closes the socket (optionally with a code and reason) and resolves once closed. */
  close: (code?: number, reason?: string) => Promise<CloseInfo>;
}

/** The event name of an `EVENT`/`BINARY_EVENT` packet, if it has one. */
export function eventName(packet: WirePacket): string | undefined {
  return Array.isArray(packet.data) ? String(packet.data[0]) : undefined;
}

/** The payload of an `EVENT` packet — the second element of `data`. */
export function eventPayload<TPayload>(
  packet: EventPacket<string, TPayload>,
): TPayload;
/** The payload of any packet that has one; `undefined` otherwise. */
export function eventPayload(packet: WirePacket): unknown;
export function eventPayload(packet: WirePacket): unknown {
  return Array.isArray(packet.data) ? packet.data[1] : undefined;
}

/** Whether a parsed frame looks like a protocol packet. */
function isPacket(value: unknown): value is WirePacket {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "number"
  );
}

/**
 * Opens a client to `url`. Resolves once it is open, or with `undefined` when
 * the server refused the upgrade (no route, a 401 from middleware, …).
 */
export async function tryConnect<
  TReceives extends EventPayloads = EventPayloads,
  TSends extends EventPayloads = EventPayloads,
>(
  url: string,
  options: ConnectOptions = {},
): Promise<WsClient<TReceives, TSends> | undefined> {
  const socket = new WebSocket(url);
  const frames: (WirePacket | string)[] = [];
  let closeInfo: CloseInfo | undefined;

  socket.addEventListener("message", (event) => {
    const text =
      typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    try {
      // Unchecked until `isPacket` has looked at it.
      const parsed: unknown = JSON.parse(text);
      frames.push(isPacket(parsed) ? parsed : text);
    } catch {
      frames.push(text);
    }
  });

  socket.addEventListener("close", (event) => {
    closeInfo = { code: event.code, reason: event.reason };
  });

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(resolve, options.timeout ?? 5_000, false);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!opened) {
    return undefined;
  }

  const packets = (): WirePacket[] => {
    return frames.filter((frame): frame is WirePacket => isPacket(frame));
  };

  /**
   * Whether `packet` is the `EVENT` named `event`. Its payload is taken to be
   * what `TReceives` declares for it — the declaration is the caller's word.
   */
  const isEvent = <TEvent extends keyof TReceives & string>(
    packet: WirePacket,
    event: TEvent,
  ): packet is EventPacket<TEvent, TReceives[TEvent]> => {
    return (
      packet.type === MessageEventTypes.EVENT && eventName(packet) === event
    );
  };

  const send = (frame: WirePacket | string | Uint8Array): void => {
    socket.send(
      typeof frame === "string" || frame instanceof Uint8Array
        ? frame
        : JSON.stringify(frame),
    );
  };

  function next<TPacket extends WirePacket>(
    what: string,
    predicate: (packet: WirePacket) => packet is TPacket,
  ): Promise<TPacket>;
  function next(
    what: string,
    predicate: (packet: WirePacket) => boolean,
  ): Promise<WirePacket>;
  async function next(
    what: string,
    predicate: (packet: WirePacket) => boolean,
  ): Promise<WirePacket> {
    await waitFor(what, () => packets().some(predicate), { timeout: 5_000 });
    return packets().find(predicate)!;
  }

  const client: WsClient<TReceives, TSends> = {
    socket,
    frames,
    send,
    emit(event: string, payload?: unknown, emitOptions: EmitOptions = {}) {
      const packet: WirePacket = {
        type: MessageEventTypes.EVENT,
        namespace: emitOptions.namespace ?? "/",
        data: [event, payload],
      };
      if (emitOptions.id !== undefined) {
        packet.id = emitOptions.id;
      }
      send(packet);
    },
    next,
    nextEvent(event) {
      return next(`an "${event}" event`, (packet) => isEvent(packet, event));
    },
    payloadsOf(event) {
      return packets()
        .filter((packet) => isEvent(packet, event))
        .map((packet) => eventPayload(packet));
    },
    packets,
    closed: () => closeInfo,
    async close(code, reason) {
      if (closeInfo) {
        return closeInfo;
      }
      socket.close(code, reason);
      await waitFor(`socket to ${url} to close`, () => closeInfo !== undefined);
      return closeInfo!;
    },
  };

  return client;
}

/** Opens a client to `url`, throwing when the upgrade is refused. */
export async function connect<
  TReceives extends EventPayloads = EventPayloads,
  TSends extends EventPayloads = EventPayloads,
>(
  url: string,
  options: ConnectOptions = {},
): Promise<WsClient<TReceives, TSends>> {
  const client = await tryConnect<TReceives, TSends>(url, options);
  if (!client) {
    throw new Error(`WebSocket upgrade refused: ${url}`);
  }
  return client;
}
