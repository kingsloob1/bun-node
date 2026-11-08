import type { JobsApiAction } from "../../api/contract";
import type { MetaDto } from "../../api/types";
import { useCanFn, useMeta } from "../../meta/hooks";

/**
 * Whether a mutation is offered: the caller holds the action **and** the API
 * is not read-only. A read-only API prunes its mutation routes (so the
 * permission is absent anyway); checking `readOnly` too keeps the rule true
 * even for a permissions map that says otherwise.
 */
export function useCanMutate(): (action: JobsApiAction) => boolean {
  const meta = useMeta();
  const can = useCanFn();
  return (action) => !meta.readOnly && can(action);
}

/** Whether the add-job dialog is offered: `jobs.add`, not read-only, and some name addable (`null` = any name). */
export function canAddJobs(meta: MetaDto, canAdd: boolean): boolean {
  return (
    canAdd &&
    !meta.readOnly &&
    (meta.addableNames === null || meta.addableNames.length > 0)
  );
}
