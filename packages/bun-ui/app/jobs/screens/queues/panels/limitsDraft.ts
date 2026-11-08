import type {
  QueueLimitsBody,
  QueueLimitsDto,
  RateInput,
} from "../../../api/types";
import { parseWindow } from "../duration";

/** One rate + concurrency row of the editor, as typed. */
export interface LimitsDraftRow {
  /** Most jobs per window. */
  rateMax: number | undefined;
  /** The window: digits are ms, anything else a phrase such as "1 minute". */
  rateDuration: string;
  /** Jobs at once. */
  concurrency: number | undefined;
}

/** A per-name row of the editor. */
export interface LimitsDraftName extends LimitsDraftRow {
  /** Stable key for React; not sent. */
  key: number;
  /** The job name. */
  name: string;
}

/** The editor's state. */
export interface LimitsDraft {
  /** Queue-wide limits. */
  queue: LimitsDraftRow;
  /** Per-name overrides. */
  names: LimitsDraftName[];
}

/** An editor row from stored limits. */
function rowFrom(
  limits:
    | {
        rate?: { max: number; duration: number };
        concurrency?: number;
      }
    | undefined,
): LimitsDraftRow {
  return {
    rateMax: limits?.rate?.max,
    rateDuration: limits?.rate ? String(limits.rate.duration) : "",
    concurrency: limits?.concurrency,
  };
}

/** The editor's state from stored limits (`null` = none). */
export function draftFromLimits(limits: QueueLimitsDto | null): LimitsDraft {
  return {
    queue: rowFrom(limits ?? undefined),
    names: Object.entries(limits?.names ?? {}).map(([name, row], index) => ({
      key: index,
      name,
      ...rowFrom(row),
    })),
  };
}

/** One row as the body takes it; a rate needs both parts, so half a rate is sent as typed for the API to refuse. */
function rowBody(row: LimitsDraftRow): {
  rate?: RateInput;
  concurrency?: number;
} {
  const out: { rate?: RateInput; concurrency?: number } = {};
  const duration = parseWindow(row.rateDuration);
  if (row.rateMax !== undefined || duration !== undefined) {
    out.rate = {
      max: row.rateMax ?? 0,
      duration: duration ?? 0,
    };
  }
  if (row.concurrency !== undefined) {
    out.concurrency = row.concurrency;
  }
  return out;
}

/** The `PUT` body from the editor's state; rows with no name are dropped. */
export function limitsBodyFromDraft(draft: LimitsDraft): QueueLimitsBody {
  const body: QueueLimitsBody = rowBody(draft.queue);
  const names: NonNullable<QueueLimitsBody["names"]> = {};
  for (const row of draft.names) {
    const name = row.name.trim();
    if (name) {
      names[name] = rowBody(row);
    }
  }
  if (Object.keys(names).length > 0) {
    body.names = names;
  }
  return body;
}
