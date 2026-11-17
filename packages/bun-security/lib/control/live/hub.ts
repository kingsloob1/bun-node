/**
 * The live hub (ui.md §6, PR-CP5): what the management UI's live views are
 * sent, over a WebSocket channel or SSE, in bounded memory.
 *
 * - **Topics**: `overview:<scope>` (a second's request counts, as deltas),
 *   `events:<scope>` (the activity feed), `policy:<scope>` (policies
 *   published, bundles compiled, break-glass used) and `approvals`. A scope
 *   covers its descendants, as a role binding does.
 * - **Authorization** at subscribe time, per topic and scope
 *   (`analytics:read` for overview and events, `events:read` deciding how
 *   much of an event is shown, `policy:read`, `approvals:read`), and again
 *   when access may have changed (a role binding written, and every minute):
 *   a topic no longer allowed closes the connection (`4403`). How much of
 *   an event is shown is decided per event, on its own service (groups
 *   included), when it is sent; a detail no
 *   longer allowed is stripped from then on, replays included.
 * - **Rates**: overview at most once a second per topic; the feed at most
 *   20 events a second per subscriber, 20 more for priority events, the
 *   rest counted (`more`).
 * - **Back-pressure**: a subscriber with more than 1 MiB buffered is sent
 *   nothing until it drains, then a `gap` telling it to refetch.
 * - **Resume**: every ring message carries `{ epoch, seq }`; a resume point
 *   the ring (1,000 messages, 5 minutes, per instance) still holds is
 *   replayed, an older one answered with a `gap`.
 * - **Limits**: 5 connections an operator, 10 topics a connection.
 *
 * Messages are stripped to each subscriber's access when sent; the ring
 * keeps events without their request samples.
 */
import type {
  LiveCursorDto,
  LiveSubscribedDto,
  LiveTopicKind,
} from "../contract/live";
import type { SecurityApiPermission } from "../contract/constants";
import type {
  BanDto,
  PolicyScopeId,
  SecurityLiveEventDto,
} from "../contract/types";
import type { Operator } from "../options";
import type { ControlPlane } from "../plane";
import type { BanRecord, CounterRow, SecurityEvent } from "../../store/types";
import {
  LIVE_CLOSE_CODES,
  LIVE_LIMITS,
  LIVE_TOPIC_KINDS,
} from "../contract/live";
import { ApiProblem } from "../problems";
import { parseScope } from "../scopes";
import { eventView } from "./view";

/** What a transport sends: the message's type, its data, and its id for a ring message. */
export interface LiveTransport {
  /** Sends one message. */
  readonly send: (type: string, data: unknown, id?: string) => void;
  /** Bytes sent and not yet taken by the client. */
  readonly buffered: () => number;
  /** Closes the connection. */
  readonly close: (code: number, reason: string) => void;
}

/** One message of the ring. */
interface RingMessage {
  /** Its sequence number. */
  readonly seq: number;
  /** When it was published. */
  readonly at: number;
  /** Its topic kind; `banChanged` is the unscoped stream's alone (CP2's `ban.changed`). */
  readonly kind: "events" | "bans" | "policy" | "approvals" | "banChanged";
  /** The scope it concerns: a service's for an event. */
  readonly scope: string;
  /** For an event: whether it jumps the queue. */
  readonly priority: boolean;
  /** The payload: an event (without its sample), a ban, or a control event. */
  readonly payload: SecurityEvent | BanDto | SecurityLiveEventDto;
}

/** One subscription of a session. */
interface Subscription {
  /** The topic as named. */
  readonly topic: string;
  /** Its kind. */
  readonly kind: LiveTopicKind | "banChanged";
  /** Its scope (`global` for `approvals`). */
  readonly scope: PolicyScopeId;
  /** The scopes it covers; `undefined`: every one. */
  covered: ReadonlySet<string> | undefined;
  /** Checked per message, on the message's own scope, with this permission (approvals, and the unscoped stream). */
  readonly perMessage?: SecurityApiPermission;
}

/** The permission a topic kind needs. */
const PERMISSION: Readonly<Record<LiveTopicKind, SecurityApiPermission>> = {
  overview: "analytics:read",
  events: "analytics:read",
  bans: "bans:read",
  policy: "policy:read",
  approvals: "approvals:read",
};

/** The control events and the topic kind each is sent on. */
const CONTROL_KIND: Readonly<
  Record<SecurityLiveEventDto["event"], "policy" | "approvals" | "banChanged">
> = {
  // A ban's own messages go to bans:<scope> (publishBan, with the record);
  // the bare notice is CP2's unscoped stream's.
  "ban.changed": "banChanged",
  "policy.published": "policy",
  "bundle.compiled": "policy",
  "breakGlass.used": "policy",
  "approval.created": "approvals",
  "approval.decided": "approvals",
};

/** The actions that jump the feed's queue. */
const PRIORITY_ACTIONS = new Set(["ban", "drop"]);

/** How often access is re-checked without a trigger, ms. */
const REAUTHORIZE_MS = 60_000;

/** A topic, parsed; `undefined` when it is not one. */
export function parseTopic(
  topic: string,
): { kind: LiveTopicKind; scope: PolicyScopeId } | undefined {
  if (topic === "approvals") return { kind: "approvals", scope: "global" };
  const colon = topic.indexOf(":");
  if (colon < 0) return undefined;
  const kind = topic.slice(0, colon) as LiveTopicKind;
  const scope = topic.slice(colon + 1);
  if (!LIVE_TOPIC_KINDS.includes(kind) || kind === "approvals")
    return undefined;
  if (parseScope(scope) === undefined) return undefined;
  return { kind, scope };
}

/** Options of {@link LiveHub}. */
export interface LiveHubOptions {
  /** The clock, epoch milliseconds. */
  readonly now: () => number;
  /** Start the once-a-second timer (default `true`; tests call `tick()`). */
  readonly timers?: boolean;
}

/** The hub; see the module's description. */
export class LiveHub {
  /** This hub's epoch: resume points from another instance, or an earlier life, are gaps. */
  readonly epoch: string;
  readonly #plane: ControlPlane;
  readonly #now: () => number;
  readonly #sessions = new Set<LiveSession>();
  readonly #ring: RingMessage[] = [];
  #seq = 0;
  /** Request counts since the last tick, by service, then action. */
  readonly #overview = new Map<string, Map<string, number>>();
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  readonly #reauthTimer: ReturnType<typeof setInterval> | undefined;
  readonly #offPlane: () => void;
  #closed = false;

  constructor(plane: ControlPlane, options: LiveHubOptions) {
    this.#plane = plane;
    this.#now = options.now;
    this.epoch = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const offEvents = plane.listen((event) => {
      this.#push(CONTROL_KIND[event.event], event.scope, false, event);
    });
    const offAccess = plane.onAccessChanged(() => {
      void this.reauthorize();
    });
    this.#offPlane = () => {
      offEvents();
      offAccess();
    };
    if (options.timers !== false) {
      this.#timer = setInterval(() => this.tick(), 1_000);
      this.#timer.unref?.();
      this.#reauthTimer = setInterval(() => {
        void this.reauthorize();
      }, REAUTHORIZE_MS);
      this.#reauthTimer.unref?.();
    }
  }

  /** The plane the hub serves. */
  get plane(): ControlPlane {
    return this.#plane;
  }

  /** The last sequence number published. */
  get seq(): number {
    return this.#seq;
  }

  /** Open sessions. */
  get size(): number {
    return this.#sessions.size;
  }

  /** How many sessions an operator holds. */
  sessionsOf(operator: Operator): number {
    let count = 0;
    for (const session of this.#sessions)
      if (session.operator.id === operator.id) count += 1;
    return count;
  }

  /**
   * Opens a session for `operator` on `transport`; a `429` problem past the
   * operator's limit.
   */
  open(operator: Operator, transport: LiveTransport): LiveSession {
    if (this.#closed)
      throw new ApiProblem(404, "not_found", "the live hub is closed");
    if (this.sessionsOf(operator) >= LIVE_LIMITS.connectionsPerOperator) {
      throw new ApiProblem(
        429,
        "rate_limited",
        `an operator holds at most ${LIVE_LIMITS.connectionsPerOperator} live connections`,
      );
    }
    const session = new LiveSession(this, operator, transport, () => {
      this.#sessions.delete(session);
    });
    this.#sessions.add(session);
    return session;
  }

  /**
   * After a batch from `service` is stored: its events to the feed (without
   * their request samples), its `requests` counters to the overview. PR-CP4's
   * `/agent/events` calls it.
   */
  publishBatch(
    service: string,
    batch: {
      /** The batch's events. */
      readonly events: readonly SecurityEvent[];
      /** The batch's counters. */
      readonly counters: readonly CounterRow[];
    },
  ): void {
    if (this.#closed) return;
    for (const event of batch.events) {
      if (event.service !== service) continue;
      const { sample: _sample, ...withoutSample } = event;
      this.#push(
        "events",
        `service:${service}`,
        PRIORITY_ACTIONS.has(event.action),
        withoutSample,
      );
    }
    for (const row of batch.counters) {
      if (row.service !== service || row.metric !== "requests") continue;
      const action = row.dims?.action;
      if (action === undefined) continue;
      let counts = this.#overview.get(service);
      if (counts === undefined) {
        counts = new Map();
        this.#overview.set(service, counts);
      }
      counts.set(action, (counts.get(action) ?? 0) + row.value);
    }
  }

  /** After a ban is written or lifted: the record, its subject as stored, to `bans:<scope>`. */
  publishBan(ban: BanRecord): void {
    if (this.#closed) return;
    this.#push("bans", ban.scope, false, this.#plane.banDto(ban));
  }

  /** The ring's messages after `seq`, oldest first; `undefined` when the ring no longer holds them. */
  since(cursor: LiveCursorDto): RingMessage[] | undefined {
    if (cursor.epoch !== this.epoch) return undefined;
    this.#prune();
    const oldest = this.#ring[0]?.seq ?? this.#seq + 1;
    if (cursor.seq > this.#seq || cursor.seq < oldest - 1) return undefined;
    return this.#ring.filter((message) => message.seq > cursor.seq);
  }

  /** Once a second: overview deltas, the feed's counts, slow subscribers resumed, the ring pruned. */
  tick(): void {
    const at = Math.floor(this.#now() / 1_000) * 1_000;
    const counts = new Map(this.#overview);
    this.#overview.clear();
    for (const session of this.#sessions) session.tick(at, counts);
    this.#prune();
  }

  /** Re-checks every session's access. */
  async reauthorize(): Promise<void> {
    await Promise.all(
      [...this.#sessions].map(async (session) => await session.reauthorize()),
    );
  }

  /** Closes every session (`1001`) and stops the timers. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#offPlane();
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#reauthTimer !== undefined) clearInterval(this.#reauthTimer);
    for (const session of [...this.#sessions]) {
      session.close(
        LIVE_CLOSE_CODES.shutdown,
        "the control plane is shutting down",
      );
    }
  }

  /** Appends to the ring and delivers. */
  #push(
    kind: RingMessage["kind"],
    scope: string,
    priority: boolean,
    payload: RingMessage["payload"],
  ): void {
    if (this.#closed) return;
    this.#seq += 1;
    const message: RingMessage = Object.freeze({
      seq: this.#seq,
      at: this.#now(),
      kind,
      scope,
      priority,
      payload,
    });
    this.#ring.push(message);
    if (this.#ring.length > LIVE_LIMITS.ringMessages) this.#ring.shift();
    for (const session of this.#sessions) session.deliver(message, false);
  }

  /** Drops ring messages older than its age. */
  #prune(): void {
    const oldest = this.#now() - LIVE_LIMITS.ringAgeMs;
    while (this.#ring.length > 0 && this.#ring[0].at < oldest)
      this.#ring.shift();
  }
}

/** One connection's subscriptions; see {@link LiveHub}. */
export class LiveSession {
  /** Who is connected. */
  readonly operator: Operator;
  readonly #hub: LiveHub;
  readonly #transport: LiveTransport;
  readonly #onClose: () => void;
  readonly #subscriptions = new Map<string, Subscription>();
  /** Feed events sent this second, normal and priority. */
  #sent = 0;
  #prioritySent = 0;
  /** Feed events not sent this second, by topic. */
  readonly #more = new Map<string, number>();
  /** Sending stopped until the client drains. */
  #slow = false;
  /** Each service's `events:read`, asked once per service (cleared when access is re-checked). */
  #details = new Map<string, Promise<boolean>>();
  /** The sends in order. */
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    hub: LiveHub,
    operator: Operator,
    transport: LiveTransport,
    onClose: () => void,
  ) {
    this.#hub = hub;
    this.operator = operator;
    this.#transport = transport;
    this.#onClose = onClose;
  }

  /** The topics subscribed. */
  get topics(): string[] {
    return [...this.#subscriptions.keys()];
  }

  /**
   * Subscribes to `topics`, each authorized now; replays the ring from
   * `resume` (or sends a `gap`) for the new ones.
   */
  async subscribe(
    topics: readonly string[],
    resume?: LiveCursorDto,
  ): Promise<LiveSubscribedDto> {
    const refused: {
      topic: string;
      reason: "forbidden" | "invalid" | "limit";
    }[] = [];
    const added: Subscription[] = [];
    for (const topic of new Set(topics)) {
      if (this.#subscriptions.has(topic)) continue;
      const parsed = parseTopic(topic);
      if (parsed === undefined) {
        refused.push({ topic, reason: "invalid" });
        continue;
      }
      if (this.#subscriptions.size >= LIVE_LIMITS.topicsPerConnection) {
        refused.push({ topic, reason: "limit" });
        continue;
      }
      const access = await this.#access(parsed.kind, parsed.scope);
      if (access === undefined) {
        refused.push({ topic, reason: "forbidden" });
        continue;
      }
      const subscription: Subscription = { topic, ...parsed, ...access };
      this.#subscriptions.set(topic, subscription);
      added.push(subscription);
    }
    if (resume !== undefined && added.length > 0 && !this.#closed) {
      const replay = this.#hub.since(resume);
      if (replay === undefined) {
        this.#later("gap", {
          reason: "resume",
          epoch: this.#hub.epoch,
          seq: this.#hub.seq,
        });
      } else {
        const only = new Set(added.map((s) => s.topic));
        for (const message of replay) this.deliver(message, true, only);
      }
    }
    return {
      topics: this.topics,
      refused,
      epoch: this.#hub.epoch,
      seq: this.#hub.seq,
    };
  }

  /**
   * CP2's unscoped stream (`GET /live` without topics): every policy and
   * approval event whose own scope the operator may read under
   * `policy:read`, checked per message.
   */
  subscribeUnscoped(): void {
    for (const kind of ["policy", "approvals", "banChanged"] as const) {
      this.#subscriptions.set(`*${kind}`, {
        topic: `*${kind}`,
        kind,
        scope: "global",
        covered: undefined,
        perMessage: "policy:read",
      });
    }
  }

  /** Stops `topics`. */
  unsubscribe(topics: readonly string[]): string[] {
    for (const topic of topics) this.#subscriptions.delete(topic);
    return this.topics;
  }

  /**
   * Sends a ring message to this session, once, through the first
   * subscription that covers it (preferring one that shows events whole):
   * stripped to that subscription's access, within the feed's rate (not for
   * a replay), and not while the client is slow.
   */
  deliver(
    message: RingMessage,
    replay: boolean,
    only?: ReadonlySet<string>,
  ): void {
    if (this.#closed || this.#slow) return;
    let chosen: Subscription | undefined;
    for (const subscription of this.#subscriptions.values()) {
      if (only !== undefined && !only.has(subscription.topic)) continue;
      if (subscription.kind !== message.kind) continue;
      if (
        subscription.covered !== undefined &&
        !subscription.covered.has(message.scope)
      ) {
        continue;
      }
      chosen ??= subscription;
    }
    if (chosen === undefined) return;
    const permission = chosen.perMessage;
    if (permission !== undefined) {
      // Checked on the message's own scope, as CP2's stream did.
      const subscription = chosen;
      void this.#hub.plane
        .can(this.operator, permission, message.scope)
        .then((allowed) => {
          if (allowed && !this.#closed) this.#send(message, subscription);
        })
        .catch(() => undefined);
      return;
    }
    if (message.kind === "events" && !replay) {
      if (this.#sent < LIVE_LIMITS.eventsPerSecond) this.#sent += 1;
      else if (
        message.priority &&
        this.#prioritySent < LIVE_LIMITS.priorityPerSecond
      ) {
        this.#prioritySent += 1;
      } else {
        this.#more.set(chosen.topic, (this.#more.get(chosen.topic) ?? 0) + 1);
        return;
      }
    }
    this.#send(message, chosen);
  }

  /** Once a second: the overview, the feed's counts, a slow client resumed. */
  tick(
    at: number,
    counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): void {
    if (this.#closed) return;
    if (this.#slow) {
      if (this.#transport.buffered() > LIVE_LIMITS.recoverBytes) return;
      this.#slow = false;
      this.#later("gap", {
        reason: "slow",
        epoch: this.#hub.epoch,
        seq: this.#hub.seq,
      });
    }
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.kind !== "overview") continue;
      const requests: Record<string, number> = {};
      let any = false;
      for (const [service, byAction] of counts) {
        if (
          subscription.covered !== undefined &&
          !subscription.covered.has(`service:${service}`)
        ) {
          continue;
        }
        for (const [action, value] of byAction) {
          requests[action] = (requests[action] ?? 0) + value;
          any = true;
        }
      }
      if (any)
        this.#later("overview", { topic: subscription.topic, at, requests });
    }
    for (const [topic, count] of this.#more) {
      this.#later("more", { topic, at: at - 1_000, count });
    }
    this.#more.clear();
    this.#sent = 0;
    this.#prioritySent = 0;
  }

  /** Re-checks each subscription: a lost topic closes the session (`4403`); a lost detail strips from now on. */
  async reauthorize(): Promise<void> {
    this.#details = new Map();
    for (const subscription of [...this.#subscriptions.values()]) {
      // The unscoped stream's are checked on every message already.
      if (
        subscription.kind === "banChanged" ||
        subscription.topic.startsWith("*")
      ) {
        continue;
      }
      const access = await this.#access(
        subscription.kind,
        subscription.scope,
      ).catch(() => undefined);
      if (this.#closed) return;
      if (access === undefined) {
        this.close(
          LIVE_CLOSE_CODES.accessChanged,
          `access to ${subscription.topic} changed`,
        );
        return;
      }
      subscription.covered = access.covered;
    }
  }

  /** Closes the connection and frees its slot. Idempotent. */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscriptions.clear();
    this.#onClose();
    try {
      this.#transport.close(code, reason);
    } catch {
      // Already gone.
    }
  }

  /** Marks the session closed by its client (no close frame to send). */
  closedByClient(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscriptions.clear();
    this.#onClose();
  }

  /** What a subscription to `kind` on `scope` may see; `undefined` when not allowed. */
  async #access(
    kind: LiveTopicKind,
    scope: PolicyScopeId,
  ): Promise<
    | {
        covered: ReadonlySet<string> | undefined;
        perMessage?: SecurityApiPermission;
      }
    | undefined
  > {
    const plane = this.#hub.plane;
    if (!(await plane.can(this.operator, PERMISSION[kind], scope)))
      return undefined;
    if (kind === "approvals") {
      return { covered: undefined, perMessage: "approvals:read" };
    }
    const under = await plane.auditScopesUnder(scope);
    return { covered: under === undefined ? undefined : new Set(under) };
  }

  /** Sends a ring message, stripped, with its id. */
  #send(message: RingMessage, subscription: Subscription): void {
    const id = `${this.#hub.epoch}:${message.seq}`;
    if (message.kind === "events") {
      const event = message.payload as SecurityEvent;
      // Stripped to the operator's rights on the event's own service, when
      // it is sent: an analyst of a group sees its services' events whole
      // on any topic, and others' at a viewer's level.
      this.#queue(async () => [
        "event",
        {
          topic: subscription.topic,
          epoch: this.#hub.epoch,
          seq: message.seq,
          event: eventView(event, {
            detail: await this.#detailFor(event.service),
            live: true,
          }),
        },
        id,
      ]);
      return;
    }
    if (message.kind === "bans") {
      this.#later(
        "ban",
        {
          topic: subscription.topic,
          epoch: this.#hub.epoch,
          seq: message.seq,
          ban: message.payload as BanDto,
        },
        id,
      );
      return;
    }
    const control = message.payload as SecurityLiveEventDto;
    this.#later(
      control.event,
      {
        ...control,
        // The unscoped stream's messages name no topic, as CP2's did not.
        ...(subscription.topic.startsWith("*")
          ? {}
          : { topic: subscription.topic }),
        epoch: this.#hub.epoch,
        seq: message.seq,
      },
      id,
    );
  }

  /** Whether the operator sees `service`'s events whole (`events:read` on it, groups included); asked once per service until access is re-checked. */
  #detailFor(service: string): Promise<boolean> {
    let found = this.#details.get(service);
    if (found === undefined) {
      found = this.#hub.plane
        .can(this.operator, "events:read", `service:${service}`)
        .catch(() => false);
      this.#details.set(service, found);
    }
    return found;
  }

  /** Queues a message whose content is known now. */
  #later(type: string, data: unknown, id?: string): void {
    this.#queue(() => [type, data, id]);
  }

  /**
   * Queues a send behind every earlier one, so messages keep their order
   * while an event waits for its service's rights.
   */
  #queue(
    produce: () =>
      | readonly [string, unknown, string | undefined]
      | Promise<readonly [string, unknown, string | undefined]>,
  ): void {
    this.#chain = this.#chain
      .then(async () => {
        if (this.#closed) return;
        const [type, data, id] = await produce();
        this.#guarded(type, data, id);
      })
      .catch(() => undefined);
  }

  /** Sends unless the client is past the slow bound, which stops sending until it drains. */
  #guarded(type: string, data: unknown, id?: string): void {
    if (this.#closed) return;
    if (this.#transport.buffered() > LIVE_LIMITS.slowBytes) {
      this.#slow = true;
      return;
    }
    this.#transport.send(type, data, id);
  }
}
