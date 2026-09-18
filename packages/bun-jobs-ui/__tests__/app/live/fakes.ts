import type {
  JobsApiClientMessage,
  JobsApiServerMessage,
} from "../../../app/api/types";
import type { LiveSocket, LiveTimers } from "../../../app/live/client";

/**
 * A fake WebSocket and fake timers for driving `LiveClient` frame by frame:
 * the test plays the server, sending the frames `lib/api/ws/session.ts` sends.
 */

/** Timers the test advances by hand. */
export class FakeTimers implements LiveTimers {
  /** The fake clock, epoch ms. */
  current = 1_000_000;
  /** Pending timers by handle. */
  readonly #timers = new Map<number, { at: number; callback: () => void }>();
  /** The next handle. */
  #next = 1;

  now = (): number => this.current;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const handle = this.#next++;
    this.#timers.set(handle, { at: this.current + ms, callback });
    return handle;
  };

  clearTimeout = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  /** Delays of the pending timers, from now, ascending. */
  pending(): number[] {
    return [...this.#timers.values()]
      .map((timer) => timer.at - this.current)
      .sort((a, b) => a - b);
  }

  /** Moves the clock forward, running every timer that falls due, in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let dueHandle: number | undefined;
      let due: { at: number; callback: () => void } | undefined;
      for (const [handle, timer] of this.#timers) {
        if (timer.at <= target && (!due || timer.at < due.at)) {
          due = timer;
          dueHandle = handle;
        }
      }
      if (!due || dueHandle === undefined) {
        break;
      }
      this.#timers.delete(dueHandle);
      this.current = Math.max(this.current, due.at);
      due.callback();
    }
    this.current = target;
  }
}

/** A socket the test plays the server for. */
export class FakeSocket implements LiveSocket {
  /** Every socket created, in order. */
  static instances: FakeSocket[] = [];

  /** The latest socket. */
  static get last(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) {
      throw new Error("no socket was created");
    }
    return socket;
  }

  readyState = 0;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  /** Frames the client sent, parsed. */
  readonly sent: JobsApiClientMessage[] = [];
  /** The code the client closed with, if it did. */
  closedWith: number | undefined;

  constructor(
    /** The URL asked for. */
    readonly url: string,
    /** The subprotocols offered. */
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as JobsApiClientMessage);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  /** The server accepts the upgrade. */
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** The server sends a frame. */
  receive(frame: JobsApiServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The connection closes (`1006` = no close frame, as a refused upgrade looks). */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Sent frames of one op. */
  ops<T extends JobsApiClientMessage["op"]>(
    op: T,
  ): Extract<JobsApiClientMessage, { op: T }>[] {
    return this.sent.filter(
      (frame): frame is Extract<JobsApiClientMessage, { op: T }> =>
        frame.op === op,
    );
  }

  /** Acks every subscribe/unsubscribe not yet acked, accepting everything. */
  ackAll(
    extra: {
      /** `resumed`, for subscribes that carried `resume`. */
      resumed?: boolean;
      /** The `seq` to report. */
      seq?: number;
    } = {},
  ): void {
    for (const frame of this.sent.splice(0)) {
      if (frame.op === "ping") {
        continue;
      }
      this.receive({
        type: "ack",
        id: frame.id,
        op: frame.op,
        channels: frame.channels,
        ...(frame.op === "subscribe" &&
        frame.resume &&
        extra.resumed !== undefined
          ? { resumed: extra.resumed }
          : {}),
        seq: extra.seq ?? 0,
      });
    }
  }
}

/** A `hello` frame. */
export function hello(
  overrides: Partial<Extract<JobsApiServerMessage, { type: "hello" }>> = {},
): Extract<JobsApiServerMessage, { type: "hello" }> {
  return {
    type: "hello",
    protocol: 1,
    sessionId: "s1",
    epoch: "e1",
    seq: 0,
    mode: "both",
    heartbeatMs: 25_000,
    maxSubscriptions: 50,
    events: "local",
    ...overrides,
  };
}

/** An `event` frame for a queue event. */
export function queueEvent(
  seq: number,
  subscriptions: string[],
  type: "added" | "completed" | "active" = "completed",
  options: {
    /** The queue. */
    queue?: string;
    /** The job id. */
    id?: string;
    /** The epoch. */
    epoch?: string;
  } = {},
): Extract<JobsApiServerMessage, { type: "event" }> {
  const id = options.id ?? "1";
  return {
    type: "event",
    seq,
    epoch: options.epoch ?? "e1",
    subscriptions,
    event:
      type === "completed"
        ? {
            v: 1,
            kind: "queue",
            type,
            target: options.queue ?? "emails",
            id,
            at: 0,
            payload: { id, returnValue: null },
          }
        : {
            v: 1,
            kind: "queue",
            type,
            target: options.queue ?? "emails",
            id,
            at: 0,
            payload: { id },
          },
  };
}

/** Lets the client's microtask-coalesced reconcile run. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await Promise.resolve();
  }
}
