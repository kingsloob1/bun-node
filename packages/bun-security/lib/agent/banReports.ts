/**
 * An agent's reports of the bans its engine writes itself (counted rules,
 * the ladder, canaries) to the control plane (`POST /agent/ban-reports`),
 * by the user's defaults ({@link BAN_REPORT_LIMITS}): batched, one report
 * per subject per minute unless the ban escalates, capped at 600 a minute.
 * What the cap (or an unreachable control plane) drops is counted, never
 * silent: the heartbeat carries it (`bansDropped`) and the control plane
 * alerts. Only automatic bans are reported: the bans the agent applies
 * from the control plane are the engine's manual ones, so nothing echoes.
 */
import type { Ban, BanWrite } from "../engine/bans";
import type { AgentBanReport } from "./protocol";
import { BAN_REPORT_LIMITS, MAX_BAN_REPORTS } from "./protocol";

/** The subject kinds a report carries (a composite counted key has no place in the control plane's store). */
const REPORTED_KINDS = new Set(["ip", "cidr", "user", "apiKey"]);

/** The limits a reporter keeps (see {@link BAN_REPORT_LIMITS}). */
export type BanReportLimits = {
  readonly [K in keyof typeof BAN_REPORT_LIMITS]: number;
};

/** What a subject's last report said, for the dedupe window. */
interface LastReport {
  /** When it was reported, epoch ms. */
  readonly at: number;
  /** Its end then; `null` permanent. */
  readonly expiresAt: number | null;
  /** Its ladder step then. */
  readonly step: number;
}

/** Options of {@link BanReporter}. */
export interface BanReporterOptions {
  /** The clock, epoch ms. */
  readonly now: () => number;
  /** The limits. Default {@link BAN_REPORT_LIMITS}. */
  readonly limits?: Partial<BanReportLimits>;
}

/** Collects the reports to send; see the module's description. */
export class BanReporter {
  readonly #now: () => number;
  readonly #limits: BanReportLimits;
  /** Reports waiting, by subject (a newer one replaces an older). */
  readonly #pending = new Map<string, AgentBanReport>();
  /** Each subject's last report, for the dedupe window. */
  readonly #last = new Map<string, LastReport>();
  /** The current minute's start and how many reports it took. */
  #minute = { start: Number.NEGATIVE_INFINITY, taken: 0 };
  /** Dropped and not yet acknowledged by a heartbeat. */
  #dropped = 0;

  /** @param options The clock and limits. */
  constructor(options: BanReporterOptions) {
    this.#now = options.now;
    this.#limits = { ...BAN_REPORT_LIMITS, ...options.limits };
  }

  /** Offers one write the engine made: reported when automatic, reportable, and new or escalating. */
  offer(ban: Ban, write: BanWrite): void {
    if (write.source !== "auto" || !REPORTED_KINDS.has(ban.subject.type)) {
      return;
    }
    const now = this.#now();
    const key = ban.id;
    const step = write.step ?? ban.step ?? 0;
    const last = this.#last.get(key);
    if (last !== undefined && now - last.at < this.#limits.dedupeMs) {
      const escalates =
        (ban.expiresAt === null && last.expiresAt !== null) ||
        (ban.expiresAt !== null &&
          last.expiresAt !== null &&
          ban.expiresAt > last.expiresAt) ||
        step > last.step;
      if (!escalates) return;
    }
    if (now - this.#minute.start >= 60_000) {
      this.#minute = { start: now, taken: 0 };
    }
    if (this.#minute.taken >= this.#limits.perMinute) {
      this.#dropped++;
      return;
    }
    this.#minute.taken++;
    this.#last.set(key, { at: now, expiresAt: ban.expiresAt, step });
    if (this.#last.size > 10_000) {
      // Forget the oldest windows: they are long past.
      for (const [old, seen] of this.#last) {
        if (now - seen.at < this.#limits.dedupeMs) break;
        this.#last.delete(old);
      }
    }
    this.#queue(key, {
      subject: {
        type: ban.subject.type as AgentBanReport["subject"]["type"],
        value: ban.subject.value,
      },
      action: ban.action,
      reason: (ban.reason === "" ? "an automatic ban" : ban.reason).slice(
        0,
        500,
      ),
      ...(write.rule === undefined ? {} : { rule: write.rule.slice(0, 200) }),
      createdAt: ban.createdAt,
      expiresAt: ban.expiresAt,
      ...(step > 0 ? { step: Math.min(step, 100) } : {}),
      ...(ban.code === undefined ? {} : { code: ban.code.slice(0, 200) }),
    });
  }

  /** Puts `report` in the queue, past the bound dropped and counted. */
  #queue(key: string, report: AgentBanReport): void {
    if (!this.#pending.has(key) && this.#pending.size >= this.#limits.queue) {
      this.#dropped++;
      return;
    }
    this.#pending.delete(key);
    this.#pending.set(key, report);
  }

  /** The next batch to send (at most {@link MAX_BAN_REPORTS}), taken out of the queue. */
  take(): AgentBanReport[] {
    const batch: AgentBanReport[] = [];
    for (const [key, report] of this.#pending) {
      if (batch.length >= MAX_BAN_REPORTS) break;
      batch.push(report);
      this.#pending.delete(key);
    }
    return batch;
  }

  /** Puts back a batch that could not be sent (unless a newer report of the subject is waiting). */
  requeue(batch: readonly AgentBanReport[]): void {
    for (const report of batch) {
      const key = `${report.subject.type}:${report.subject.value}`;
      if (!this.#pending.has(key)) this.#queue(key, report);
    }
  }

  /** How many reports wait. */
  get pending(): number {
    return this.#pending.size;
  }

  /** The reports dropped and not yet carried by a heartbeat the control plane took. */
  get dropped(): number {
    return this.#dropped;
  }

  /** A heartbeat carrying `count` dropped reports was taken: they are reported. */
  acknowledge(count: number): void {
    this.#dropped = Math.max(0, this.#dropped - count);
  }
}
