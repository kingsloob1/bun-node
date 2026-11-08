/**
 * One job's screen and the add-job and add-flow dialogs. `JobScreen` is
 * routed from `routes.tsx` at `/queues/:queue/jobs/:id`; the queue screen
 * opens `AddJobDialog` and `AddFlowDialog` (their props are the contract
 * between the two screens). `AddFlowDialog` is the on-demand wrapper from
 * `../lazy`, so the dialog's code stays in a chunk of its own: render it only
 * while open.
 */
export { AddFlowDialog } from "../lazy";
export type { AddFlowDialogProps } from "./AddFlowDialog";
export { AddJobDialog } from "./AddJobDialog";
export type { AddJobDialogProps } from "./AddJobDialog";
export { JobScreen } from "./JobScreen";
