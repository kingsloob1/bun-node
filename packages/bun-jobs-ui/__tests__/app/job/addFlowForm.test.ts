import type {
  FlowLimits,
  FlowNode,
} from "../../../app/screens/job/addFlowForm";
import type { AddJobForm } from "../../../app/screens/job/addJobForm";
import { describe, expect, it } from "bun:test";
import { ApiError } from "../../../app/api/errors";
import { flowInvalidation } from "../../../app/api/jobs";
import {
  addChildBlocked,
  addFlowChild,
  checkFlowQueue,
  countFlowNodes,
  flowBody,
  flowDepth,
  flowNode,
  flowProblemErrors,
  flowQueues,
  hasFlowErrors,
  moveFlowNode,
  placeFlow,
  removeFlowNode,
  resolveFlowPath,
  updateFlowNode,
  validateFlow,
} from "../../../app/screens/job/addFlowForm";
import { emptyAddForm } from "../../../app/screens/job/addJobForm";
import { expectUndefined } from "../assert";
import { problem } from "../fixtures";

/** The screen's queue in every test. */
const TOP = "emails";

/** The API's real bounds. */
const LIMITS: FlowLimits = { maxNodes: 100, maxDepth: 10 };

/** A valid form named `name`, with `extra` over it. */
function form(name: string, extra: Partial<AddJobForm> = {}): AddJobForm {
  return { ...emptyAddForm({ addableNames: null }), name, ...extra };
}

/** A node named `name`. */
function node(
  name: string,
  options: {
    /** Its own queue (`""` for its parent's). */
    queue?: string;
    /** Its caller-chosen id. */
    jobId?: string;
    /** `ignoreFailure`. */
    ignoreFailure?: boolean;
    /** Its children. */
    children?: FlowNode[];
  } = {},
): FlowNode {
  return {
    ...flowNode(form(name, { jobId: options.jobId ?? "" })),
    queue: options.queue ?? "",
    ignoreFailure: options.ignoreFailure ?? false,
    children: options.children ?? [],
  };
}

/**
 * The tree most tests use:
 *
 *     parent (emails)
 *     ├─ a (reports)
 *     │  └─ a1 (reports, inherited)
 *     └─ b (emails, inherited)
 */
function sampleTree() {
  const a1 = node("a1");
  const a = node("a", { queue: "reports", children: [a1] });
  const b = node("b");
  const root = node("parent", { children: [a, b] });
  return { root, a, a1, b };
}

/** An `ApiError` as the client builds it from a problem body. */
function apiError(
  status: number,
  code: string,
  extra: Parameters<typeof problem>[3] = {},
): ApiError {
  return ApiError.fromProblem(problem(status, code, code, extra));
}

describe("the flow tree", () => {
  it("places each node in body order with its path, effective queue and level", () => {
    const { root } = sampleTree();
    expect(
      placeFlow(root, TOP).map(({ node: entry, path, queue, level }) => [
        entry.form.name,
        path,
        queue,
        level,
      ]),
    ).toEqual([
      ["parent", "", "emails", 1],
      ["a", "children.0", "reports", 2],
      ["a1", "children.0.children.0", "reports", 3],
      ["b", "children.1", "emails", 2],
    ]);
    expect(countFlowNodes(root)).toBe(4);
    expect(flowDepth(root)).toBe(3);
    expect(flowDepth(node("alone"))).toBe(1);
    expect(flowQueues(root, TOP)).toEqual(["emails", "reports"]);
  });

  it("adds, updates, moves and removes nodes without touching the original", () => {
    const { root, a, b } = sampleTree();
    const c = node("c");
    const added = addFlowChild(root, a.key, c);
    expect(added.children[0]!.children.map((n) => n.form.name)).toEqual([
      "a1",
      "c",
    ]);
    expect(root.children[0]!.children).toHaveLength(1);

    const renamed = updateFlowNode(added, c.key, { queue: "audit" });
    expect(renamed.children[0]!.children[1]!.queue).toBe("audit");
    expect(added.children[0]!.children[1]!.queue).toBe("");

    const moved = moveFlowNode(root, b.key, -1);
    expect(moved.children.map((n) => n.form.name)).toEqual(["b", "a"]);
    // Clamped at the ends: nothing to move past.
    expect(moveFlowNode(moved, b.key, -5)).toBe(moved);

    const removed = removeFlowNode(root, a.key);
    expect(removed.children.map((n) => n.form.name)).toEqual(["b"]);
    expect(countFlowNodes(removed)).toBe(2);
    // The top job cannot be removed.
    expect(removeFlowNode(root, root.key)).toBe(root);
  });

  it("says why a node cannot take another child: the node count, then the depth", () => {
    const { root, a, a1 } = sampleTree();
    expect(addChildBlocked(root, a.key, LIMITS)).toBe(null);
    expect(addChildBlocked(root, a.key, { maxNodes: 4, maxDepth: 10 })).toBe(
      "The flow holds 4 jobs, the most the API accepts.",
    );
    expect(addChildBlocked(root, a1.key, { maxNodes: 100, maxDepth: 3 })).toBe(
      "This job is at level 3; a flow nests at most 3 levels.",
    );
    // One level up is still allowed.
    expect(addChildBlocked(root, a.key, { maxNodes: 100, maxDepth: 3 })).toBe(
      null,
    );
  });
});

describe("validateFlow", () => {
  it("accepts a valid flow", () => {
    const { root } = sampleTree();
    const errors = validateFlow(root, TOP, LIMITS);
    expect(errors).toEqual({});
    expect(hasFlowErrors(errors)).toBe(false);
  });

  it("runs each node's own checks, on that node", () => {
    const { root, a1 } = sampleTree();
    const broken = updateFlowNode(root, a1.key, {
      form: form("", { attempts: 0 }),
    });
    expect(validateFlow(broken, TOP, LIMITS)).toEqual({
      [a1.key]: {
        name: "Pick or enter a job name.",
        "opts.attempts": "Enter 1 or more.",
      },
    });
  });

  it("checks a child's own queue name, and lets an empty one take its parent's", () => {
    expectUndefined(checkFlowQueue(""));
    expectUndefined(checkFlowQueue("reports.v2-eu_1"));
    for (const bad of ["a b", ".", "..", "x/y"]) {
      expect(checkFlowQueue(bad)).toBe(
        "Letters, digits, “_”, “.” and “-” only, and not “.” or “..”.",
      );
    }
    const { root, a } = sampleTree();
    const errors = validateFlow(
      updateFlowNode(root, a.key, { queue: "no good" }),
      TOP,
      LIMITS,
    );
    expect(Object.keys(errors)).toEqual([a.key]);
    expect(errors[a.key]!.queue).toContain("Letters, digits");
  });

  it("refuses ignoreFailure on the top job only", () => {
    const { root, a } = sampleTree();
    expect(
      validateFlow(
        updateFlowNode(root, a.key, { ignoreFailure: true }),
        TOP,
        LIMITS,
      ),
    ).toEqual({});
    expect(validateFlow({ ...root, ignoreFailure: true }, TOP, LIMITS)).toEqual(
      {
        [root.key]: {
          "opts.ignoreFailure":
            "The top job has no parent to carry on without it.",
        },
      },
    );
  });

  it("marks the first node past maxNodes, in body order, and only it", () => {
    const { root, a1, b } = sampleTree();
    const errors = validateFlow(root, TOP, { maxNodes: 2, maxDepth: 10 });
    // Body order: parent, a, a1, b — the third is a1.
    expect(errors).toEqual({
      [a1.key]: { node: "A flow may hold at most 2 jobs." },
    });
    expectUndefined(errors[b.key], "an error on the fourth node");
  });

  it("marks the first node deeper than maxDepth", () => {
    const { root, a1 } = sampleTree();
    expect(validateFlow(root, TOP, { maxNodes: 100, maxDepth: 2 })).toEqual({
      [a1.key]: { node: "A flow may nest at most 2 levels." },
    });
    expect(validateFlow(root, TOP, { maxNodes: 100, maxDepth: 3 })).toEqual({});
  });

  it("finds a queue:jobId given twice, resolving each queue through its parents", () => {
    // a goes in reports; a1 inherits reports: the same id twice there.
    const a1 = node("a1", { jobId: "x" });
    const a = node("a", { queue: "reports", jobId: "x", children: [a1] });
    // b and the top job share an id, but b's queue (reports, its own) differs.
    const b = node("b", { queue: "reports.v2", jobId: "top" });
    const root = node("parent", { jobId: "top", children: [a, b] });
    const errors = validateFlow(root, TOP, LIMITS);
    expect(Object.keys(errors).sort()).toEqual([a.key, a1.key].sort());
    expect(errors[a.key]!["opts.jobId"]).toBe(
      "Another job of this flow has the same queue and id (reports:x).",
    );
    expect(errors[a1.key]!["opts.jobId"]).toBe(errors[a.key]!["opts.jobId"]!);

    // Negative control: a1 in a queue of its own, and the clash is gone.
    expect(
      validateFlow(
        updateFlowNode(root, a1.key, { queue: "audit" }),
        TOP,
        LIMITS,
      ),
    ).toEqual({});
  });
});

describe("flowBody", () => {
  it("builds the tree across two queues, leaving out empty options and a queue equal to the parent's", () => {
    const a1 = node("a1", { queue: "reports", jobId: "g-1" });
    const a = node("a", {
      queue: "reports",
      ignoreFailure: true,
      children: [a1],
    });
    const b = node("b", { queue: "emails" });
    const root = {
      ...node("parent", { children: [a, b] }),
      form: form("parent", { priority: 2, data: jsonOf({ to: "ada" }) }),
    };
    expect(flowBody(root, TOP)).toEqual({
      name: "parent",
      data: { to: "ada" },
      opts: { priority: 2 },
      children: [
        {
          name: "a",
          data: {},
          opts: { ignoreFailure: true },
          queue: "reports",
          children: [{ name: "a1", data: {}, opts: { jobId: "g-1" } }],
        },
        { name: "b", data: {} },
      ],
    });
  });

  it("never sends the top job's queue or ignoreFailure", () => {
    const root = { ...node("parent"), ignoreFailure: true, queue: "other" };
    expect(flowBody(root, TOP)).toEqual({ name: "parent", data: {} });
  });
});

/** A data editor state holding `value`. */
function jsonOf(value: unknown): AddJobForm["data"] {
  return {
    ...emptyAddForm({ addableNames: null }).data,
    text: JSON.stringify(value),
    value,
  };
}

describe("flowProblemErrors", () => {
  it("places VALIDATION issues by path, nested ones included", () => {
    const { root, a, a1, b } = sampleTree();
    const placed = flowProblemErrors(
      apiError(400, "VALIDATION", {
        issues: [
          {
            target: "body",
            path: "children.0.children.0.name",
            message: "Too long",
          },
          {
            target: "body",
            path: "children.0.opts.attempts",
            message: "Must be ≥ 1",
          },
          { target: "body", path: "children.1.data.deep", message: "Bad data" },
          {
            target: "body",
            path: "children.1.opts.unknown",
            message: "Unknown option",
          },
          {
            target: "body",
            path: "queue",
            message: "The top job goes in the path's queue",
          },
        ],
      }),
      root,
      TOP,
    );
    expect(placed).toEqual({
      unplaced: false,
      errors: {
        [a1.key]: { name: "Too long" },
        [a.key]: { "opts.attempts": "Must be ≥ 1" },
        [b.key]: { data: "Bad data", node: "Unknown option" },
        [root.key]: { queue: "The top job goes in the path's queue" },
      },
    });
  });

  it("places a bound issue on the node past the bound", () => {
    const { root, b } = sampleTree();
    expect(
      flowProblemErrors(
        apiError(400, "VALIDATION", {
          issues: [
            {
              target: "body",
              path: "children.1",
              message: "A flow may hold at most 100 jobs",
            },
          ],
        }),
        root,
        TOP,
      ).errors,
    ).toEqual({ [b.key]: { node: "A flow may hold at most 100 jobs" } });
  });

  it("places a duplicate's two issues on both nodes", () => {
    const { root, a, b } = sampleTree();
    expect(
      flowProblemErrors(
        apiError(400, "VALIDATION", {
          issues: [
            {
              target: "body",
              path: "children.0.opts.jobId",
              message: "twice: also at children.1.opts.jobId",
            },
            {
              target: "body",
              path: "children.1.opts.jobId",
              message: "twice: also at children.0.opts.jobId",
            },
          ],
        }),
        root,
        TOP,
      ).errors,
    ).toEqual({
      [a.key]: { "opts.jobId": "twice: also at children.1.opts.jobId" },
      [b.key]: { "opts.jobId": "twice: also at children.0.opts.jobId" },
    });
  });

  it("reports an issue outside the tree, or not about the body, as unplaced", () => {
    const { root } = sampleTree();
    const placed = flowProblemErrors(
      apiError(400, "VALIDATION", {
        issues: [
          { target: "body", path: "children.7.name", message: "Nowhere" },
          { target: "params", path: "queue", message: "Bad queue" },
        ],
      }),
      root,
      TOP,
    );
    expect(placed).toEqual({ unplaced: true, errors: {} });
  });

  it("puts NAME_NOT_ADDABLE on the name at context.path", () => {
    const { root, a, b } = sampleTree();
    const placed = flowProblemErrors(
      apiError(403, "NAME_NOT_ADDABLE", {
        context: { name: "b", queue: "emails", path: "children.1.name" },
      }),
      root,
      TOP,
    );
    expect(placed.unplaced).toBe(false);
    expect(Object.keys(placed.errors)).toEqual([b.key]);
    expect(placed.errors[b.key]!.name).toContain(
      "Jobs named “b” may not be added",
    );
    expectUndefined(placed.errors[a.key]);
    // Without a path it cannot be placed.
    expect(
      flowProblemErrors(
        apiError(403, "NAME_NOT_ADDABLE", { context: { name: "b" } }),
        root,
        TOP,
      ).unplaced,
    ).toBe(true);
  });

  it("puts a refused queue on every node going in context.queue", () => {
    const { root, a, a1 } = sampleTree();
    expect(
      flowProblemErrors(
        apiError(403, "FORBIDDEN", { context: { queue: "reports" } }),
        root,
        TOP,
      ),
    ).toEqual({
      unplaced: false,
      errors: {
        [a.key]: { queue: "You may not add jobs to “reports”." },
        [a1.key]: { queue: "You may not add jobs to “reports”." },
      },
    });
  });

  it("falls back to the path's queue when a refusal names none", () => {
    const { root, b } = sampleTree();
    expect(
      flowProblemErrors(apiError(403, "FORBIDDEN"), root, TOP).errors,
    ).toEqual({
      [root.key]: { queue: "You may not add jobs to “emails”." },
      [b.key]: { queue: "You may not add jobs to “emails”." },
    });
  });

  it("words a 401 and a QUEUE_NOT_FOUND for what they are", () => {
    const { root, a } = sampleTree();
    expect(
      flowProblemErrors(
        apiError(401, "UNAUTHORIZED", { context: { queue: "reports" } }),
        root,
        TOP,
      ).errors[a.key],
    ).toEqual({ queue: "Sign in to add jobs to “reports”." });
    expect(
      flowProblemErrors(
        apiError(404, "QUEUE_NOT_FOUND", { context: { queue: "reports" } }),
        root,
        TOP,
      ).errors[a.key],
    ).toEqual({ queue: "The API does not manage a queue named “reports”." });
  });

  it("reports a refusal of a queue no node uses, and any other problem, as unplaced", () => {
    const { root } = sampleTree();
    expect(
      flowProblemErrors(
        apiError(403, "FORBIDDEN", { context: { queue: "audit" } }),
        root,
        TOP,
      ),
    ).toEqual({ unplaced: true, errors: {} });
    expect(
      flowProblemErrors(apiError(400, "SERIALIZATION"), root, TOP).unplaced,
    ).toBe(true);
  });
});

describe("resolveFlowPath", () => {
  it("resolves a node, its fields and paths leaving the tree", () => {
    const { root, a1 } = sampleTree();
    const placed = placeFlow(root, TOP);
    expect(resolveFlowPath(placed, "")).toEqual({
      key: root.key,
      field: "node",
    });
    expect(resolveFlowPath(placed, "children.0.children.0.opts.runAt")).toEqual(
      {
        key: a1.key,
        field: "opts.runAt",
      },
    );
    expectUndefined(resolveFlowPath(placed, "children.0.children.3"));
  });
});

describe("flowInvalidation", () => {
  it("covers every queue written to once, every queue list and the overview", () => {
    expect(flowInvalidation(["emails", "reports", "emails"])).toEqual([
      ["queue", "emails"],
      ["queue", "reports"],
      ["queues"],
      ["overview"],
    ]);
  });
});
