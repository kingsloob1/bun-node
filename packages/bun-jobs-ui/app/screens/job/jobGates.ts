import type { JobDto } from "../../api/types";
import { isFinished } from "../../api/jobs";
import { useCan, useFeature, useMeta } from "../../meta/hooks";

/** Which of a job's actions this caller gets, and for which state. */
export interface JobActionGates {
  /** Retry: `jobs.retry`, and the job has finished. */
  retry: boolean;
  /** Promote: `jobs.promote`, and the job is delayed. */
  promote: boolean;
  /** Remove: `jobs.remove`. */
  remove: boolean;
  /** Update: `jobs.update` (an opt-in) and `features.update`. */
  update: boolean;
}

/** Works out {@link JobActionGates}; every action is off under `readOnly`. */
export function useJobActionGates(job: JobDto): JobActionGates {
  const { readOnly } = useMeta();
  const canRetry = useCan("jobs.retry");
  const canPromote = useCan("jobs.promote");
  const canRemove = useCan("jobs.remove");
  const canUpdate = useCan("jobs.update");
  const updateFeature = useFeature("update");
  return {
    retry: !readOnly && canRetry && isFinished(job.state),
    promote: !readOnly && canPromote && job.state === "delayed",
    remove: !readOnly && canRemove,
    update: !readOnly && canUpdate && updateFeature,
  };
}
