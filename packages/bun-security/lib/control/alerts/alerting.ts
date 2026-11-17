/**
 * Alerting (README §9.3, PR-CP6): the rules in the store evaluated every
 * minute over the store's counters, bans and heartbeats; the control
 * plane's own alerts (CP3's, CP4's) routed to the channels that receive
 * them; every message rate-limited per channel, held-back alerts sent as
 * digests, and deliveries queued with retries and dead letters.
 *
 * An alert a rule raises is open while its condition holds, and is not
 * raised again until it has closed (deduplicated by its key).
 */
import type { PolicyScopeId, SecurityAlertDto } from "../contract/types";
import type { ControlPlane } from "../plane";
import type { AlertDeliveryQueue, DeliveryQueueStats } from "./queue";
import type { AlertEmail } from "./senders";
import type {
  AlertChannelSpec,
  AlertDeadLetter,
  AlertDelivery,
  AlertMessage,
  AlertRecord,
  AlertRuleSpec,
  AlertSeverity,
} from "./types";
import { checkCondition, evaluateCondition } from "./conditions";
import { AlertLimiter, storeKeyPart } from "./limiter";
import { ALERT_RETRY, memoryDeliveryQueue } from "./queue";
import { sendMessage } from "./senders";
import { ALERT_SEVERITIES } from "./types";

/** `createSecurityApi`'s `alerts` option. */
export interface AlertingOptions {
  /** Sends an email for an email channel (bun-security ships no SMTP client). */
  readonly email?: (message: AlertEmail) => Promise<void>;
  /** `fetch`, for the webhooks. Default the global. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Where deliveries wait: `jobsDeliveryQueue({ queue })` on bun-jobs, so
   * retries survive a restart. Default in process (`memoryDeliveryQueue`).
   */
  readonly queue?: (
    deliver: (delivery: AlertDelivery) => Promise<void>,
  ) => AlertDeliveryQueue;
  /** The management UI's base URL: each message links to its alert there. */
  readonly uiUrl?: string;
  /** How often the rules are evaluated, ms. Default 60,000. */
  readonly evaluateIntervalMs?: number;
  /** Start the timers (default `true`; tests call `evaluate()`, `flush()` and the queue's `work()`). */
  readonly timers?: boolean;
}

/** How long the delivery log and dead letters are kept, and how many per channel (the user's decision, 2026-11-17). */
export const ALERT_RETENTION = Object.freeze({
  /** The oldest kept, ms: 30 days. */
  maxAgeMs: 30 * 86_400_000,
  /** The most kept per channel. */
  perChannel: 10_000,
});

/** One try of a delivery, as the delivery log keeps it: never the message's content. */
export interface AlertLogEntry {
  /** The delivery's id. */
  readonly id: string;
  /** The channel. */
  readonly channelId: string;
  /** The alert's kind, or `digest`. */
  readonly kind: string;
  /** The alert's severity; `null` for a digest. */
  readonly severity: AlertSeverity | null;
  /** `sent`; `failed` (it is tried again); `dead` (out of tries: a dead letter). */
  readonly outcome: "sent" | "failed" | "dead";
  /** The tries so far. */
  readonly attempts: number;
  /** When, epoch ms. */
  readonly at: number;
  /** Why it failed. */
  readonly reason?: string;
}

/** What one evaluation did. */
export interface EvaluationReport {
  /** Rules evaluated. */
  readonly rules: number;
  /** Alerts raised (newly open). */
  readonly raised: number;
  /** Alerts closed (their condition no longer holds). */
  readonly closed: number;
  /** Rules whose evaluation failed, by id, with why. */
  readonly failed: readonly {
    readonly rule: string;
    readonly reason: string;
  }[];
}

/** An open alert. */
export interface OpenAlert {
  /** Its key (internal: a grouped rule's may name a subject; never answered by the API). */
  readonly key: string;
  /** The rule that raised it. */
  readonly rule: string;
  /** The rule's scope. */
  readonly scope: PolicyScopeId;
  /** Since when, epoch ms. */
  readonly since: number;
}

/** The alerting of one control plane; see the module's description. */
export class Alerting {
  readonly #plane: ControlPlane;
  readonly #options: AlertingOptions;
  readonly #limiter: AlertLimiter;
  readonly #queue: AlertDeliveryQueue;
  readonly #open = new Map<string, OpenAlert>();
  /** The delivery log, oldest first, by channel. */
  readonly #log = new Map<string, AlertLogEntry[]>();
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  readonly #offAlerts: () => void;
  /** How long an alert's presence and send claim last in the store: 2.5 evaluation intervals. */
  readonly #presenceMs: number;
  #evaluating: Promise<EvaluationReport> | undefined;

  constructor(plane: ControlPlane, options: AlertingOptions = {}) {
    this.#plane = plane;
    this.#options = options;
    this.#presenceMs = Math.round((options.evaluateIntervalMs ?? 60_000) * 2.5);
    const now = () => plane.now();
    this.#limiter = new AlertLimiter(now, plane.store);
    const deliver = async (delivery: AlertDelivery) =>
      await this.deliver(delivery);
    this.#queue =
      options.queue?.(deliver) ??
      memoryDeliveryQueue({
        deliver,
        now,
        ...(options.timers === false ? { timers: false } : {}),
      });
    // The control plane's own alerts (CP3's onAlert kinds, CP4's) are routed too.
    this.#offAlerts = plane.onAlert((alert) => {
      void this.route(alert);
    });
    if (options.timers !== false) {
      const evaluate = setInterval(() => {
        void this.evaluate().catch(() => undefined);
      }, options.evaluateIntervalMs ?? 60_000);
      const flush = setInterval(() => {
        void this.flush().catch(() => undefined);
      }, 60_000);
      evaluate.unref?.();
      flush.unref?.();
      this.#timers.push(evaluate, flush);
    }
  }

  /** The delivery queue. */
  get queue(): AlertDeliveryQueue {
    return this.#queue;
  }

  /** The alerts open now. */
  open(): OpenAlert[] {
    return [...this.#open.values()];
  }

  /** Evaluates every enabled rule once; one pass at a time. */
  async evaluate(): Promise<EvaluationReport> {
    this.#evaluating ??= this.#evaluateOnce().finally(() => {
      this.#evaluating = undefined;
    });
    return await this.#evaluating;
  }

  async #evaluateOnce(): Promise<EvaluationReport> {
    const now = this.#plane.now();
    const rules = await this.#all<AlertRuleSpec>("alertRule");
    const failed: { rule: string; reason: string }[] = [];
    let raised = 0;
    let closed = 0;
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      let firings;
      try {
        firings = await evaluateCondition(
          this.#plane,
          rule.scope,
          checkCondition(rule.condition),
          now,
        );
      } catch (error) {
        failed.push({
          rule: rule.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const firing = new Set<string>();
      for (const { group, facts } of firings) {
        const key =
          group === undefined ? `rule:${rule.id}` : `rule:${rule.id}:${group}`;
        firing.add(key);
        // Every instance seeing it firing keeps its presence in the store
        // alive; the one whose count is 1 opened it, fleet-wide, and sends.
        const presence = await this.#plane.store.incrementCounter(
          `alert:firing:${storeKeyPart(key)}`,
          this.#presenceMs,
        );
        if (this.#open.has(key)) continue;
        this.#open.set(key, {
          key,
          rule: rule.id,
          scope: rule.scope,
          since: now,
        });
        if (presence.count > 1) continue;
        raised += 1;
        await this.raise(
          {
            kind: `rule:${rule.id}`,
            key,
            severity: rule.severity,
            scope: rule.scope,
            title: rule.title,
            at: now,
            facts,
          },
          rule.channels,
        );
      }
      for (const [key, open] of this.#open) {
        if (open.rule === rule.id && !firing.has(key)) {
          this.#open.delete(key);
          closed += 1;
        }
      }
    }
    // A rule deleted or turned off closes its alerts.
    const live = new Set(
      rules.filter((r) => r.enabled !== false).map((r) => r.id),
    );
    for (const [key, open] of this.#open) {
      if (!live.has(open.rule)) {
        this.#open.delete(key);
        closed += 1;
      }
    }
    return Object.freeze({ rules: live.size, raised, closed, failed });
  }

  /** Offers an alert to channels: each sends it now or holds it for its digest. */
  async raise(
    alert: AlertRecord,
    channelIds: readonly string[],
  ): Promise<void> {
    for (const channelId of new Set(channelIds)) {
      // Claimed in the store: an alert goes to a channel once across the
      // instances (the user's decision, 2026-11-17).
      const claimed = await this.#plane.store.claimKey(
        `alert:send:${storeKeyPart(channelId)}:${storeKeyPart(alert.key)}`,
        this.#presenceMs,
      );
      if (!claimed) continue;
      if ((await this.#limiter.admit(channelId, alert)) === "send") {
        await this.#queue.enqueue(channelId, { type: "alert", alert });
      }
    }
  }

  /** Routes a control-plane alert to every channel that receives its kind at its severity. */
  async route(alert: SecurityAlertDto): Promise<void> {
    const channels = await this.#all<AlertChannelSpec>("alertChannel");
    const targets = channels.filter((channel) =>
      receives(channel, alert.kind, alert.severity),
    );
    if (targets.length === 0) return;
    const detail = alert.detail;
    const service =
      typeof detail.service === "string" ? detail.service : undefined;
    const scope =
      typeof detail.scope === "string"
        ? detail.scope
        : service === undefined
          ? "global"
          : `service:${service}`;
    await this.raise(
      {
        kind: alert.kind,
        key: `${alert.kind}:${alert.at}`,
        severity: alert.severity,
        scope: scope as PolicyScopeId,
        title: alert.message,
        at: alert.at,
        facts: {
          ...(service === undefined ? {} : { service }),
          ...(typeof detail.agent === "string" ? { agent: detail.agent } : {}),
        },
      },
      targets.map((channel) => channel.id),
    );
  }

  /** Queues the digests due now. */
  async flush(): Promise<number> {
    const due = await this.#limiter.due();
    for (const { channelId, message } of due)
      await this.#queue.enqueue(channelId, message);
    return due.length;
  }

  /** Sends one delivery to its channel; throws when it did not go (the queue retries). */
  async deliver(delivery: AlertDelivery): Promise<void> {
    const doc = await this.#plane.store.get("alertChannel", delivery.channelId);
    try {
      if (doc === undefined)
        throw new Error(`no channel "${delivery.channelId}"`);
      await this.#send(doc.doc as AlertChannelSpec, delivery);
    } catch (error) {
      const reason = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 500);
      this.#record(
        delivery,
        delivery.attempts >= ALERT_RETRY.attempts ? "dead" : "failed",
        reason,
      );
      throw error;
    }
    this.#record(delivery, "sent");
  }

  /** Appends to the delivery log, pruned to {@link ALERT_RETENTION}. */
  #record(
    delivery: AlertDelivery,
    outcome: AlertLogEntry["outcome"],
    reason?: string,
  ): void {
    const now = this.#plane.now();
    let entries = this.#log.get(delivery.channelId);
    if (entries === undefined) {
      entries = [];
      this.#log.set(delivery.channelId, entries);
    }
    const { message } = delivery;
    entries.push({
      id: delivery.id,
      channelId: delivery.channelId,
      kind: message.type === "digest" ? "digest" : message.alert.kind,
      severity: message.type === "digest" ? null : message.alert.severity,
      outcome,
      attempts: delivery.attempts,
      at: now,
      ...(reason === undefined ? {} : { reason }),
    });
    prune(entries, now);
  }

  /** The delivery log, newest first: one channel's, or every channel's. */
  deliveries(channelId?: string): AlertLogEntry[] {
    const now = this.#plane.now();
    const out: AlertLogEntry[] = [];
    for (const [id, entries] of this.#log) {
      if (channelId !== undefined && id !== channelId) continue;
      prune(entries, now);
      out.push(...entries);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Queues a dead letter again with fresh tries; whether it was there. */
  async replay(id: string): Promise<boolean> {
    return await this.#queue.replay(id);
  }

  /** Sends a delivery's message to a channel. */
  async #send(
    channel: AlertChannelSpec,
    delivery: AlertDelivery,
  ): Promise<void> {
    await sendMessage(channel, delivery.message, {
      now: () => this.#plane.now(),
      ...(this.#options.fetch === undefined
        ? {}
        : { fetch: this.#options.fetch }),
      ...(this.#options.email === undefined
        ? {}
        : { email: this.#options.email }),
      ...(this.#options.uiUrl === undefined
        ? {}
        : { uiUrl: this.#options.uiUrl }),
    });
  }

  /** Sends a test message to a channel now, through the queue but past the limits. */
  async test(channelId: string): Promise<void> {
    const now = this.#plane.now();
    const message: AlertMessage = {
      type: "alert",
      alert: {
        kind: "test",
        key: `test:${now}`,
        severity: "info",
        scope: "global",
        title: "bun-security: a test alert",
        at: now,
        facts: {},
      },
    };
    await this.#queue.enqueue(channelId, message);
  }

  /** The dead letters, newest first: one channel's, or every channel's. */
  deadLetters(channelId?: string): readonly AlertDeadLetter[] {
    const letters = this.#queue.deadLetters();
    return channelId === undefined
      ? letters
      : letters.filter((letter) => letter.channelId === channelId);
  }

  /** The queue's figures, and the alerts each channel holds for its digest. */
  stats(): DeliveryQueueStats & { readonly open: number } {
    return { ...this.#queue.stats(), open: this.#open.size };
  }

  /** Stops the timers, the routing and the queue. */
  close(): void {
    for (const timer of this.#timers) clearInterval(timer);
    this.#offAlerts();
    this.#queue.close();
  }

  /** Every document of `kind` (at most 1,000). */
  async #all<T>(kind: "alertRule" | "alertChannel"): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#plane.store.list(kind, {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const doc of page.items) out.push(doc.doc as T);
      cursor = page.next;
    } while (cursor !== undefined && out.length < 1_000);
    return out;
  }
}

/** Drops entries past {@link ALERT_RETENTION}: the oldest beyond the count, and any older than the age. */
function prune(entries: AlertLogEntry[], now: number): void {
  const over = entries.length - ALERT_RETENTION.perChannel;
  if (over > 0) entries.splice(0, over);
  let old = 0;
  while (
    old < entries.length &&
    entries[old]!.at < now - ALERT_RETENTION.maxAgeMs
  )
    old += 1;
  if (old > 0) entries.splice(0, old);
}

/** Whether a channel receives a control-plane alert of `kind` at `severity`. */
function receives(
  channel: AlertChannelSpec,
  kind: string,
  severity: AlertSeverity,
): boolean {
  const wants = channel.receives;
  if (wants === undefined) return false;
  if (!wants.kinds.includes("*") && !wants.kinds.includes(kind)) return false;
  return (
    ALERT_SEVERITIES.indexOf(severity) >=
    ALERT_SEVERITIES.indexOf(wants.minSeverity ?? "info")
  );
}
