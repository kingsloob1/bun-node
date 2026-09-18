/**
 * One job's screen and the add-job dialog. `JobScreen` is routed from
 * `routes.tsx` at `/queues/:queue/jobs/:id`; the queue screen opens
 * `AddJobDialog` (its props are the contract between the two screens).
 */
export { AddJobDialog } from "./AddJobDialog";
export type { AddJobDialogProps } from "./AddJobDialog";
export { JobScreen } from "./JobScreen";
