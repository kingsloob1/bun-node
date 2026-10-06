import type { ApiError } from "../../api/errors";
import type { AddFlowBody, AddFlowJobOptions } from "../../api/types";
import type { AddJobField, AddJobForm } from "./addJobForm";
import { MAX_NAME_LENGTH, NAME_PARAM_PATTERN } from "../../api/contract";
import { addBody, checkJobId, validateAddForm } from "./addJobForm";
import { explainJobError } from "./jobErrors";

/**
 * The add-flow form: a tree of {@link AddJobForm}s, its client-side checks
 * (the API's, run before sending), its request body, and the placing of an
 * API problem on the node and field it is about. No React here.
 *
 * A node's **path** is where it sits in the body the API is sent: `""` for
 * the top job, `children.1.children.0` below it, which is how the API names
 * nodes in its issue paths and `context.path`. Errors are keyed by node
 * **key** instead, so they stay with their node while the tree is edited.
 */

/** One job of the flow, with the jobs it waits on. */
export interface FlowNode {
  /** A stable React key, unique within the flow; errors are keyed by it too. */
  key: string;
  /** The job's own fields, as the add-job dialog has them. */
  form: AddJobForm;
  /** The queue it goes in; `""` for its parent's. Always `""` on the top job, which goes in the screen's queue. */
  queue: string;
  /** Its parent carries on if it fails (`opts.ignoreFailure`). Children only: `true` on the top job is refused. */
  ignoreFailure: boolean;
  /** The jobs it waits on, in body order. */
  children: FlowNode[];
}

/** The API's bounds on one flow (`MetaDto.limits`). */
export interface FlowLimits {
  /** `limits.maxFlowNodes`: most jobs in one flow, the top job included. */
  maxNodes: number;
  /** `limits.maxFlowDepth`: most levels, the top job being level 1. */
  maxDepth: number;
}

/** A field of a flow node that can carry an error. */
export type FlowField =
  | AddJobField
  /** Its queue: a malformed name, or the API refusing or not knowing it. */
  | "queue"
  /** `ignoreFailure` where it is not allowed (the top job). */
  | "opts.ignoreFailure"
  /** The node itself: past a bound, or an issue at a field the form does not show. */
  | "node";

/** Problems of one node, per field. */
export type FlowNodeErrors = Partial<Record<FlowField, string>>;

/** Problems of a flow, per node key; a node without any is absent. */
export type FlowErrors = Record<string, FlowNodeErrors>;

/** One node of a flow as the body places it. */
export interface PlacedFlowNode {
  /** The node. */
  node: FlowNode;
  /** Its path in the body (see the module comment). */
  path: string;
  /** The queue it goes in: its own, else its parent's (the top job's is the screen's). */
  queue: string;
  /** Its level, the top job being 1. */
  level: number;
  /** Its parent's key; `null` for the top job. */
  parent: string | null;
}

/** The counter behind {@link nextFlowKey}. */
let keyCounter = 0;

/** A fresh node key, never handed out before in this page's life. */
export function nextFlowKey(): string {
  keyCounter += 1;
  return `flow-node-${keyCounter}`;
}

/** A node with `form` and no children, going in its parent's queue. */
export function flowNode(form: AddJobForm): FlowNode {
  return {
    key: nextFlowKey(),
    form,
    queue: "",
    ignoreFailure: false,
    children: [],
  };
}

/** `path` joined to a segment below it, without a leading dot at the top. */
function pathAt(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

/** Every node in body order (each before its children), placed. */
export function placeFlow(root: FlowNode, topQueue: string): PlacedFlowNode[] {
  const placed: PlacedFlowNode[] = [];
  const visit = (
    node: FlowNode,
    path: string,
    queue: string,
    level: number,
    parent: string | null,
  ) => {
    placed.push({ node, path, queue, level, parent });
    node.children.forEach((child, index) =>
      visit(
        child,
        pathAt(path, `children.${index}`),
        child.queue === "" ? queue : child.queue,
        level + 1,
        node.key,
      ),
    );
  };
  visit(root, "", topQueue, 1, null);
  return placed;
}

/** How many jobs the flow holds, the top job included. */
export function countFlowNodes(root: FlowNode): number {
  return root.children.reduce((sum, child) => sum + countFlowNodes(child), 1);
}

/** How many levels the flow nests, the top job being 1. */
export function flowDepth(root: FlowNode): number {
  return 1 + Math.max(0, ...root.children.map(flowDepth));
}

/** The distinct queues the flow writes to, the screen's first. */
export function flowQueues(root: FlowNode, topQueue: string): string[] {
  return [...new Set(placeFlow(root, topQueue).map((entry) => entry.queue))];
}

/** The node `key`, or `undefined`. */
export function findFlowNode(
  root: FlowNode,
  key: string,
): FlowNode | undefined {
  if (root.key === key) {
    return root;
  }
  for (const child of root.children) {
    const found = findFlowNode(child, key);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** `root` with node `key` replaced by what `change` makes of it (the same object when `key` is not there). */
function mapNode(
  root: FlowNode,
  key: string,
  change: (node: FlowNode) => FlowNode,
): FlowNode {
  if (root.key === key) {
    return change(root);
  }
  let changed = false;
  const children = root.children.map((child) => {
    const next = mapNode(child, key, change);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** What {@link updateFlowNode} may change: everything but the key and the children. */
export type FlowNodePatch = Partial<Omit<FlowNode, "key" | "children">>;

/** `root` with `patch` applied to node `key`. */
export function updateFlowNode(
  root: FlowNode,
  key: string,
  patch: FlowNodePatch,
): FlowNode {
  return mapNode(root, key, (node) => ({ ...node, ...patch }));
}

/** `root` with `child` appended to node `parentKey`'s children. Limits are the caller's to check ({@link addChildBlocked}). */
export function addFlowChild(
  root: FlowNode,
  parentKey: string,
  child: FlowNode,
): FlowNode {
  return mapNode(root, parentKey, (node) => ({
    ...node,
    children: [...node.children, child],
  }));
}

/** `root` without node `key` and everything below it. The top job cannot be removed: `root` comes back as it was. */
export function removeFlowNode(root: FlowNode, key: string): FlowNode {
  if (!root.children.some((child) => child.key === key)) {
    let changed = false;
    const children = root.children.map((child) => {
      const next = removeFlowNode(child, key);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...root, children } : root;
  }
  return {
    ...root,
    children: root.children.filter((child) => child.key !== key),
  };
}

/** `root` with node `key` moved `by` places among its siblings, clamped to the ends. */
export function moveFlowNode(
  root: FlowNode,
  key: string,
  by: number,
): FlowNode {
  const index = root.children.findIndex((child) => child.key === key);
  if (index === -1) {
    let changed = false;
    const children = root.children.map((child) => {
      const next = moveFlowNode(child, key, by);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...root, children } : root;
  }
  const target = Math.min(root.children.length - 1, Math.max(0, index + by));
  if (target === index) {
    return root;
  }
  const children = [...root.children];
  const [moved] = children.splice(index, 1);
  children.splice(target, 0, moved!);
  return { ...root, children };
}

/**
 * Why node `key` cannot take another child, or `null` when it can: the flow
 * already holds `maxNodes` jobs, or the node sits at `maxDepth` (a child
 * would be one level too deep).
 */
export function addChildBlocked(
  root: FlowNode,
  key: string,
  limits: FlowLimits,
): string | null {
  if (countFlowNodes(root) >= limits.maxNodes) {
    return `The flow holds ${limits.maxNodes} jobs, the most the API accepts.`;
  }
  const entry = placeFlow(root, "").find((placed) => placed.node.key === key);
  if (entry && entry.level >= limits.maxDepth) {
    return `This job is at level ${entry.level}; a flow nests at most ${limits.maxDepth} levels.`;
  }
  return null;
}

/** Why a child's own queue would be refused, or `undefined` (`""` takes its parent's). */
export function checkFlowQueue(queue: string): string | undefined {
  if (queue === "") {
    return undefined;
  }
  if (queue.length > MAX_NAME_LENGTH) {
    return `At most ${MAX_NAME_LENGTH} characters.`;
  }
  return new RegExp(NAME_PARAM_PATTERN).test(queue)
    ? undefined
    : "Letters, digits, “_”, “.” and “-” only, and not “.” or “..”.";
}

/** Records `message` on `key`'s `field` unless something got there first. */
function put(
  errors: FlowErrors,
  key: string,
  field: FlowField,
  message: string,
): void {
  const node = (errors[key] ??= {});
  node[field] ??= message;
}

/**
 * Checks the flow the way the API would: each job's own fields (as the
 * add-job dialog checks them), a child's queue name, the bounds (at the
 * first job past each, as the API reports it), `ignoreFailure` on the top
 * job, and a `queue:jobId` given twice (on every job sharing it, the queue
 * being each job's effective one). `{}` when it may be sent.
 */
export function validateFlow(
  root: FlowNode,
  topQueue: string,
  limits: FlowLimits,
): FlowErrors {
  const errors: FlowErrors = {};
  const placed = placeFlow(root, topQueue);
  const byId = new Map<string, PlacedFlowNode[]>();
  let tooMany = false;
  let tooDeep = false;
  placed.forEach((entry, index) => {
    const { node, queue, level, parent } = entry;
    for (const [field, message] of Object.entries(validateAddForm(node.form))) {
      put(errors, node.key, field as AddJobField, message);
    }
    if (parent !== null) {
      const queueProblem = checkFlowQueue(node.queue);
      if (queueProblem) {
        put(errors, node.key, "queue", queueProblem);
      }
    } else if (node.ignoreFailure) {
      put(
        errors,
        node.key,
        "opts.ignoreFailure",
        "The top job has no parent to carry on without it.",
      );
    }
    if (!tooMany && index >= limits.maxNodes) {
      tooMany = true;
      put(
        errors,
        node.key,
        "node",
        `A flow may hold at most ${limits.maxNodes} jobs.`,
      );
    }
    if (!tooDeep && level > limits.maxDepth) {
      tooDeep = true;
      put(
        errors,
        node.key,
        "node",
        `A flow may nest at most ${limits.maxDepth} levels.`,
      );
    }
    if (node.form.jobId !== "" && checkJobId(node.form.jobId) === undefined) {
      const id = `${queue}:${node.form.jobId}`;
      byId.set(id, [...(byId.get(id) ?? []), entry]);
    }
  });
  for (const [id, entries] of byId) {
    if (entries.length > 1) {
      for (const { node } of entries) {
        put(
          errors,
          node.key,
          "opts.jobId",
          `Another job of this flow has the same queue and id (${id}).`,
        );
      }
    }
  }
  return errors;
}

/** Whether {@link validateFlow} found anything. */
export function hasFlowErrors(errors: FlowErrors): boolean {
  return Object.values(errors).some((node) => Object.keys(node).length > 0);
}

/**
 * The request body for a valid flow: each job as the add-job dialog sends
 * it (empty options left out), `ignoreFailure` only where set on a child,
 * `queue` only on a child going somewhere other than its parent's queue
 * (naming the parent's own is left out too), and `children` only where
 * there are some. The top job never names its queue: the path does.
 */
export function flowBody(root: FlowNode, topQueue: string): AddFlowBody {
  const build = (node: FlowNode, parentQueue: string | null): AddFlowBody => {
    const job = addBody(node.form);
    const isChild = parentQueue !== null;
    const opts: AddFlowJobOptions = {
      ...job.opts,
      ...(isChild && node.ignoreFailure ? { ignoreFailure: true } : {}),
    };
    const queue = !isChild
      ? topQueue
      : node.queue === ""
        ? parentQueue
        : node.queue;
    return {
      name: job.name,
      data: job.data,
      ...(Object.keys(opts).length > 0 ? { opts } : {}),
      ...(isChild && queue !== parentQueue ? { queue } : {}),
      ...(node.children.length > 0
        ? { children: node.children.map((child) => build(child, queue)) }
        : {}),
    };
  };
  return build(root, null);
}

/** What {@link flowProblemErrors} made of a problem. */
export interface PlacedFlowProblem {
  /** The messages it placed, per node and field. */
  errors: FlowErrors;
  /** Whether some of it could not be placed on a node, so the dialog shows it in a banner as well. */
  unplaced: boolean;
}

/** The fields an issue path's remainder can name directly. */
const PLACEABLE_FIELDS: ReadonlySet<string> = new Set<FlowField>([
  "name",
  "data",
  "queue",
  "opts.jobId",
  "opts.priority",
  "opts.delay",
  "opts.runAt",
  "opts.attempts",
  "opts.backoff",
  "opts.timeout",
  "opts.ignoreFailure",
]);

/**
 * The node a body path points into, and the field below it: `children.1.name`
 * is the second child's `name`; `children.99` is that node itself
 * (`"node"`). A path into `data` is the data. A field the form does not show
 * is the node's. `undefined` when the path leaves the tree.
 */
export function resolveFlowPath(
  placed: readonly PlacedFlowNode[],
  path: string,
): { key: string; field: FlowField } | undefined {
  const byPath = new Map(placed.map((entry) => [entry.path, entry.node.key]));
  const segments = path === "" ? [] : path.split(".");
  let nodePath = "";
  let index = 0;
  while (
    segments[index] === "children" &&
    /^\d+$/.test(segments[index + 1] ?? "")
  ) {
    nodePath = pathAt(nodePath, `children.${segments[index + 1]}`);
    index += 2;
  }
  const key = byPath.get(nodePath);
  if (key === undefined) {
    return undefined;
  }
  const rest = segments.slice(index).join(".");
  const field: FlowField =
    rest === ""
      ? "node"
      : PLACEABLE_FIELDS.has(rest)
        ? (rest as FlowField)
        : rest.startsWith("data.")
          ? "data"
          : "node";
  return { key, field };
}

/** The queue a queue-level refusal is about: `context.queue`, else the path's own (which the API leaves out). */
function refusedQueue(error: ApiError, topQueue: string): string {
  const queue = error.context.queue;
  return typeof queue === "string" && queue !== "" ? queue : topQueue;
}

/** What to say on a node whose queue the API refused. */
function queueRefusal(error: ApiError, queue: string): string {
  if (error.code === "QUEUE_NOT_FOUND") {
    return `The API does not manage a queue named “${queue}”.`;
  }
  return error.status === 401
    ? `Sign in to add jobs to “${queue}”.`
    : `You may not add jobs to “${queue}”.`;
}

/**
 * Places an API problem on the nodes of the flow it was sent as (`root`),
 * by key, so the messages survive later edits:
 *
 * - `VALIDATION`: each body issue at its path (the first per field wins);
 * - `NAME_NOT_ADDABLE`: on the name at `context.path`;
 * - a refused queue (`FORBIDDEN`/`UNAUTHORIZED`, `QUEUE_NOT_FOUND`): on the
 *   queue of every job going in `context.queue`, or in the path's queue when
 *   the context names none (a refusal of the path's own queue does not);
 * - anything else, or a part that matches no node: `unplaced`.
 */
export function flowProblemErrors(
  error: ApiError,
  root: FlowNode,
  topQueue: string,
): PlacedFlowProblem {
  const errors: FlowErrors = {};
  const placed = placeFlow(root, topQueue);
  let unplaced = false;
  if (error.code === "VALIDATION" && error.issues.length > 0) {
    for (const issue of error.issues) {
      const at =
        issue.target === "body"
          ? resolveFlowPath(placed, issue.path)
          : undefined;
      if (at) {
        put(errors, at.key, at.field, issue.message);
      } else {
        unplaced = true;
      }
    }
    return { errors, unplaced };
  }
  if (error.code === "NAME_NOT_ADDABLE") {
    const path = error.context.path;
    const at =
      typeof path === "string" ? resolveFlowPath(placed, path) : undefined;
    if (!at) {
      return { errors, unplaced: true };
    }
    put(
      errors,
      at.key,
      at.field,
      explainJobError(error, "add") ?? error.detail ?? error.title,
    );
    return { errors, unplaced: false };
  }
  if (
    error.code === "FORBIDDEN" ||
    error.code === "UNAUTHORIZED" ||
    error.code === "QUEUE_NOT_FOUND"
  ) {
    const queue = refusedQueue(error, topQueue);
    const message = queueRefusal(error, queue);
    const nodes = placed.filter((entry) => entry.queue === queue);
    for (const { node } of nodes) {
      put(errors, node.key, "queue", message);
    }
    return { errors, unplaced: nodes.length === 0 };
  }
  return { errors, unplaced: true };
}

/**
 * What node `key`'s `field` holds in a placed flow, in a form two placings
 * can be compared by: the job's effective queue for `queue` (so a child
 * taking its parent's queue changes when the parent's does), its path for
 * `node`, the timing with the value for `opts.delay` and `opts.runAt`.
 * `undefined` when the node is not in the flow.
 */
function fieldValue(
  placed: readonly PlacedFlowNode[],
  key: string,
  field: FlowField,
): unknown {
  const entry = placed.find((candidate) => candidate.node.key === key);
  if (entry === undefined) {
    return undefined;
  }
  const { node } = entry;
  switch (field) {
    case "node":
      return entry.path;
    case "queue":
      return entry.queue;
    case "opts.ignoreFailure":
      return node.ignoreFailure;
    case "name":
      return node.form.name;
    case "data":
      return node.form.data.text;
    case "opts.jobId":
      return node.form.jobId;
    case "opts.priority":
      return node.form.priority;
    case "opts.delay":
      return `${node.form.timing}:${node.form.delay}`;
    case "opts.runAt":
      return `${node.form.timing}:${node.form.runAt}`;
    case "opts.attempts":
      return node.form.attempts;
    case "opts.backoff":
      return node.form.backoff;
    case "opts.timeout":
      return node.form.timeout;
  }
}

/**
 * Whether node `key`'s `field` still holds what the flow `sent` had there, so
 * an API error about it still applies. Once the user edits the field (or, for
 * `queue`, anything that changes where the job goes), the error is stale and
 * the dialog stops showing it; the next send is the API's next word.
 */
export function fieldUnchangedSince(
  current: FlowNode,
  sent: FlowNode,
  topQueue: string,
  key: string,
  field: FlowField,
): boolean {
  return (
    fieldValue(placeFlow(current, topQueue), key, field) ===
    fieldValue(placeFlow(sent, topQueue), key, field)
  );
}
