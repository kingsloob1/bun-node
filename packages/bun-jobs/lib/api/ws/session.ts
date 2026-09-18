import type { BunRequest, WebSocketClient } from "@kingsleyweb/bun-common";
import type { EventKind } from "../../shared/events";
import type { AuthDecision } from "../auth";
import type {
  JobsApiSocketData,
  ResolvedJobsApiConfig,
  ResolvedJobsApiWebSocketOptions,
} from "../config";
import type { Schema } from "../schema/builder";
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
import { BROAD_CHANNELS, parseChannel } from "./channels";
import {
  JOBS_API_WS_CLOSE,
  PingMessageSchema,
  SubscribeMessageSchema,
  UnsubscribeMessageSchema,
} from "./protocol";

/**
 * One connection: its subscriptions, its limits, and how it copes with a
 * client that cannot keep up.
 *
 * **Limits.** A frame over `maxMessageBytes` is answered with an error and
 * closed `1009`; a binary frame is closed `1003`; more than
 * `messagesPerSecond` (a token bucket, burst of two seconds' worth) is an
 * error, and a second breach within ten seconds closes `1008`.
 *
 * **Authorization.** Each named channel is authorized once and the decision
 * kept while the channel is held (and forgotten on `unsubscribe`). Only as
 * many new channels as the connection has free slots are authorized at all;
 * the rest are refused `SUBSCRIPTION_LIMIT` unasked. The broad channels
 * (`all`, `queues`, `runners`) carry every target's events, so each target is
 * authorized too, on its first event — `events.subscribe` with the broad
 * `channel` and the event's `queue` or `runner` — and events of a target the
 * host denies are not sent on that channel. Delivery stays in `seq` order
 * while such a decision is pending: later events wait behind it.
 *
 * **Backpressure.** `send()` says whether a frame went out (bytes), was queued
 * under backpressure (`-1`) or was dropped (`0`), and the buffered amount says
 * how far behind the client is. Past either threshold the session is
 * lagging*: it stops sending events and records the range it skipped. When
 * the socket drains, it sends one `gap` covering them and goes live again — it
 * does not replay, because a client that fell behind must refetch anyway. A
 * session lagging for `slowConsumerTimeoutMs` is closed `4008`.
 */

/** How long after one rate-limit breach a second one closes the socket. */
export const RATE_BREACH_WINDOW_MS = 10_000;

/**
 * Most events held back waiting on a per-target `authorize` decision. Past it
 * the session lags, as it would for a client that cannot keep up: a host whose
 * `authorize` hangs must not grow a session's memory without bound.
 */
const OUTBOX_LIMIT = 1_000;

/** How many times a resuming subscribe waits for pending decisions before replaying regardless. */
const REPLAY_PREPARE_ROUNDS = 5;

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
  /** The first `seq` that may be missing. Only ever lowered while lagging. */
  fromSeq: number;
  /** The last `seq` skipped, once one has been. Only ever raised while lagging. */
  toSeq: number | undefined;
  /** The slow-consumer timer. */
  timer: unknown;
  /** Set when the lag began because the outbox overflowed, not the socket: it ends when the outbox empties. */
  outbox?: true;
}

/** An event held back until a per-target decision it needs has settled. */
interface HeldEvent {
  /** The event. */
  stamped: StampedEvent;
  /** The session's channels it matched when it arrived. */
  keys: string[];
  /**
   * Set when a resume's replay held it, not live delivery: skipping it into a
   * lag then makes that resume `resumed: false`.
   */
  replay?: true;
}

/** What became of one event offered to the session. */
type Outcome =
  /** Written to the socket (or queued by it under backpressure). */
  | "sent"
  /** Skipped into the lag: a `gap` will cover it. */
  | "lagged"
  /** Held back behind a pending per-target decision; sent in order later. */
  | "held"
  /** Deliberately not sent: filtered, denied, or dropped by `serialize.event`. */
  | "none";

/** `WebSocket.OPEN`. */
const OPEN = 1;

/** The schema for each `op`, so a malformed frame is described against the message it names. */
const CLIENT_SCHEMAS: Record<JobsApiClientMessage["op"], Schema<unknown>> = {
  subscribe: SubscribeMessageSchema,
  unsubscribe: UnsubscribeMessageSchema,
  ping: PingMessageSchema,
};

/** The request `id` a frame carries, when it is JSON with a usable one; best effort. */
function requestIdOf(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length >= 1 && id.length <= 128
    ? id
    : undefined;
}

/** The value at a validation issue's path, for rewording its message. */
function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/**
 * Validates a parsed client frame against the message its `op` names. The
 * union's own message, "Expected object or object or object", describes the
 * schema rather than the mistake; naming the `op`, and saying why a huge
 * integer is refused, is what a client author can act on.
 */
function validateFrame(
  parsed: unknown,
): { ok: true; message: JobsApiClientMessage } | { ok: false; detail: string } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "Frames must be JSON objects with an `op`" };
  }
  const op = (parsed as { op?: unknown }).op;
  const schema =
    typeof op === "string" && Object.hasOwn(CLIENT_SCHEMAS, op)
      ? CLIENT_SCHEMAS[op as JobsApiClientMessage["op"]]
      : undefined;
  if (!schema) {
    return {
      ok: false,
      detail: `op: Expected "subscribe", "unsubscribe" or "ping", received ${op === undefined ? "none" : JSON.stringify(op).slice(0, 64)}`,
    };
  }
  const result = validateJson(schema.json, parsed);
  if (!result.issues) {
    return { ok: true, message: result.value as JobsApiClientMessage };
  }
  return {
    ok: false,
    detail: result.issues
      .map((issue) => {
        const path = (issue.path ?? []).map((segment) =>
          typeof segment === "object" ? segment.key : segment,
        );
        const value = valueAt(parsed, path);
        const message =
          typeof value === "number" &&
          Number.isInteger(value) &&
          !Number.isSafeInteger(value)
            ? `Expected an integer of at most ${Number.MAX_SAFE_INTEGER} in magnitude, received ${value}`
            : issue.message;
        const at = path.map(String).join(".");
        return at ? `${at}: ${message}` : message;
      })
      .join("; "),
  };
}

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
  /** `authorize` decisions for the channels held — only those, and forgotten on unsubscribe. */
  readonly #decisions = new Map<string, AuthDecision>();
  /** The target-less `events.subscribe` decision a malformed frame is answered under. */
  #frameDecision: Promise<AuthDecision> | undefined;
  /** Per-target decisions on broad channels, by `<channel>\0<kind>:<target>`. */
  readonly #targetDecisions = new Map<string, AuthDecision>();
  /** Per-target decisions in flight, by the same key. */
  readonly #targetPending = new Map<string, Promise<void>>();
  /** Per-target decisions that failed: used once, for the events waiting on them, then asked again. */
  readonly #targetFailed = new Set<string>();
  /** Events held back, in `seq` order, behind a pending per-target decision. */
  #outbox: HeldEvent[] = [];
  /** Resolved when the outbox empties. */
  #outboxWaiters: (() => void)[] = [];
  /**
   * The channels each `seq` was sent for, for every `seq` the hub may still
   * replay: no `(seq, channel)` pair is sent twice, so a resume re-sends an
   * event only for the channels it has not reached yet. Pruned to the replay
   * window; each entry lists at most the session's channels the event matched.
   */
  readonly #sent = new Map<number, readonly string[]>();
  /**
   * Set while a resume waits for the replayed events it had to hold: a
   * replayed event skipped into a lag meanwhile sets it, and the resume then
   * answers `resumed: false`. `undefined` when no resume is waiting.
   */
  #replayLagged: boolean | undefined;
  /**
   * Notifier holds this session took, by the channel that needed them: each
   * is released when the channel is left or the session ends, so names a
   * client invents are not followed forever.
   */
  readonly #holds = new Map<string, { kind: EventKind; target: string }>();
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
      // The refused request's `id`, when it has one, so a client awaiting
      // its answer is not left waiting. Only the first breach pays for the
      // parse, and the frame is already known to be small.
      let id: string | undefined;
      try {
        id = requestIdOf(JSON.parse(message));
      } catch {
        id = undefined;
      }
      this.#error(
        id,
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
          let decision = this.#frameDecision;
          if (!decision) {
            decision = decide(this.#ctx.config, this.request, {
              action: "events.subscribe",
              transport: "ws",
            });
            this.#frameDecision = decision;
            decision.catch(() => {
              this.#frameDecision = undefined;
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
    const result = validateFrame(parsed);
    if (!result.ok) {
      malformed(requestIdOf(parsed), result.detail);
      return;
    }

    const request = result.message;
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

  /** The `authorize` decision for a channel: the one kept while it is held, else a fresh one. */
  async #authorize(channel: ParsedChannel): Promise<AuthDecision> {
    return (
      this.#decisions.get(channel.key) ??
      (await decide(this.#ctx.config, this.request, {
        action: "events.subscribe",
        transport: "ws",
        ...channel.target,
      }))
    );
  }

  /**
   * Holds, on the notifier, every queue and runner these channels name and it
   * is meant to follow, and waits until each is live — so an event on a queue
   * its discovery pass has not found yet is not lost. One hold per channel,
   * released with it. A failure is logged, and discovery remains the fallback.
   */
  async #follow(channels: readonly ParsedChannel[]): Promise<void> {
    const notifier = this.#ctx.hub.notifier;
    if (!notifier) {
      return;
    }
    await Promise.all(
      channels.map(async ({ key, target }) => {
        const [kind, name] =
          target.runner !== undefined
            ? (["runner", target.runner] as const)
            : target.queue !== undefined
              ? (["queue", target.queue] as const)
              : [undefined, undefined];
        if (
          kind === undefined ||
          this.#holds.has(key) ||
          !notifier.wants(kind, name)
        ) {
          return;
        }
        // Recorded before the await, so a session ending meanwhile releases it.
        this.#holds.set(key, { kind, target: name });
        try {
          await notifier.hold(kind, name);
        } catch (error) {
          this.#ctx.config.logger.warn("jobs api could not follow a target", {
            error,
            kind,
            target: name,
          });
        }
      }),
    );
  }

  /**
   * Subscribes: parse, apply the cap, authorize what fits, follow, resume, ack.
   *
   * Only as many channels not already held as the connection has free slots
   * are authorized; the rest are refused `SUBSCRIPTION_LIMIT` without asking
   * `authorize`, so one frame can cost at most `maxSubscriptions` calls. A
   * channel `authorize` then refuses leaves its slot unused for this frame.
   *
   * Subscribing to a channel already held replaces its event filter: the
   * last subscribe wins, and one `unsubscribe` removes the channel.
   */
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
    /** Each distinct channel, with the name the client first gave it. */
    const candidates: { channel: ParsedChannel; raw: string }[] = [];
    const seen = new Set<string>();
    let free = options.maxSubscriptions - this.#channels.size;
    for (const raw of message.channels) {
      const result = parseChannel(raw, config);
      if (!result.ok) {
        rejected.push({ channel: raw, ...result.rejection });
        continue;
      }
      const { channel } = result;
      if (seen.has(channel.key)) {
        continue;
      }
      seen.add(channel.key);
      if (this.#channels.has(channel.key)) {
        candidates.push({ channel, raw });
      } else if (free > 0) {
        free--;
        candidates.push({ channel, raw });
      } else {
        rejected.push({
          channel: raw,
          code: "SUBSCRIPTION_LIMIT",
          status: 400,
          detail: `At most ${options.maxSubscriptions} subscriptions per connection`,
        });
      }
    }

    const decisions = await Promise.all(
      candidates.map(async ({ channel }) => {
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

    const allowed: { channel: ParsedChannel; decision: AuthDecision }[] = [];
    candidates.forEach(({ channel, raw }, index) => {
      const decision = decisions[index];
      if (!decision) {
        rejected.push({
          channel: raw,
          code: "INTERNAL",
          status: 500,
          detail: "Authorization failed",
        });
      } else if (!decision.allow) {
        rejected.push({
          channel: raw,
          code: decision.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
          status: decision.status,
          ...(decision.reason ? { detail: decision.reason } : {}),
        });
      } else {
        allowed.push({ channel, decision });
      }
    });

    await this.#follow(allowed.map(({ channel }) => channel));
    if (this.#ended) {
      return;
    }
    const filter = message.events ? new Set<string>(message.events) : undefined;
    if (message.resume && allowed.length > 0) {
      await this.#prepareReplay(
        message.resume,
        new Set(allowed.map(({ channel }) => channel.key)),
        filter,
      );
      if (this.#ended) {
        return;
      }
    }

    // From here to the end of the replay nothing awaits, so no event can be
    // stamped between indexing the channels, replaying and going live. Only
    // the ack may wait, for replayed events held behind a decision.
    const accepted: string[] = [];
    for (const { channel, decision } of allowed) {
      accepted.push(channel.key);
      this.#decisions.set(channel.key, decision);
      this.#channels.set(channel.key, filter);
      hub.subscribe(this, channel.key);
    }

    let resumed: boolean | undefined;
    let gap: JobsApiGapMessage | undefined;
    /** Whether the ack waited for held replayed events, deferring any gap. */
    let waited = false;
    if (message.resume) {
      const { epoch, afterSeq } = message.resume;
      const replay =
        accepted.length > 0 ? hub.replay(epoch, afterSeq) : undefined;
      if (replay?.status === "ok") {
        const scope = new Set(accepted);
        let lagged = false;
        let held = false;
        for (const stamped of replay.events) {
          // Only this frame's channels the event has not been sent for: an
          // earlier frame's replay, or live delivery, may have sent it for
          // others, and a second copy there would be a duplicate.
          const keys = this.#unsent(
            stamped.seq,
            stamped.keys.filter((key) => scope.has(key)),
          );
          if (keys.length === 0) {
            continue;
          }
          const outcome = this.#route(stamped, keys, true);
          if (outcome === "lagged") {
            lagged = true;
          } else if (outcome === "held") {
            held = true;
          }
        }
        if (held) {
          // A decision the preparation could not settle (its rounds ran out,
          // or an `authorize` that threw is being asked again): the ack waits
          // for what was held, so the replay still precedes it. A gap the
          // outbox would announce meanwhile waits for the ack, too.
          this.#replayLagged = false;
          waited = true;
          await this.#outboxIdle();
          lagged ||= this.#replayLagged;
          this.#replayLagged = undefined;
          if (this.#ended) {
            return;
          }
        }
        // Replayed events skipped into a lag were not resumed: the gap sent
        // when the socket drains covers them instead.
        resumed = !lagged;
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
    if (waited) {
      // A lag the outbox ended while the ack waited announces its gap now.
      this.drain();
    }
  }

  /**
   * The channels among `keys` that `seq` has not been sent for on this
   * connection. With replay off nothing is recorded, and all of them are.
   */
  #unsent(seq: number, keys: readonly string[]): string[] {
    const sent = this.#sent.get(seq);
    return sent === undefined
      ? [...keys]
      : keys.filter((key) => !sent.includes(key));
  }

  /**
   * Before a resume replays: waits for events held behind a pending decision
   * to go out, and settles every per-target decision the replay will need, so
   * the replayed events can be sent synchronously — ahead of the ack.
   */
  async #prepareReplay(
    resume: NonNullable<JobsApiSubscribeMessage["resume"]>,
    scope: ReadonlySet<string>,
    filter: ReadonlySet<string> | undefined,
  ): Promise<void> {
    for (let round = 0; round < REPLAY_PREPARE_ROUNDS; round++) {
      await this.#outboxIdle();
      if (this.#ended) {
        return;
      }
      const replay = this.#ctx.hub.replay(resume.epoch, resume.afterSeq);
      if (replay.status !== "ok") {
        return;
      }
      const waits: Promise<void>[] = [];
      for (const stamped of replay.events) {
        if (filter !== undefined && !filter.has(stamped.event.type)) {
          continue;
        }
        for (const key of this.#unsent(stamped.seq, stamped.keys)) {
          if (scope.has(key) && BROAD_CHANNELS.has(key)) {
            const pending = this.#resolveTarget(key, stamped);
            if (pending) {
              waits.push(pending);
            }
          }
        }
      }
      if (waits.length === 0 && this.#outbox.length === 0) {
        return;
      }
      await Promise.all(waits);
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
      this.#decisions.delete(key);
      if (this.#channels.delete(key)) {
        hub.unsubscribe(this, key);
      }
      this.#release(key);
      if (BROAD_CHANNELS.has(key)) {
        this.#forgetTargets(key);
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

  /** Releases the notifier hold a channel took, if it took one. */
  #release(channel: string): void {
    const hold = this.#holds.get(channel);
    if (!hold) {
      return;
    }
    this.#holds.delete(channel);
    this.#ctx.hub.notifier
      ?.unfollow(hold.kind, hold.target)
      .catch((error: unknown) => {
        this.#ctx.config.logger.warn("jobs api could not release a target", {
          error,
          ...hold,
        });
      });
  }

  /** Forgets the per-target decisions made for one broad channel. */
  #forgetTargets(channel: string): void {
    const prefix = `${channel}\0`;
    for (const key of this.#targetDecisions.keys()) {
      if (key.startsWith(prefix)) {
        this.#targetDecisions.delete(key);
      }
    }
  }

  /** The per-target decision key for an event on a broad channel. */
  #targetKey(channel: string, stamped: StampedEvent): string {
    return `${channel}\0${stamped.event.kind}:${stamped.event.target}`;
  }

  /**
   * Starts settling the per-target decision an event on a broad channel
   * needs, returning the wait — or `undefined` when it is already known.
   */
  #resolveTarget(
    channel: string,
    stamped: StampedEvent,
  ): Promise<void> | undefined {
    const key = this.#targetKey(channel, stamped);
    if (this.#targetDecisions.has(key)) {
      return undefined;
    }
    let pending = this.#targetPending.get(key);
    if (!pending) {
      const { event } = stamped;
      pending = decide(this.#ctx.config, this.request, {
        action: "events.subscribe",
        transport: "ws",
        channel,
        ...(event.kind === "queue"
          ? { queue: event.target }
          : { runner: event.target }),
      })
        .then(
          (decision) => {
            this.#targetDecisions.set(key, decision);
          },
          (error: unknown) => {
            this.#ctx.config.logger.error(
              "jobs api authorize failed for a channel's target",
              { error, channel, target: event.target },
            );
            // Denied for the events waiting on it, then asked again.
            this.#targetDecisions.set(key, { allow: false, status: 403 });
            this.#targetFailed.add(key);
          },
        )
        .finally(() => {
          this.#targetPending.delete(key);
          // This chain is often not awaited, so it must never reject: an
          // unhandled rejection could end the process.
          try {
            this.#flushOutbox();
          } catch (error) {
            this.#ctx.config.logger.error("jobs api outbox flush failed", {
              error,
            });
          }
        });
      this.#targetPending.set(key, pending);
    }
    return pending;
  }

  /** Whether an event needs a per-target decision not yet made; starts making it. */
  #awaitsTarget(stamped: StampedEvent, keys: readonly string[]): boolean {
    let waiting = false;
    for (const key of keys) {
      if (BROAD_CHANNELS.has(key) && this.#resolveTarget(key, stamped)) {
        waiting = true;
      }
    }
    return waiting;
  }

  /** The session's channels, among `keys`, whose filter admits the event. */
  #match(stamped: StampedEvent, keys: readonly string[]): string[] {
    return keys.filter((key) => {
      if (!this.#channels.has(key)) {
        return false;
      }
      const filter = this.#channels.get(key);
      return filter === undefined || filter.has(stamped.event.type);
    });
  }

  /**
   * Sends an event matching `keys`, once. Channels whose event-type filter
   * excludes it, and broad channels whose target the host denied, are
   * dropped from `keys`; with none left nothing is sent. While lagging the
   * event is only counted.
   */
  deliver(stamped: StampedEvent, keys: string[]): void {
    this.#route(stamped, keys);
  }

  /** {@link deliver}, saying what became of the event; `replay` marks a resume's replay. */
  #route(
    stamped: StampedEvent,
    keys: readonly string[],
    replay = false,
  ): Outcome {
    if (this.#ended) {
      return "none";
    }
    const matched = this.#match(stamped, keys);
    if (matched.length === 0) {
      return "none";
    }
    if (this.#lag) {
      this.#startLag(stamped.seq, stamped.seq);
      return "lagged";
    }
    if (this.#outbox.length > 0 || this.#awaitsTarget(stamped, matched)) {
      if (this.#outbox.length >= OUTBOX_LIMIT) {
        this.#startLag(stamped.seq, stamped.seq);
        this.#lag!.outbox = true;
        return "lagged";
      }
      this.#outbox.push(
        replay
          ? { stamped, keys: matched, replay: true }
          : { stamped, keys: matched },
      );
      return "held";
    }
    return this.#emit(stamped, matched);
  }

  /** Sends what the outbox can, in order, stopping at the first event still waiting. */
  #flushOutbox(): void {
    while (this.#outbox.length > 0 && !this.#ended) {
      const head = this.#outbox[0]!;
      // Re-matched: the client may have left a channel while it waited.
      const keys = this.#match(head.stamped, head.keys);
      if (keys.length > 0 && this.#awaitsTarget(head.stamped, keys)) {
        return;
      }
      this.#outbox.shift();
      if (keys.length === 0) {
        continue;
      }
      let outcome: Outcome = "lagged";
      if (this.#lag) {
        this.#startLag(head.stamped.seq, head.stamped.seq);
      } else {
        outcome = this.#emit(head.stamped, keys);
      }
      if (outcome === "lagged" && head.replay && this.#replayLagged === false) {
        this.#replayLagged = true;
      }
    }
    for (const key of this.#targetFailed) {
      this.#targetDecisions.delete(key);
    }
    this.#targetFailed.clear();
    for (const resolve of this.#outboxWaiters.splice(0)) {
      resolve();
    }
    // A lag the outbox overflowed into is announced once it is empty, as a
    // drained socket would announce it. A lag the socket caused waits for
    // the socket.
    if (this.#lag?.outbox) {
      this.drain();
    }
  }

  /** Resolves once no event is held behind a pending decision. */
  async #outboxIdle(): Promise<void> {
    if (this.#outbox.length === 0 || this.#ended) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#outboxWaiters.push(resolve);
    });
  }

  /**
   * Serialises and sends an event whose channels are all known to be
   * admitted, bar denied targets — and bar channels it was already sent for,
   * which an event held live and then replayed by a resume could otherwise
   * reach twice.
   */
  #emit(stamped: StampedEvent, matched: readonly string[]): Outcome {
    const keys = this.#unsent(stamped.seq, matched).filter(
      (key) =>
        !BROAD_CHANNELS.has(key) ||
        this.#targetDecisions.get(this.#targetKey(key, stamped))?.allow ===
          true,
    );
    if (keys.length === 0) {
      return "none";
    }
    if (this.#lag) {
      this.#startLag(stamped.seq, stamped.seq);
      return "lagged";
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
      return "none";
    }
    if (event === null) {
      return "none";
    }
    const outcome = this.#send(
      {
        type: "event",
        seq: stamped.seq,
        epoch: this.#ctx.hub.epoch,
        subscriptions: keys,
        event,
      },
      stamped.seq,
    );
    if (outcome === "sent") {
      this.#recordSent(stamped.seq, keys);
    }
    return outcome;
  }

  /**
   * Remembers the channels a `seq` was sent for, for as long as the hub may
   * replay it. Pruned past twice the replay size to what is still retained,
   * so the map stays within that bound, and each entry within the channels
   * the event matched.
   */
  #recordSent(seq: number, keys: readonly string[]): void {
    const { hub, options } = this.#ctx;
    if (options.replay === false || !hub.replayEnabled) {
      return;
    }
    const earlier = this.#sent.get(seq);
    this.#sent.set(seq, earlier === undefined ? keys : [...earlier, ...keys]);
    if (this.#sent.size > options.replay.size * 2) {
      const oldest = hub.oldestRetainedSeq;
      for (const sent of this.#sent.keys()) {
        if (sent < oldest) {
          this.#sent.delete(sent);
        }
      }
    }
  }

  /** The socket drained: when every lagging event is behind us, announce the gap and go live. */
  drain(): void {
    const lag = this.#lag;
    if (
      !lag ||
      this.#ended ||
      this.#outbox.length > 0 ||
      this.#replayLagged !== undefined
    ) {
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
   * Sends a frame, saying whether it went out (`sent`, including queued under
   * backpressure) or was skipped into the lag (`lagged`). For an event frame
   * (`seq` given), a buffer already past `maxBufferedBytes` skips it and
   * starts lagging. A frame queued under backpressure (`-1`) starts lagging
   * after it; a dropped one (`0`) starts lagging with it.
   */
  #send(frame: JobsApiServerMessage, seq?: number): Outcome {
    if (this.#ended || this.#ws.readyState !== OPEN) {
      return "none";
    }
    if (
      seq !== undefined &&
      this.#ws.getBufferedAmount() > this.#ctx.options.maxBufferedBytes
    ) {
      this.#startLag(seq, seq);
      return "lagged";
    }
    let sent: number;
    try {
      sent = this.#ws.send(JSON.stringify(frame));
    } catch (error) {
      this.#ctx.config.logger.error("jobs api socket send failed", { error });
      return "none";
    }
    if (sent === -1) {
      this.#startLag((seq ?? this.#ctx.hub.seq) + 1, undefined);
    } else if (sent === 0) {
      if (seq === undefined) {
        this.#startLag(this.#ctx.hub.seq + 1, undefined);
      } else {
        this.#startLag(seq, seq);
        return "lagged";
      }
    }
    return "sent";
  }

  /**
   * Starts lagging (once), or widens the lag to cover `skipped`. Widened both
   * ways: a replayed event skipped while lagging can be older than the first
   * live one, and the gap must still cover it.
   */
  #startLag(fromSeq: number, skipped: number | undefined): void {
    if (this.#lag) {
      if (skipped !== undefined) {
        this.#lag.fromSeq = Math.min(this.#lag.fromSeq, skipped);
        this.#lag.toSeq = Math.max(this.#lag.toSeq ?? skipped, skipped);
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
    for (const channel of [...this.#holds.keys()]) {
      this.#release(channel);
    }
    this.#decisions.clear();
    this.#targetDecisions.clear();
    this.#outbox = [];
    for (const resolve of this.#outboxWaiters.splice(0)) {
      resolve();
    }
    this.#sent.clear();
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
