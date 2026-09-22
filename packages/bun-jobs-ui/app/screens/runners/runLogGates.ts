import { useCan, useFeature } from "../../meta/hooks";

/**
 * Whether this caller gets run logs at all: the backend stores them
 * (`meta.features.runnerLogs`) and the caller may read them
 * (`runners.logs`, a default-on read like `jobs.logs`).
 *
 * Deliberately **not** `logLines !== undefined`: that field says what one
 * run recorded, and a run recorded before logs were kept would switch the
 * whole feature off for the screen.
 */
export function useCanReadRunLogs(): boolean {
  const feature = useFeature("runnerLogs");
  const allowed = useCan("runners.logs");
  return feature && allowed;
}
