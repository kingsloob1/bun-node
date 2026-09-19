import type { JobRecord, JobState } from "./driver";

/**
 * The states `buryJob` takes a job from without a lock: every state a job
 * waits in. `active` needs the lock it is held under as well, and `completed`
 * and `dead` are finished — there is nothing left to fail.
 */
export const BURIABLE_STATES: readonly JobState[] = [
  "waiting",
  "delayed",
  "failed",
  "waiting-children",
];

/**
 * Whether `buryJob` may bury `job`: it waits in a {@link BURIABLE_STATES}
 * state, or is active under `token`.
 */
export function canBury(
  job: Pick<JobRecord, "state" | "lockToken">,
  token: string | undefined,
): boolean {
  if (job.state === "active") {
    return token !== undefined && job.lockToken === token;
  }

  return BURIABLE_STATES.includes(job.state);
}
