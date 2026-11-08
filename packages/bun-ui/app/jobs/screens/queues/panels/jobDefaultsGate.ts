import { useCan, useMeta } from "../../../meta/hooks";
import { useCanMutate } from "../gating";

/** What the queue screen needs to know about the Job defaults panel. */
export interface JobDefaultsGate {
  /** Whether the panel is offered at all. */
  shown: boolean;
  /** Whether its Settings… editor is offered: mutation `queues.defaults`. */
  canEdit: boolean;
  /** Whether its Apply to pending jobs… action is offered: mutation `queues.applyDefaults`, separate from editing. */
  canApply: boolean;
}

/**
 * Whether the queue's job defaults can be shown, edited and applied.
 *
 * `features.jobDefaults` says the API serves the job-defaults routes (every
 * built-in backend; false in `runner` mode), and `features.jobDefaultsApply`
 * the apply route. Reading needs `queues.read`, as the limits do; editing
 * (`queues.defaults`) and applying (`queues.applyDefaults`) are separate
 * opt-in mutations, so someone may edit without being allowed to rewrite the
 * backlog. Where the flag is off nothing is requested.
 */
export function useJobDefaultsGate(): JobDefaultsGate {
  const meta = useMeta();
  const canRead = useCan("queues.read");
  const canMutate = useCanMutate();
  const shown = meta.features.jobDefaults && canRead;
  return {
    shown,
    canEdit: shown && canMutate("queues.defaults"),
    canApply:
      shown &&
      meta.features.jobDefaultsApply &&
      canMutate("queues.applyDefaults"),
  };
}
