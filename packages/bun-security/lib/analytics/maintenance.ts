/**
 * Analytics rollups and retention (README §8.3, §8.4): one pass rolls the
 * closed minutes up into hours and the closed hours into days, then deletes
 * what is past each table's retention in bounded batches. Run it every few
 * minutes: `start()` on a timer in the control plane's process (topology
 * (a)), or `run()` from a bun-jobs schedule with `runMode: "single"` where
 * the control plane has one. A pass is safe to run from several processes
 * at once: each bucket is rolled up once (the store's watermark), and a
 * delete never takes a row twice.
 */
import type { Duration, LoggerLike } from "@kingsleyweb/bun-common";
import type { RetainedTable, SecurityStoreDriver } from "../store/types";
import {
  ConfigError,
  resolveLogger,
  toDurationMs,
} from "@kingsleyweb/bun-common";

/** A day. */
const DAY = 86_400_000;

/** Each table's retention by default (README §8.4). */
export const DEFAULT_RETENTION: Readonly<Record<RetainedTable, number>> =
  Object.freeze({
    events: 14 * DAY,
    minute: 7 * DAY,
    hour: 90 * DAY,
    day: 400 * DAY,
    batches: 2 * DAY,
  });

/** The longest each table may be kept (README §8.4). */
export const MAX_RETENTION: Readonly<Record<RetainedTable, number>> =
  Object.freeze({
    events: 90 * DAY,
    minute: 30 * DAY,
    hour: 400 * DAY,
    day: 5 * 365 * DAY,
    batches: 30 * DAY,
  });

/** Options of {@link analyticsMaintenance}. */
export interface AnalyticsMaintenanceOptions {
  /** Each table's retention, a duration (`"14d"`) or milliseconds; the rest default ({@link DEFAULT_RETENTION}). Each at most {@link MAX_RETENTION}'s. */
  readonly retention?: Partial<Record<RetainedTable, Duration | number>>;
  /** How long after a bucket closes it is rolled up, so a batch late by up to this much is in it. Default `"5m"`. */
  readonly grace?: Duration | number;
  /** Rows per delete. Default 1,000. */
  readonly batchSize?: number;
  /** Deletes per table per pass, so one pass is bounded; the rest wait for the next. Default 100. */
  readonly maxBatches?: number;
  /** How often `start()` runs a pass. Default `"5m"`. */
  readonly interval?: Duration | number;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Where a failed pass of `start()` is logged. Default: the console. */
  readonly logger?: LoggerLike;
}

/** What one pass did. */
export interface MaintenanceReport {
  /** The rows each rollup wrote: `minute>hour`, `hour>day`. */
  readonly rolledUp: Readonly<Record<"minute>hour" | "hour>day", number>>;
  /** The rows deleted from each table. */
  readonly deleted: Readonly<Record<RetainedTable, number>>;
  /** Whether a table had more to delete than one pass takes. */
  readonly more: boolean;
}

/** The maintenance of one store. */
export interface AnalyticsMaintenance {
  /** Runs one pass now. A pass already running is waited for, not run twice. */
  readonly run: () => Promise<MaintenanceReport>;
  /** Runs a pass every `interval` (the timer does not hold the process open). */
  readonly start: () => void;
  /** Stops the timer, and waits for a pass in flight. */
  readonly stop: () => Promise<void>;
  /** The retention in force, milliseconds. */
  readonly retention: Readonly<Record<RetainedTable, number>>;
}

/** A duration option as milliseconds; throws a `ConfigError`. */
function ms(value: Duration | number, what: string): number {
  const out = typeof value === "number" ? value : toDurationMs(value, what);
  if (!Number.isFinite(out) || out <= 0) {
    throw new ConfigError(
      `analyticsMaintenance(): ${what} must be a positive duration`,
    );
  }
  return out;
}

/** A positive whole option. */
function whole(
  value: number | undefined,
  fallback: number,
  what: string,
): number {
  const out = value ?? fallback;
  if (!Number.isSafeInteger(out) || out < 1 || out > 10_000) {
    throw new ConfigError(
      `analyticsMaintenance(): ${what} must be a whole number from 1 to 10,000`,
    );
  }
  return out;
}

/** The maintenance of `store`; see the module's description. */
export function analyticsMaintenance(
  store: SecurityStoreDriver,
  options: AnalyticsMaintenanceOptions = {},
): AnalyticsMaintenance {
  const { rollup, deleteBefore } = store;
  if (
    !store.capabilities.analytics ||
    rollup === undefined ||
    deleteBefore === undefined
  ) {
    throw new ConfigError(
      `analyticsMaintenance(): the "${store.name}" store has no analytics (capabilities.analytics)`,
    );
  }
  const retention = { ...DEFAULT_RETENTION };
  for (const [table, value] of Object.entries(options.retention ?? {})) {
    if (!(table in DEFAULT_RETENTION)) {
      throw new ConfigError(
        `analyticsMaintenance(): retention.${table} is not a table (${Object.keys(DEFAULT_RETENTION).join(", ")})`,
      );
    }
    const name = table as RetainedTable;
    const kept = ms(value, `retention.${name}`);
    if (kept > MAX_RETENTION[name]) {
      throw new ConfigError(
        `analyticsMaintenance(): retention.${name} is at most ${MAX_RETENTION[name] / DAY} days (README §8.4)`,
      );
    }
    retention[name] = kept;
  }
  const grace = ms(options.grace ?? "5m", "grace");
  const interval = ms(options.interval ?? "5m", "interval");
  const batchSize = whole(options.batchSize, 1_000, "batchSize");
  const maxBatches = whole(options.maxBatches, 100, "maxBatches");
  const now = options.now ?? Date.now;
  let running: Promise<MaintenanceReport> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pass = async (): Promise<MaintenanceReport> => {
    const until = now() - grace;
    const rolledUp = {
      "minute>hour": await rollup("minute", "hour", until),
      "hour>day": await rollup("hour", "day", until),
    };
    const deleted = { events: 0, minute: 0, hour: 0, day: 0, batches: 0 };
    let more = false;
    for (const table of Object.keys(retention) as RetainedTable[]) {
      const before = now() - retention[table];
      for (let batch = 0; ; batch++) {
        if (batch === maxBatches) {
          more = true;
          break;
        }
        const count = await deleteBefore(table, Math.max(0, before), batchSize);
        deleted[table] += count;
        if (count < batchSize) break;
      }
    }
    return Object.freeze({
      rolledUp: Object.freeze(rolledUp),
      deleted: Object.freeze(deleted),
      more,
    });
  };

  const run = async (): Promise<MaintenanceReport> => {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return await running;
  };

  return Object.freeze({
    run,
    retention: Object.freeze(retention),
    start: () => {
      if (timer !== undefined) return;
      const logger = resolveLogger(options.logger);
      timer = setInterval(() => {
        run().catch((error: unknown) => {
          logger.error("bun-security: an analytics maintenance pass failed", {
            error,
          });
        });
      }, interval);
      timer.unref?.();
    },
    stop: async () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  });
}
