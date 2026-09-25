import type { WorkerTargetKind } from "../../api/contract";
import type { WorkerDto, WorkerTargetInfoDto } from "../../api/types";
import { displayText } from "../../format";

/**
 * How a worker's `target` reads: where its attempts run, and whether they run
 * a function or a processor file.
 *
 * It is a fact about how the worker was **built**, not a setting — the field
 * is not among `WORKER_CONFIG_KEYS`, and changing where code runs is a
 * rebuild — so nothing here offers to change it.
 *
 * Two rules from the contract shape every function below:
 *
 * - **Absent is not "in process".** A worker too old to report the field has
 *   said nothing; `"in-process"` is merely the default, so reading absence as
 *   it would mislabel every worker that has not been upgraded.
 * - **A kind this build does not know is shown as its raw string**, since a
 *   later server may add one. The labels are an exhaustive record of the
 *   kinds the contract lists, so a kind added there is a compile error here
 *   until it is named.
 *
 * The words are the worker's own ("worker thread", "child process"), never a
 * runner's `executionMode` vocabulary: the two are different fields.
 */

/** Each known target kind in plain words, and what it means. */
const KIND_TEXT: Readonly<
  Record<WorkerTargetKind, { label: string; hint: string }>
> = {
  "in-process": {
    label: "In process",
    hint: "Its attempts run in the worker's own process, on the thread that claims them.",
  },
  "worker-thread": {
    label: "Worker thread",
    hint: "Each attempt runs on a fresh worker thread (a Web Worker) inside the worker's process.",
  },
  "child-process": {
    label: "Child process",
    hint: "Each attempt runs in a fresh child process, which can be killed if it ignores its signal.",
  },
  custom: {
    label: "Custom",
    hint: "Its attempts run on a target the application supplied.",
  },
};

/** Each known processor form in plain words. */
const PROCESSOR_LABEL: Readonly<
  Record<WorkerTargetInfoDto["processor"], string>
> = {
  function: "Function",
  file: "File",
};

/** Said of every target: it comes from the code, so no dialog changes it. */
const FIXED_NOTE =
  "Set in the worker's code when it was built; changing it is a redeploy, not a setting.";

/** Whether `kind` is one this build names (an own key, so `"toString"` is not). */
function isKnownKind(kind: unknown): kind is WorkerTargetKind {
  return typeof kind === "string" && Object.hasOwn(KIND_TEXT, kind);
}

/**
 * A target kind in plain words: "In process", "Worker thread", "Child
 * process", "Custom" — or the raw string for a kind this build does not know.
 */
export function targetKindLabel(kind: WorkerTargetInfoDto["kind"]): string {
  return isKnownKind(kind) ? KIND_TEXT[kind].label : displayText(kind);
}

/**
 * The processor form in plain words, "Function" or "File" — or the raw string
 * for a form this build does not know.
 */
export function processorLabel(
  processor: WorkerTargetInfoDto["processor"],
): string {
  return typeof processor === "string" &&
    Object.hasOwn(PROCESSOR_LABEL, processor)
    ? PROCESSOR_LABEL[processor]
    : displayText(processor);
}

/**
 * What a worker table's target badge reads: the kind in plain words, and for
 * a `custom` target its own `name` (plain "Custom" when it gave none).
 */
export function targetBadgeLabel(target: WorkerTargetInfoDto): string {
  if (target.kind === "custom" && target.name !== undefined) {
    return displayText(target.name);
  }
  return targetKindLabel(target.kind);
}

/** What a target kind means, in a sentence; for a kind this build does not know, says so. */
export function targetKindHint(kind: WorkerTargetInfoDto["kind"]): string {
  return isKnownKind(kind)
    ? KIND_TEXT[kind].hint
    : `Its attempts run on a target this version of the UI does not know ("${displayText(kind)}").`;
}

/** The target badge's tooltip: what the kind means, and that it is not a setting. */
export function targetHint(target: WorkerTargetInfoDto): string {
  const meaning = targetKindHint(target.kind);
  const custom =
    target.kind === "custom" && target.name !== undefined
      ? ` Named "${displayText(target.name)}" by the application.`
      : "";
  return `${meaning}${custom} ${FIXED_NOTE}`;
}

/** The note under a Target card's kind. */
export const TARGET_FIXED_NOTE = FIXED_NOTE;

/**
 * One way the instances of a worker key run, with the instances that report
 * it. `target` is `undefined` for the instances too old to say.
 */
export interface TargetGroup {
  /** The target these instances report, or `undefined` for those that report none. */
  target: WorkerTargetInfoDto | undefined;
  /** Their incarnation ids, in the order the listing gave them. */
  ids: string[];
}

/** A stable identity for a target: every field the API sent, in order. */
function signature(target: WorkerTargetInfoDto | undefined): string {
  return target === undefined
    ? ""
    : JSON.stringify([target.kind, target.processor, target.name, target.file]);
}

/**
 * The instances of one key grouped by the target they report, in the order
 * each target first appears.
 *
 * Instances of a key are normally built from one piece of code and report
 * one target; two groups means they differ — a redeploy still rolling out, or
 * replicas deployed from different code — and a card showing only the first
 * instance's would hide that. A path the API withheld cannot tell two
 * instances apart, which is right: nothing on screen would differ either.
 */
export function groupTargets(instances: readonly WorkerDto[]): TargetGroup[] {
  const groups = new Map<string, TargetGroup>();
  for (const worker of instances) {
    const id = signature(worker.target);
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, { target: worker.target, ids: [worker.id] });
    } else {
      group.ids.push(worker.id);
    }
  }
  return [...groups.values()];
}
