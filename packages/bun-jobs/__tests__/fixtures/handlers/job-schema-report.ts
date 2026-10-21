import { defineProcessor } from "../../../lib/index";

/**
 * Reports what `job.data` arrived as on this target: the data, and each
 * field's type (`"date"` for a `Date`), so a test can tell a schema's parsed
 * output from the stored input across a `Worker` or a child process.
 */
export default defineProcessor<
  Record<string, unknown>,
  { data: unknown; types: Record<string, string> }
>(async (job) => ({
  data: job.data,
  types: Object.fromEntries(
    Object.entries(job.data ?? {}).map(([key, value]) => [
      key,
      value instanceof Date ? "date" : typeof value,
    ]),
  ),
}));
