/**
 * The WebSocket differential's harness (NestJS 12 parity plan, §9.2 item 3):
 * boots one gateway module on `@nestjs/platform-ws`'s `WsAdapter` (over
 * `@nestjs/platform-express`) and on bun-nest's `BunWebSocketAdapter`, and
 * reads both wires into one shape, so a test compares what happened, not the
 * bytes. The two wires differ by design: platform-ws sends `{ event, data }`
 * JSON, ours socket.io-shaped packets (`MessageEventTypes`).
 *
 * Each side reads only its own wire: a frame of the other format reads as
 * `raw`. That is what makes the exception-frame patch (Q4 (a),
 * `routeWsExceptionsThroughEmit`) observable: without it, Nest 12 writes
 * platform-ws's frame to our clients, which our side reads as `raw`.
 */
import type {
  DynamicModule,
  INestApplication,
  LoggerService,
  Provider,
  Type,
} from "@nestjs/common";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import { BunHttpAdapter } from "../../lib/BunHttpAdapter";
import { MessageEventTypes } from "../../lib/BunWebSocketAdapter";

/** `ws`: platform-ws's `WsAdapter`, the reference. `bun`: ours. */
export type Side = "ws" | "bun";

/** Both sides, the reference first. */
export const SIDES: readonly Side[] = ["ws", "bun"];

/** A frame as a test reads it, whichever wire it came over. */
export type Frame =
  | {
      /** An event: a gateway's `WsResponse`, a pushed event, an `exception`. */
      kind: "event";
      /** The event name. */
      event: string;
      /** Its payload. */
      data: unknown;
    }
  | {
      /** Our `ACK`: platform-ws has no acks, and sends a plain reply instead. */
      kind: "ack";
      /** What the ack was called with. */
      data: unknown[];
    }
  | {
      /** Our `ERROR` packet. */
      kind: "error";
      /** Its message. */
      data: unknown;
    }
  | {
      /** Anything else: a plain reply on platform-ws, a foreign frame on ours. */
      kind: "raw";
      /** The frame, parsed when it is JSON. */
      data: unknown;
    };

/** Encodes what a client sends, and decodes what it receives, on one side. */
export interface Wire {
  /** An event frame; `ackId` asks ours for an ack (platform-ws has none). */
  encode: (event: string, data: unknown, ackId?: number) => string;
  /** An event frame whose payload is already JSON (`JSON.stringify` may not manage it). */
  encodeJson: (event: string, dataJson: string) => string;
  /** Reads a received frame. */
  decode: (raw: string) => Frame;
}

/** Parses JSON, or answers the text itself. */
function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Whether `value` is a non-null object (not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** platform-ws's wire: `{ event, data }` both ways. */
const WS_WIRE: Wire = {
  encode: (event, data) => JSON.stringify({ event, data }),
  encodeJson: (event, dataJson) =>
    `{"event":${JSON.stringify(event)},"data":${dataJson}}`,
  decode: (raw) => {
    const value = parse(raw);
    return isRecord(value) && typeof value.event === "string"
      ? { kind: "event", event: value.event, data: value.data }
      : { kind: "raw", data: value };
  },
};

/** Ours: socket.io-shaped packets; anything without a numeric `type` is foreign. */
const BUN_WIRE: Wire = {
  encode: (event, data, ackId) =>
    JSON.stringify({
      type: MessageEventTypes.EVENT,
      namespace: "/",
      data: [event, data],
      ...(ackId === undefined ? {} : { id: ackId }),
    }),
  encodeJson: (event, dataJson) =>
    `{"type":${MessageEventTypes.EVENT},"namespace":"/","data":[${JSON.stringify(event)},${dataJson}]}`,
  decode: (raw) => {
    const value = parse(raw);
    if (!isRecord(value) || typeof value.type !== "number") {
      return { kind: "raw", data: value };
    }
    const data = Array.isArray(value.data) ? value.data : [];
    const type: MessageEventTypes = value.type;
    switch (type) {
      case MessageEventTypes.EVENT:
      case MessageEventTypes.BINARY_EVENT:
        return {
          kind: "event",
          event: String(data[0]),
          data: data.length <= 2 ? data[1] : data.slice(1),
        };
      case MessageEventTypes.ACK:
      case MessageEventTypes.BINARY_ACK:
        return { kind: "ack", data };
      case MessageEventTypes.ERROR:
        return { kind: "error", data: value.data };
      default:
        return { kind: "raw", data: value };
    }
  },
};

/** Each side's wire. */
export const WIRES: Record<Side, Wire> = { ws: WS_WIRE, bun: BUN_WIRE };

/**
 * Sends an event to a client from gateway code (a connection hook, a
 * filter), in the wire of the side the app runs on: platform-ws's client is
 * a `ws` socket, whose `emit` only dispatches locally, and ours has an
 * `emit` that sends. A DI token; each boot provides its side's.
 */
export abstract class Push {
  /** Sends `event` with `data` to `client`. */
  abstract send(client: unknown, event: string, data: unknown): void;
}

/** {@link Push} per side. */
const PUSHES: Record<Side, Push> = {
  ws: {
    send: (client, event, data) =>
      (client as { send: (frame: string) => void }).send(
        JSON.stringify({ event, data }),
      ),
  },
  bun: {
    send: (client, event, data) =>
      (client as { emit: (event: string, data: unknown) => void }).emit(
        event,
        data,
      ),
  },
};

/** What gateway code records as it runs; read by the tests. A singleton per app. */
@Injectable()
export class Trail {
  /** Entries in the order they were recorded. */
  readonly entries: unknown[] = [];

  /** Records one entry. */
  add(entry: unknown): void {
    this.entries.push(entry);
  }

  /** The entries with this `tag` (an entry's first element, when it is an array). */
  tagged(tag: string): unknown[] {
    return this.entries.filter(
      (entry) => Array.isArray(entry) && entry[0] === tag,
    );
  }
}

/** Every message the apps logged, by level, while a capture is installed. */
export interface LogLine {
  /** `log`, `error`, `warn`, `debug`, `verbose` or `fatal`. */
  level: string;
  /** The message, as text. */
  message: string;
}

/** A Nest logger that keeps what it is given. */
class CaptureLogger implements LoggerService {
  /** What was logged. */
  readonly lines: LogLine[] = [];

  /** Keeps one line. */
  private keep(level: string, message: unknown): void {
    this.lines.push({
      level,
      message: message instanceof Error ? message.message : String(message),
    });
  }

  log(message: unknown) {
    this.keep("log", message);
  }

  error(message: unknown) {
    this.keep("error", message);
  }

  warn(message: unknown) {
    this.keep("warn", message);
  }

  debug(message: unknown) {
    this.keep("debug", message);
  }

  verbose(message: unknown) {
    this.keep("verbose", message);
  }

  fatal(message: unknown) {
    this.keep("fatal", message);
  }
}

/**
 * The one logger of every boot. Nest routes every `Logger` instance (the
 * adapters', `WsExceptionsHandler`'s) through the static logger the last
 * created app installed, so a logger per app would collect another app's
 * lines; the cases run one side at a time, and read the lines a step added.
 */
const sharedLogger = new CaptureLogger();

/** The flow-control options both adapters take (platform-ws 12.2.0's names). */
export interface FlowOptions {
  /** Messages of one client handled at once. */
  maxConcurrentMessages?: number;
  /** Bytes queued for a client before it is disconnected; `0` lifts it. */
  maxSendBufferSize?: number;
}

/** One booted side. */
export interface Booted {
  /** Which adapter. */
  side: Side;
  /** The application. */
  app: INestApplication;
  /** `ws://127.0.0.1:<port>`. */
  base: string;
  /** The port, for a raw socket. */
  port: number;
  /** The app's {@link Trail}. */
  trail: Trail;
  /** What the apps logged (shared by every boot; see {@link sharedLogger}). */
  logs: LogLine[];
  /** The side's wire. */
  wire: Wire;
}

/** The root module of every boot; the providers come in through `boot`. */
@Module({})
class CompatRoot {}

/**
 * Boots `gateways` (with {@link Trail}, {@link Push} and `providers`) on one
 * side. platform-ws rides Express's `node:http` server (under Bun), ours
 * `BunHttpAdapter`; the flow options go to `new WsAdapter(app, flow)` and to
 * `BunHttpAdapter`'s `websocket` option respectively.
 */
export async function boot(
  side: Side,
  gateways: Type[],
  options: { flow?: FlowOptions; providers?: Provider[] } = {},
): Promise<Booted> {
  const logger = sharedLogger;
  const root: DynamicModule = {
    module: CompatRoot,
    providers: [
      ...gateways,
      ...(options.providers ?? []),
      Trail,
      { provide: Push, useValue: PUSHES[side] },
    ],
  };
  let app: INestApplication;
  if (side === "ws") {
    app = await NestFactory.create(root, new ExpressAdapter(), { logger });
    // platform-ws < 12.2.0 declares neither option (and ignores both).
    const wsOptions = options.flow as unknown as ConstructorParameters<
      typeof WsAdapter
    >[1];
    app.useWebSocketAdapter(new WsAdapter(app, wsOptions));
  } else {
    const adapter = new BunHttpAdapter(0, { websocket: options.flow });
    app = await NestFactory.create(root, adapter, { logger });
    app.useWebSocketAdapter(adapter.webSocketAdapter);
  }
  await app.listen(0, "127.0.0.1");
  const port = Number(new URL(await app.getUrl()).port);
  return {
    side,
    app,
    base: `ws://127.0.0.1:${port}`,
    port,
    trail: app.get(Trail),
    logs: logger.lines,
    wire: WIRES[side],
  };
}

/** A connected test client. */
export interface Client {
  /** The browser-style socket. */
  socket: WebSocket;
  /** Every frame received, decoded. */
  frames: Frame[];
  /** Sends an event frame (with an ack id, on ours). */
  send: (event: string, data: unknown, ackId?: number) => void;
  /** Sends an event frame whose payload is given as JSON text. */
  sendJson: (event: string, dataJson: string) => void;
  /** Resolves with the first frame (received or to come) that `predicate` accepts. */
  waitFor: (
    predicate: (frame: Frame) => boolean,
    ms?: number,
  ) => Promise<Frame>;
  /** Resolves with the close event once the connection has closed. */
  closed: Promise<{ code: number; reason: string }>;
  /** Closes it (with `code`/`reason`) and waits for the close. */
  close: (code?: number, reason?: string) => Promise<void>;
}

/**
 * Opens a client on `path` of `booted`. Rejects when the upgrade is refused
 * or does not open within `ms`.
 */
export async function connect(
  booted: Booted,
  path = "/",
  ms = 5000,
): Promise<Client> {
  const socket = new WebSocket(`${booted.base}${path}`);
  const frames: Frame[] = [];
  const waiters: {
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
  }[] = [];
  socket.addEventListener("message", (event) => {
    const frame = booted.wire.decode(String(event.data));
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`${booted.side}: ${path} did not open in ${ms} ms`)),
      ms,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${booted.side}: ${path} was refused`));
    });
  });
  return {
    socket,
    frames,
    closed,
    send: (event, data, ackId) =>
      socket.send(booted.wire.encode(event, data, ackId)),
    sendJson: (event, dataJson) =>
      socket.send(booted.wire.encodeJson(event, dataJson)),
    waitFor: (predicate, waitMs = 5000) =>
      new Promise<Frame>((resolve, reject) => {
        const found = frames.find(predicate);
        if (found) {
          resolve(found);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter = {
          predicate,
          resolve: (frame: Frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        };
        timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(
            new Error(
              `${booted.side}: no matching frame in ${waitMs} ms; got ${JSON.stringify(frames)}`,
            ),
          );
        }, waitMs);
        waiters.push(waiter);
      }),
    close: async (code, reason) => {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.close(code, reason);
      }
      await closed;
    },
  };
}

/** Polls `read` until `accept` takes its value, or rejects after `ms`. */
export async function until<T>(
  read: () => T,
  accept: (value: T) => boolean,
  ms = 5000,
  what = "a condition",
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) {
      return value;
    }
    if (Date.now() > end) {
      throw new Error(
        `timed out after ${ms} ms waiting for ${what}; last: ${JSON.stringify(value)}`,
      );
    }
    await Bun.sleep(5);
  }
}

/**
 * A client over a raw TCP socket, for the backpressure cases: unlike
 * `WebSocket`, it can stop reading (`pause()`), so what the server sends
 * piles up in the kernel and then in the server's own queue.
 */
export interface RawClient {
  /** Sends a masked text frame. */
  sendText: (text: string) => void;
  /**
   * Sends several masked text frames in one write, so the server reads them
   * in one go: what a burst looks like, and what pausing the socket alone
   * cannot hold back (the server hands over every message of a read).
   */
  sendTexts: (texts: string[]) => void;
  /** Stops reading from the socket. */
  pause: () => void;
  /** Starts reading again. */
  resume: () => void;
  /** Text frames received so far. */
  texts: string[];
  /** Resolves once the connection has ended or closed, either side. */
  ended: Promise<void>;
  /** Whether it has ended. */
  isEnded: () => boolean;
  /** Destroys the socket. */
  destroy: () => void;
}

/** Opens a raw WebSocket client on `path` of the server at `port`. */
export async function connectRaw(port: number, path = "/"): Promise<RawClient> {
  const socket = net.connect(port, "127.0.0.1");
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let ended = false;
  const texts: string[] = [];
  let resolveEnded!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const markEnded = () => {
    ended = true;
    resolveEnded();
  };
  socket.on("end", markEnded);
  socket.on("close", markEnded);
  socket.on("error", markEnded);

  /** Reads every complete frame at the head of `buffer`. */
  const readFrames = () => {
    for (;;) {
      if (buffer.length < 2) {
        return;
      }
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) {
        return;
      }
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x1) {
        texts.push(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        markEnded();
      }
    }
  };

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        resolve();
      }
      readFrames();
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

  return {
    texts,
    ended: endedPromise,
    isEnded: () => ended,
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    destroy: () => socket.destroy(),
    sendText: (text) => {
      socket.write(maskedFrame(text));
    },
    sendTexts: (texts) => {
      socket.write(Buffer.concat(texts.map(maskedFrame)));
    },
  };
}

/** A client's text frame: masked, as RFC 6455 requires of a client. */
function maskedFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : payload.length < 65536
        ? Buffer.from([
            0x81,
            0x80 | 126,
            payload.length >> 8,
            payload.length & 0xff,
          ])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 0x80 | 127;
            h.writeBigUInt64BE(BigInt(payload.length), 2);
            return h;
          })();
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i] ^ mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * Whether the installed platform-ws has 12.2.0's flow control
 * (`maxConcurrentMessages`, `maxSendBufferSize`): read off an instance, a
 * capability, never a version string (plan §8.3).
 */
export function referenceHasFlowControl(): boolean {
  const probe = new WsAdapter({}) as unknown as Record<string, unknown>;
  return (
    typeof probe.maxConcurrentMessages === "number" &&
    typeof probe.maxSendBufferSize === "number"
  );
}
