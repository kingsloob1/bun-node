import type { BunRequest } from "@kingsleyweb/bun-common";
import type { BunQueue } from "../../queue/BunQueue";
import type { FlowNode, FlowResult } from "../../queue/types";
import type { ResolvedJobsApiConfig } from "../config";
import type {
  AddFlowJobOptions,
  AddFlowNodeBody,
  ProblemIssueDto,
} from "../contract/types";
import type { AddFlowResultOut } from "../schemas/jobs";
import type { AnyRouteDef, RouteServices } from "./define";
import { assertJobId } from "../../queue/options";
import { ConfigError } from "../../shared/errors";
import { decide } from "../auth";
import { isAddableName } from "../config";
import { ApiError, mapCallSiteError } from "../errors";
import {
  AddFlowBodySchema,
  AddFlowResultSchema,
  FLOW_ADD_METHODS,
  MAX_FLOW_DEPTH,
  MAX_FLOW_NODES,
} from "../schemas/jobs";
import { JOB_READ_INCLUDE, toJobDto } from "../serialize";
import { defineRoute } from "./define";
import { mapBounded, QueueParams, queueTarget, toEpoch } from "./support";

/**
 * `POST /queues/:queue/flows`: `BunQueue.addFlow` over HTTP, gated exactly as
 * `POST /queues/:queue/jobs` is — the same opt-in action, the same addable
 * names — and asked of `authorize` for every queue the flow writes to.
 */

/** The route's path, as `authorize` is told it. */
const FLOW_PATH = "/queues/:queue/flows";

/** One job of a flow body, placed: where it sits in the body and which queue it goes in. */
interface PlacedNode {
  /** The job as the body gave it. */
  node: AddFlowNodeBody;
  /** Its path in the body, `""` for the top job; a field's path is this plus `.name` and so on. */
  path: string;
  /** The queue it goes in: its own `queue`, else its parent's. */
  queue: string;
  /** Whether it is the top job. */
  top: boolean;
}

/** `path` joined to a field below it, without a leading dot at the top. */
function at(path: string, field: string): string {
  return path === "" ? field : `${path}.${field}`;
}

/**
 * Every job of a flow body in body order (each before its children), with
 * its path and queue. The body has passed its schema, so its bounds hold
 * ({@link MAX_FLOW_NODES}, {@link MAX_FLOW_DEPTH}) and the walk is small.
 */
function placeNodes(body: AddFlowNodeBody, top: string): PlacedNode[] {
  const placed: PlacedNode[] = [];
  const visit = (
    node: AddFlowNodeBody,
    path: string,
    queue: string,
    isTop: boolean,
  ) => {
    placed.push({ node, path, queue, top: isTop });
    (node.children ?? []).forEach((child, index) => {
      visit(child, at(path, `children.${index}`), child.queue ?? queue, false);
    });
  };
  visit(body, "", top, true);
  return placed;
}

/** The 400 for issues found in a flow body after its schema passed. */
function flowInvalid(issues: ProblemIssueDto[]): ApiError {
  return new ApiError("VALIDATION", 400, "The flow cannot be added as sent", {
    issues,
  });
}

/** A body issue at `path`. */
function issue(path: string, message: string): ProblemIssueDto {
  return { target: "body", path, message };
}

/**
 * Asks `authorize` about `jobs.add` once for each queue the flow writes to
 * besides the path's (which the route's own authorize step asked), at most
 * `FAN_OUT` at a time. Every answer is in before anything is written; the
 * first refusal in body order is answered, naming its queue in
 * `context.queue`.
 */
async function authorizeQueues(
  services: RouteServices,
  req: BunRequest,
  queues: readonly string[],
): Promise<void> {
  const ask = async (queue: string) =>
    await decide(services.config, req, {
      action: "jobs.add",
      transport: "http",
      queue,
      route: { method: "POST", path: FLOW_PATH },
    });
  const decisions = await mapBounded(queues, ask);
  decisions.forEach((decision, index) => {
    if (decision.allow) {
      return;
    }
    const queue = queues[index]!;
    throw decision.status === 401
      ? new ApiError(
          "UNAUTHORIZED",
          401,
          decision.reason ?? "Authentication required",
          { context: { queue } },
        )
      : new ApiError(
          "FORBIDDEN",
          403,
          decision.reason ?? `Not allowed to add jobs to queue "${queue}"`,
          { context: { queue } },
        );
  });
}

/**
 * What `addFlow` itself would refuse, and what this API adds to it, found
 * all at once with a path for each: `ignoreFailure` on the top job, a `jobId`
 * bun-jobs refuses, and a `queue:id` placed twice (both places are named).
 * Names are not checked here: see {@link nameNotAddable}.
 */
function ruleIssues(placed: readonly PlacedNode[]): ProblemIssueDto[] {
  const issues: ProblemIssueDto[] = [];
  const firstAt = new Map<string, string>();
  for (const { node, path, queue, top } of placed) {
    if (top && node.opts?.ignoreFailure === true) {
      issues.push(
        issue(
          at(path, "opts.ignoreFailure"),
          "The top job of a flow has no parent to carry on without it",
        ),
      );
    }
    const jobId = node.opts?.jobId;
    if (jobId === undefined) {
      continue;
    }
    const idPath = at(path, "opts.jobId");
    try {
      assertJobId(jobId, "jobId");
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      issues.push(issue(idPath, error.message));
      continue;
    }
    const key = `${queue}:${jobId}`;
    const first = firstAt.get(key);
    if (first === undefined) {
      firstAt.set(key, idPath);
      continue;
    }
    const twice = `Job "${key}" appears more than once in the flow`;
    issues.push(
      issue(first, `${twice}: also at ${idPath}`),
      issue(idPath, `${twice}: also at ${first}`),
    );
  }
  return issues;
}

/**
 * The 403 `NAME_NOT_ADDABLE` for the first job of a flow, in body order,
 * whose name may not be added — the single add's answer, with the same
 * `context.name`, plus the job's `queue` and the `path` of its name in the
 * body — or `undefined` when every name may be.
 */
function nameNotAddable(
  config: ResolvedJobsApiConfig,
  placed: readonly PlacedNode[],
): ApiError | undefined {
  const refused = placed.find(({ node }) => !isAddableName(config, node.name));
  if (!refused) {
    return undefined;
  }
  const { node, path, queue } = refused;
  return new ApiError(
    "NAME_NOT_ADDABLE",
    403,
    `Jobs named "${node.name}" may not be added over this API`,
    { context: { name: node.name, queue, path: at(path, "name") } },
  );
}

/** A flow body's job as `addFlow` takes it: `runAt` as epoch ms, the top job without `queue`. */
function toFlowNode(node: AddFlowNodeBody, top: boolean): FlowNode {
  const { runAt, ...rest } = (node.opts ?? {}) as AddFlowJobOptions;
  return {
    name: node.name,
    data: node.data,
    ...(node.opts === undefined
      ? {}
      : {
          opts: {
            ...rest,
            ...(runAt === undefined ? {} : { runAt: toEpoch(runAt) }),
          },
        }),
    ...(top || node.queue === undefined ? {} : { queue: node.queue }),
    ...(node.children === undefined
      ? {}
      : { children: node.children.map((child) => toFlowNode(child, false)) }),
  };
}

/** What `addFlow` answered, as the route answers it, in body order. */
function toResult(
  config: ResolvedJobsApiConfig,
  req: BunRequest,
  result: FlowResult,
): AddFlowResultOut {
  return {
    added: result.job.wasAdded,
    job: toJobDto(
      result.job.toJSON(),
      { queue: result.job.queue.queue, include: JOB_READ_INCLUDE, req },
      config.serialize,
    ),
    children: result.children.map((child) => toResult(config, req, child)),
  };
}

/** The flow route. */
export function addFlowRoute(config: ResolvedJobsApiConfig): AnyRouteDef {
  const { limits } = config;
  return defineRoute({
    method: "POST",
    path: FLOW_PATH,
    operationId: "addFlow",
    action: "jobs.add",
    mode: "jobs",
    requires: FLOW_ADD_METHODS,
    summary: "Add a flow: a job and the jobs it waits on",
    description: `\`BunQueue.addFlow\` over HTTP. Off by default, exactly as adding a job is: enabled only when the \`actions\` allow-list names \`jobs.add\`, never under \`readOnly\`, and only for names in \`addableNames\` (\`features.addFlow\` says whether the backend can add flows at all). Each job takes the options \`POST /queues/{queue}/jobs\` accepts, plus \`ignoreFailure\` on a child, and goes in its own \`queue\` (in the same namespace) or its parent's; the top job goes in the path's queue. \`authorize\` is asked about \`jobs.add\` once for every queue the flow writes to, and a refusal for any of them is 403 naming it in \`context.queue\`. Everything is checked before anything is written. At most ${MAX_FLOW_NODES} jobs, nested at most ${MAX_FLOW_DEPTH} levels (the top job is level 1), \`ignoreFailure\` not on the top job, a \`jobId\` bun-jobs accepts, and no \`queue:id\` twice: each refusal is a 400 \`VALIDATION\` whose issues give the path into the body, e.g. \`children.1.children.0.opts.jobId\`. Only a body that passes those has its names checked: the first job, in body order, whose name is not addable is 403 \`NAME_NOT_ADDABLE\`, as for a single job, with \`context\` \`{ name, queue, path }\`, \`path\` being that job's name, e.g. \`children.1.name\`. Children are added before their parents. 201 when the flow was added; 200 when the top \`jobId\` already existed, which is returned with nothing added below it. As for a single job, a queue need not exist yet, and when the API is limited to a configured list of queues a queue outside it is 404 \`QUEUE_NOT_FOUND\`.`,
    tags: ["Jobs"],
    params: QueueParams,
    body: AddFlowBodySchema,
    maxBodyBytes: limits.maxJobDataBytes,
    responses: { 200: AddFlowResultSchema, 201: AddFlowResultSchema },
    errors: [
      "INVALID_NAME",
      "QUEUE_NOT_FOUND",
      "NAME_NOT_ADDABLE",
      "SERIALIZATION",
    ],
    target: ({ params }) => queueTarget(params.queue),
    handler: async ({ params, body, services, req }) => {
      const top = queueTarget(params.queue).queue;
      if (body.queue !== undefined && body.queue !== top) {
        throw flowInvalid([
          issue(
            "queue",
            `The top job goes in the path's queue, "${top}": omit \`queue\` or give that`,
          ),
        ]);
      }
      const placed = placeNodes(body, top);
      const queues = [...new Set(placed.map((entry) => entry.queue))];

      // Every queue is authorized before the client is told anything else
      // about the body, and before anything is written.
      await authorizeQueues(
        services,
        req,
        queues.filter((queue) => queue !== top),
      );

      const issues = ruleIssues(placed);
      if (issues.length > 0) {
        throw flowInvalid(issues);
      }
      // After the 400s, and before any queue is resolved: the single add
      // checks the name before its queue too.
      const refused = nameNotAddable(services.config, placed);
      if (refused) {
        throw refused;
      }

      // Membership only: a configured list of queues still restricts. Like
      // the single add, a queue the backend does not know yet is no 404.
      let created = false;
      let topQueue: BunQueue<any, any, any> | undefined;
      for (const name of queues) {
        const resolved = await services.queues.getForAdd(name);
        created ||= resolved.created;
        topQueue ??= resolved.queue;
      }

      let result: FlowResult;
      try {
        result = await topQueue!.addFlow(toFlowNode(body, true));
      } catch (error) {
        throw mapCallSiteError(error, "jobInput");
      }
      if (created) {
        services.queues.invalidate();
      }
      return {
        status: result.job.wasAdded ? 201 : 200,
        body: toResult(services.config, req, result),
      };
    },
  });
}
