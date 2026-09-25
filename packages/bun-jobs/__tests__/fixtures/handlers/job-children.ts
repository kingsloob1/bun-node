import { defineProcessor, UnrecoverableJobError } from "../../../lib/index";

/**
 * One file for every job in a flow, so each runs wherever the worker's target
 * runs it: `ok` reports its parent, `bad` fails for good, and the parent reports
 * what it can read about its children.
 */
export default defineProcessor<
  Record<string, never>,
  | { parent: { queue: string; id: string } | null }
  | {
      parent: { queue: string; id: string } | null;
      values: Record<string, unknown>;
      failures: Record<
        string,
        { isError: boolean; name: string; message: string }
      >;
    }
>(async (job) => {
  if (job.name === "bad") {
    throw new UnrecoverableJobError("optional source down");
  }

  if (job.name === "ok") {
    return { parent: job.parent };
  }

  const failures = await job.getChildrenFailures();

  return {
    parent: job.parent,
    values: await job.getChildrenValues(),
    failures: Object.fromEntries(
      Object.entries(failures).map(([key, error]) => [
        key,
        {
          isError: error instanceof Error,
          name: error.name,
          message: error.message,
        },
      ]),
    ),
  };
});
