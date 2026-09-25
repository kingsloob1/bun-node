import type { RunProgress } from "../../../lib/index";
import { defineProcessor } from "../../../lib/index";

/**
 * Calls `job.fail()` in the ways the target tests compare across kinds,
 * chosen by the job's name, and reports what `fail()` answered through
 * `updateProgress` before settling:
 *
 * - `string`: fails with `data.reason`, then returns normally.
 * - `error`: fails with an `Error` whose own `cause` must survive too.
 * - `then-throw`: fails twice, then throws; the first reason must win.
 * - `child` / `parent`: a flow, where the child fails and the parent reports
 *   what it was told about it.
 * - `progress`: reports the stored progress it was handed, as narrowed.
 */
export default defineProcessor<{ reason?: string }, unknown>(async (job) => {
  switch (job.name) {
    case "string": {
      const answered = await job.fail(job.data.reason ?? "no reason");
      await job.updateProgress({ answered });
      return { returned: true };
    }
    case "error": {
      const answered = await job.fail(
        new Error("card declined", { cause: new Error("gateway timeout") }),
      );
      await job.updateProgress({ answered });
      return { returned: true };
    }
    case "then-throw": {
      const first = await job.fail("the first reason");
      const second = await job.fail("a change of mind");
      await job.updateProgress({ answered: first && second });
      throw new Error("thrown after fail()");
    }
    case "child": {
      await job.fail("optional source down");
      return { returned: true };
    }
    case "parent": {
      const failures = await job.getChildrenFailures();
      return Object.fromEntries(
        Object.entries(failures).map(([key, error]) => [
          key,
          { name: error.name, message: error.message },
        ]),
      );
    }
    case "progress": {
      // Typed as `Job` types it: a compile error here if the isolated job's
      // `progress` widens back to `unknown`.
      const progress: RunProgress | null = job.progress;
      await job.updateProgress({ seen: progress });
      return null;
    }
    default:
      throw new Error(`unexpected job ${job.name}`);
  }
});
