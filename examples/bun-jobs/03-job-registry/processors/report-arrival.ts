/**
 * A processor file that reports what its job's data arrived as: the data,
 * and the type of each field (`"date"` for a `Date`), so the example can tell
 * a schema's parsed output from its JSON copy across a `Worker`.
 *
 * Used by `03-job-registry/validating-job-data.ts`.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a report job answers with: its data as received, and each field's type. */
export interface Arrival {
  /** `job.data`, exactly as the processor received it. */
  data: unknown;
  /** Each field's `typeof`, or `"date"` for a `Date`. */
  types: Record<string, string>;
}

export default defineProcessor<Record<string, unknown>, Arrival>((job) => ({
  data: job.data,
  types: Object.fromEntries(
    Object.entries(job.data ?? {}).map(([key, value]) => [
      key,
      value instanceof Date ? "date" : typeof value,
    ]),
  ),
}));
