import type { BunRequest, WebSocketClient } from "@kingsleyweb/bun-common";
import type { AuthDecision } from "../auth";
import type {
  JobsApiSocketData,
  ResolvedJobsApiConfig,
  ResolvedJobsApiWebSocketOptions,
} from "../config";
import type { ParsedChannel } from "./channels";
import type { EventHub, HubSubscriber, StampedEvent, WsClock } from "./hub";
import type {
  JobsApiAckRejection,
  JobsApiClientMessage,
  JobsApiGapMessage,
  JobsApiServerMessage,
  JobsApiSubscribeMessage,
  JobsApiUnsubscribeMessage,
  JobsApiWsErrorCode,
} from "./protocol";
import { Buffer } from "node:buffer";
import { decide } from "../auth";
import { validateJson } from "../schema/validate";
import { toEventDto } from "../serialize";
import { parseChannel } from "./channels";
import { ClientMessageSchema, JOBS_API_WS_CLOSE } from "./protocol";

/**
 * One connection: its subscriptions, its limits, and how it copes with a
 * client that cannot keep up.
 *
 * **Limits.** A frame over `maxMessageBytes` is answered with an error and
 * closed `1009`; a binary frame is closed `1003`; more than
 * `messagesPerSecond` (a token bucket, burst of two seconds' worth) is an
 * error, and a second breach within ten seconds closes `1008`.
 *
 * **Backpressure.** `send()` says whether a frame went out (bytes), was queued
 * under backpressure (`-1`) or was dropped (`0`), and the buffered amount says
 * how far behind the client is. Past either threshold the session is
 * lagging*: it stops sending events and counts the ones it skipped. When the
 * socket drains, it sends one `gap` covering them and goes live again — it
 * does not replay, because a client that fell behind must refetch anyway. A
 * session lagging for `slowConsumerTimeoutMs` is closed `4008`.
 */

/** How long after one rate-limit breach a second one closes the socket. */
const RATE_BREACH_WINDOW_MS = 10_000;

/** A socket as the session uses it: the parts of Bun's `ServerWebSocket` it needs. */
export type SessionSocket = Pick<
  WebSocketClient<JobsApiSocketData>,
  "send" | "close" | "getBufferedAmount" | "readyState"
>;

/** What a session is given. */
export interface SessionContext {
  /** The resolved configuration. */
  config: ResolvedJobsApiConfig;
  /** The socket options. */
  options: ResolvedJobsApiWebSocketOptions;
  /** The hub it subscribes through. */
  hub: EventHub;
  /** The clock. */
  clock: WsClock;
  /** Called once the session has ended, however it ended. */
  onEnded: (session: Session) => void;
}

/** The lag being tracked. */
interface Lag {
  /** The first `seq` that may be missing. */
  fromSeq: number;
  /** The last `seq` skipped, once one has been. */
  toSeq: number | undefined;
  /** The slow-consumer timer. */
  timer: unknown;
}

/** `WebSocket.OPEN`. */
const OPEN = 1;

export class Session implements HubSubscriber {
  /** The session's id. */
  readonly id: string;
  /** The upgrade request. */
  readonly request: BunRequest;

  /** The socket. */
  readonly #ws: SessionSocket;
  /** Everything else. */
  readonly #ctx: SessionContext;
  /** Subscribed channels, each with its event-type filter (`undefined` = every type). */
  readonly #channels = new Map<string, ReadonlySet<string> | undefined>();
  /** `authorize` decisions, by channel, for the session's lifetime. */
  readonly #decisions = new Map<string, Promise<AuthDecision>>();
  /** Tokens left in the rate bucket. */
  #tokens: number;
  /** When the bucket was last refilled. */
  #refilledAt: number;
  /** When the rate limit was last breached. */
  #breachedAt: number | undefined;
  /** The lag, while lagging. */
  #lag: Lag | undefined;
  /** The heartbeat timer. */
  #heartbeat: unknown;
  /** Client messages are handled one at a time, in order. */
  #work: Promise<void> = Promise.resolve();
  /** Whether the session has ended. */
  #ended = false;

  constructor(
    /** The connection. */
    ws: SessionSocket,
    /** The session's data: its id and upgrade request. */
    data: JobsApiSocketData,
    /** The hub, configuration and clock. */
    ctx: SessionContext,
  ) {
    this.#ws = ws;
    this.#ctx = ctx;
    this.id = data.sessionId;
    this.request = data.request;
    this.#tokens = ctx.options.messagesPerSecond * 2;
    this.#refilledAt = ctx.clock.now();
  }

  /** The channels subscribed, in subscription order. */
  get subscriptions(): string[] {
    return [...this.#channels.keys()];
  }

  /** Whether events are being held back because the client cannot keep up. */
  get lagging(): boolean {
    return this.#lag !== undefined;
  }

  /** Greets the client and starts the heartbeat. */
  open(): void {
    const { config, options, hub, clock } = this.#ctx;
    this.#send({
      type: "hello",
      protocol: 1,
      sessionId: this.id,
      epoch: hub.epoch,
      seq: hub.seq,
      mode: config.mode,
      heartbeatMs: options.heartbeatMs,
      maxSubscriptions: options.maxSubscriptions,
      events: config.driver.capabilities.events,
    });
    if (options.heartbeatMs > 0) {
      this.#heartbeat = clock.setInterval(() => {
        if (!this.#lag) {
          this.#send({ type: "heartbeat", seq: hub.seq, at: clock.now() });
        }
      }, options.heartbeatMs);
    }
  }

  /** Handles one client frame. Limits are applied on receipt, handling in order. */
  receive(message: string | Buffer): void {
    if (this.#ended) {
      return;
    }
    const { options, clock } = this.#ctx;

    if (typeof message !== "string") {
      this.#error(
        undefined,
        "UNSUPPORTED_DATA",
        400,
        "Frames must be JSON text; binary frames are not accepted",
      );
      this.close(
        JOBS_API_WS_CLOSE.UNSUPPORTED_DATA,
        "binary frames are not accepted",
      );
      return;
    }
    if (Buffer.byteLength(message) > options.maxMessageBytes) {
      this.#error(
        undefined,
        "MESSAGE_TOO_LARGE",
        413,
        `Frames may be at most ${options.maxMessageBytes} bytes`,
      );
      this.close(JOBS_API_WS_CLOSE.TOO_BIG, "message too big");
      return;
    }
    if (!this.#takeToken()) {
      const now = clock.now();
      if (
        this.#breachedAt !== undefined &&
        now - this.#breachedAt < RATE_BREACH_WINDOW_MS
      ) {
        this.close(JOBS_API_WS_CLOSE.POLICY, "rate limit exceeded");
        return;
      }
      this.#breachedAt = now;
      this.#error(
        undefined,
        "RATE_LIMITED",
        429,
        `At most ${options.messagesPerSecond} messages per second; a second breach within ${RATE_BREACH_WINDOW_MS / 1000}s closes the connection`,
      );
      return;
    }

    /**
     * Answers a malformed frame. What was wrong with it describes the
     * protocol's schema, so it is told only to a connection that may
     * subscribe at all: first a target-less `events.subscribe` decision
     * (cached for the session, as the HTTP routes ask `authorize` before
     * reporting validation details), and a denied caller gets a generic
     * 401/403 instead. Queued, so replies keep the order of the frames.
     */
    const malformed = (id: string | undefined, detail: string) => {
      this.#work = this.#work
        .then(async () => {
          let decision = this.#decisions.get("");
          if (!decision) {
            decision = decide(this.#ctx.config, this.request, {
              action: "events.subscribe",
              transport: "ws",
            });
            this.#decisions.set("", decision);
            decision.catch(() => {
              this.#decisions.delete("");
            });
          }
          const answer = await decision;
          if (this.#ended) {
            return;
          }
          if (!answer.allow) {
            this.#error(
              id,
              answer.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
              answer.status,
              "The message was refused",
            );
            return;
          }
          this.#error(id, "VALIDATION", 400, detail);
        })
        .catch((error: unknown) => {
          this.#ctx.config.logger.error(
            "jobs api authorize failed for a frame",
            {
              error,
            },
          );
          this.#error(id, "INTERNAL", 500, "The message could not be handled");
        });
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      malformed(undefined, "Frames must be valid JSON");
      return;
    }
    const result = validateJson(ClientMessageSchema.json, parsed);
    if (result.issues) {
      const id = (parsed as { id?: unknown } | null)?.id;
      malformed(
        typeof id === "string" ? id : undefined,
        result.issues
          .map((issue) => {
            const path = (issue.path ?? []).map(String).join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join("; "),
      );
      return;
    }

    const request = result.value as JobsApiClientMessage;
    this.#work = this.#work
      .then(async () => await this.#handle(request))
      .catch((error: unknown) => {
        this.#ctx.config.logger.error("jobs api socket message failed", {
          error,
          op: request.op,
        });
        this.#error(
          request.id,
          "INTERNAL",
          500,
          "The message could not be handled",
        );
      });
  }

  /** Refills the bucket and takes a token, if one is left. */
  #takeToken(): boolean {
    const { options, clock } = this.#ctx;
    const now = clock.now();
    const capacity = options.messagesPerSecond * 2;
    this.#tokens = Math.min(
      capacity,
      this.#tokens +
        ((now - this.#refilledAt) * options.messagesPerSecond) / 1000,
    );
    this.#refilledAt = now;
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }

  /** Dispatches a validated message. */
  async #handle(message: JobsApiClientMessage): Promise<void> {
    if (this.#ended) {
      return;
    }
    switch (message.op) {
      case "subscribe":
        await this.#subscribe(message);
        return;
      case "unsubscribe":
        this.#unsubscribe(message);
        return;
      default:
        this.#send({ type: "pong", id: message.id, at: this.#ctx.clock.now() });
    }
  }

  /** The cached `authorize` decision for a channel. A thrown `authorize` is not cached. */
  #authorize(channel: ParsedChannel): Promise<AuthDecision> {
    let decision = this.#decisions.get(channel.key);
    if (!decision) {
      decision = decide(this.#ctx.config, this.request, {
        action: "events.subscribe",
        transport: "ws",
        ...channel.target,
      });
      this.#decisions.set(channel.key, decision);
      decision.catch(() => {
        this.#decisions.delete(channel.key);
      });
    }
    return decision;
  }

  /** Subscribes: parse, authorize each channel, apply the cap, resume, ack. */
  async #subscribe(message: JobsApiSubscribeMessage): Promise<void> {
    const { config, options, hub } = this.#ctx;

    try {
      await hub.open();
    } catch (error) {
      config.logger.warn("jobs api could not open its event source", {
        error,
      });
      this.#error(
        message.id,
        "EVENTS_UNAVAILABLE",
        503,
        "Live events are unavailable; retry later",
      );
      return;
    }

    const rejected: JobsApiAckRejection[] = [];
    const parsed: ParsedChannel[] = [];
    const seen = new Set<string>();
    for (const raw of message.channels) {
      const result = parseChannel(raw, config);
      if (!result.ok) {
        rejected.push({ channel: raw, ...result.rejection });
      } else if (!seen.has(result.channel.key)) {
        seen.add(result.channel.key);
        parsed.push(result.channel);
      }
    }

    const decisions = await Promise.all(
      parsed.map(async (channel) => {
        try {
          return await this.#authorize(channel);
        } catch (error) {
          config.logger.error("jobs api authorize failed for a subscription", {
            error,
            channel: channel.key,
          });
          return undefined;
        }
      }),
    );
    if (this.#ended) {
      return;
    }

    // From here to the ack nothing awaits, so no event can be stamped between
    // indexing the channels, replaying and going live.
    const accepted: string[] = [];
    let held = this.#channels.size;
    parsed.forEach((channel, index) => {
      const decision = decisions[index];
      if (!decision) {
        rejected.push({
          channel: channel.key,
          code: "INTERNAL",
          status: 500,
          detail: "Authorization failed",
        });
      } else if (!decision.allow) {
        rejected.push({
          channel: channel.key,
          code: decision.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          status: decision.status,
          ...(decision.reason ? { detail: decision.reason } : {}),
        });
      } else if (
        !this.#channels.has(channel.key) &&
        held >= options.maxSubscriptions
      ) {
        rejected.push({
          channel: channel.key,
          code: "SUBSCRIPTION_LIMIT",
          status: 400,
          detail: `At most ${options.maxSubscriptions} subscriptions per connection`,
        });
      } else {
        if (!this.#channels.has(channel.key)) {
          held++;
        }
        accepted.push(channel.key);
      }
    });

    const filter = message.events ? new Set<string>(message.events) : undefined;
    for (const key of accepted) {
      this.#channels.set(key, filter);
      hub.subscribe(this, key);
    }

    let resumed: boolean | undefined;
    let gap: JobsApiGapMessage | undefined;
    if (message.resume) {
      const { epoch, afterSeq } = message.resume;
      const replay =
        accepted.length > 0 ? hub.replay(epoch, afterSeq) : undefined;
      if (replay?.status === "ok") {
        const scope = new Set(accepted);
        for (const stamped of replay.events) {
          this.deliver(
            stamped,
            stamped.keys.filter((key) => scope.has(key)),
          );
        }
        resumed = true;
      } else {
        resumed = false;
        if (replay) {
          gap = {
            type: "gap",
            epoch: hub.epoch,
            fromSeq: replay.status === "epoch-changed" ? 0 : afterSeq + 1,
            toSeq: hub.seq,
            reason: replay.status,
            channels: accepted,
          };
        }
      }
    }

    this.#send({
      type: "ack",
      id: message.id,
      op: "subscribe",
      channels: accepted,
      ...(rejected.length > 0 ? { rejected } : {}),
      ...(resumed === undefined ? {} : { resumed }),
      seq: hub.seq,
    });
    if (gap) {
      this.#send(gap);
    }
  }

  /** Unsubscribes. Leaving a channel not held is not an error. */
  #unsubscribe(message: JobsApiUnsubscribeMessage): void {
    const { config, hub } = this.#ctx;
    const rejected: JobsApiAckRejection[] = [];
    const removed: string[] = [];
    for (const raw of message.channels) {
      const result = parseChannel(raw, config);
      if (!result.ok) {
        rejected.push({ channel: raw, ...result.rejection });
        continue;
      }
      const key = result.channel.key;
      if (!removed.includes(key)) {
        removed.push(key);
      }
      if (this.#channels.delete(key)) {
        hub.unsubscribe(this, key);
      }
    }
    this.#send({
      type: "ack",
      id: message.id,
      op: "unsubscribe",
      channels: removed,
      ...(rejected.length > 0 ? { rejected } : {}),
      seq: hub.seq,
    });
  }

  /**
   * Sends an event matching `keys`, once. Channels whose event-type filter
   * excludes it are dropped from `keys`; with none left nothing is sent.
   * While lagging the event is only counted.
   */
  deliver(stamped: StampedEvent, keys: string[]): void {
    if (this.#ended) {
      return;
    }
    const matched = keys.filter((key) => {
      if (!this.#channels.has(key)) {
        return false;
      }
      const filter = this.#channels.get(key);
      return filter === undefined || filter.has(stamped.event.type);
    });
    if (matched.length === 0) {
      return;
    }
    if (this.#lag) {
      this.#lag.toSeq = stamped.seq;
      return;
    }

    let event;
    try {
      event = toEventDto(
        stamped.event,
        this.request,
        this.#ctx.config.serialize,
      );
    } catch (error) {
      this.#ctx.config.logger.error("jobs api serialize.event failed", {
        error,
        seq: stamped.seq,
      });
      return;
    }
    if (event === null) {
      return;
    }
    this.#send(
      {
        type: "event",
        seq: stamped.seq,
        epoch: this.#ctx.hub.epoch,
        subscriptions: matched,
        event,
      },
      stamped.seq,
    );
  }

  /** The socket drained: when every lagging event is behind us, announce the gap and go live. */
  drain(): void {
    const lag = this.#lag;
    if (!lag || this.#ended) {
      return;
    }
    if (this.#ws.getBufferedAmount() > this.#ctx.options.maxBufferedBytes) {
      return;
    }
    this.#ctx.clock.clearTimeout(lag.timer);
    this.#lag = undefined;
    if (lag.toSeq !== undefined && lag.toSeq >= lag.fromSeq) {
      this.#send({
        type: "gap",
        epoch: this.#ctx.hub.epoch,
        fromSeq: lag.fromSeq,
        toSeq: lag.toSeq,
        reason: "slow-consumer",
        channels: this.subscriptions,
      });
    }
  }

  /**
   * Sends a frame. For an event frame (`seq` given), a buffer already past
   * `maxBufferedBytes` skips it and starts lagging. A frame queued under
   * backpressure (`-1`) starts lagging after it; a dropped one (`0`) starts
   * lagging with it.
   */
  #send(frame: JobsApiServerMessage, seq?: number): void {
    if (this.#ended || this.#ws.readyState !== OPEN) {
      return;
    }
    if (
      seq !== undefined &&
      this.#ws.getBufferedAmount() > this.#ctx.options.maxBufferedBytes
    ) {
      this.#startLag(seq, seq);
      return;
    }
    let sent: number;
    try {
      sent = this.#ws.send(JSON.stringify(frame));
    } catch (error) {
      this.#ctx.config.logger.error("jobs api socket send failed", { error });
      return;
    }
    if (sent === -1) {
      this.#startLag((seq ?? this.#ctx.hub.seq) + 1, undefined);
    } else if (sent === 0) {
      if (seq === undefined) {
        this.#startLag(this.#ctx.hub.seq + 1, undefined);
      } else {
        this.#startLag(seq, seq);
      }
    }
  }

  /** Starts lagging (once), or extends the lag's skipped range. */
  #startLag(fromSeq: number, skipped: number | undefined): void {
    if (this.#lag) {
      if (skipped !== undefined) {
        this.#lag.toSeq = skipped;
      }
      return;
    }
    this.#lag = {
      fromSeq,
      toSeq: skipped,
      timer: this.#ctx.clock.setTimeout(() => {
        this.close(JOBS_API_WS_CLOSE.SLOW_CONSUMER, "slow consumer");
      }, this.#ctx.options.slowConsumerTimeoutMs),
    };
  }

  /** Sends an `error` message. */
  #error(
    id: string | undefined,
    code: JobsApiWsErrorCode,
    status: number,
    detail: string,
  ): void {
    this.#send({
      type: "error",
      ...(id === undefined ? {} : { id }),
      code,
      status,
      detail,
    });
  }

  /** Closes the connection from the server side and ends the session. */
  close(code: number, reason: string): void {
    if (this.#ended) {
      return;
    }
    this.ended();
    try {
      this.#ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Ends the session: leaves every channel and stops every timer. Idempotent. */
  ended(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    const { hub, clock } = this.#ctx;
    for (const key of this.#channels.keys()) {
      hub.unsubscribe(this, key);
    }
    this.#channels.clear();
    if (this.#heartbeat !== undefined) {
      clock.clearInterval(this.#heartbeat);
    }
    if (this.#lag) {
      clock.clearTimeout(this.#lag.timer);
      this.#lag = undefined;
    }
    this.#ctx.onEnded(this);
  }
}
