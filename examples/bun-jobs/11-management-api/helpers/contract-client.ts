/**
 * A browser-safe client for the management API, written against nothing but
 * `@kingsleyweb/bun-jobs/api/contract`.
 *
 * That entry point holds the API's constants and a named type for every
 * request, response, socket frame and event, and imports nothing outside
 * itself — no driver, no bun-common, no `node:*` — so this file bundles for a
 * browser as it stands. `typed-client.ts` builds it for one to prove it.
 *
 * It reads `GET /meta` once and follows what it says: the CSRF header and
 * JSON rule for every mutation, the page size for queue lists, and where the
 * socket lives.
 */
import type {
  AddJobBody,
  AddJobResultDto,
  JobsApiClientMessage,
  JobsApiServerMessage,
  MetaDto,
  PermissionsDto,
  PermissionsQuery,
  ProblemDto,
  QueueListDto,
  QueueListQuery,
  QueueSummaryDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import {
  decodeJobId,
  encodeJobId,
  JOBS_API_WS_SUBPROTOCOL,
} from "@kingsleyweb/bun-jobs/api/contract";

/**
 * The channel of one job. Its id is escaped by the contract's `encodeJobId`:
 * `encodeURIComponent`, except that a lone UTF-16 surrogate (which that
 * throws on) becomes `%uXXXX` — so every id a queue accepts has a channel.
 */
export function jobChannel(queue: string, jobId: string): string {
  return `queue/${queue}/job/${encodeJobId(jobId)}`;
}

/** The queue and job id a job channel names; `undefined` for any other channel. */
export function jobOfChannel(
  channel: string,
): { queue: string; jobId: string } | undefined {
  const [kind, queue, job, encoded, ...rest] = channel.split("/");
  if (
    kind !== "queue" ||
    job !== "job" ||
    !queue ||
    !encoded ||
    rest.length > 0
  ) {
    return undefined;
  }
  return { queue, jobId: decodeJobId(encoded) };
}

/** A refusal from the API, carrying its RFC 9457 problem. */
export class JobsApiProblem extends Error {
  /** The problem the API answered with. */
  readonly problem: ProblemDto;

  constructor(
    /** The problem the API answered with. */
    problem: ProblemDto,
  ) {
    super(
      `${problem.status} ${problem.code}: ${problem.detail ?? problem.title}`,
    );
    this.name = "JobsApiProblem";
    this.problem = problem;
  }
}

/** Options for {@link connectJobsClient}. */
export interface JobsClientOptions {
  /** Where the API is mounted, e.g. `https://admin.example/admin/jobs`. */
  baseUrl: string;
  /** Sent with every request, e.g. an `authorization` header. */
  headers?: Record<string, string>;
  /** The value sent in the CSRF header, when `/meta` names one. Defaults to `"1"`. */
  csrfValue?: string;
}

/** A client that has read `/meta`. */
export interface JobsClient {
  /** What `/meta` answered when the client connected. */
  meta: MetaDto;
  /** One page of queues; `limit` defaults to the API's `limits.maxQueues`. */
  queues: (query?: QueueListQuery) => Promise<QueueListDto>;
  /** Every matching queue, page by page. */
  allQueues: (search?: string) => Promise<QueueSummaryDto[]>;
  /** Adds a job, refusing locally a name `/meta` says the API will refuse. */
  addJob: (queue: string, body: AddJobBody) => Promise<AddJobResultDto>;
  /** What the caller may do, optionally previewing one socket channel. */
  permissions: (query?: PermissionsQuery) => Promise<PermissionsDto>;
  /** Opens the live-events socket, offering the API's subprotocol. */
  openSocket: () => JobsClientSocket;
}

/** One kind of server frame, narrowed by its `type`. */
export type FrameOf<K extends JobsApiServerMessage["type"]> = Extract<
  JobsApiServerMessage,
  { type: K }
>;

/** The live-events socket, typed by the contract's frames. */
export interface JobsClientSocket {
  /** The underlying `WebSocket`. */
  socket: WebSocket;
  /** Every frame received so far, in order. */
  frames: JobsApiServerMessage[];
  /** Sends one client frame. */
  send: (message: JobsApiClientMessage) => void;
  /**
   * Resolves with the first frame of `type`, received or still to come, that
   * `match` accepts; rejects if the socket closes first (a refused upgrade
   * included).
   */
  next: <K extends JobsApiServerMessage["type"]>(
    type: K,
    match?: (frame: FrameOf<K>) => boolean,
  ) => Promise<FrameOf<K>>;
}

/** Reads `/meta` and returns a client that follows it. */
export async function connectJobsClient(
  options: JobsClientOptions,
): Promise<JobsClient> {
  const base = options.baseUrl.replace(/\/$/, "");
  /** The CSRF header `/meta` names, once it has answered. */
  let csrfHeader: string | null = null;

  /** One request; a problem response throws {@link JobsApiProblem}. */
  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const headers: Record<string, string> = { ...options.headers };
    if (method === "POST") {
      // Every POST is JSON when `requireJson` says so, even one with no body.
      headers["content-type"] = "application/json";
      if (csrfHeader) {
        headers[csrfHeader] = options.csrfValue ?? "1";
      }
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new JobsApiProblem(payload as ProblemDto);
    }
    return payload as T;
  };

  const known = await request<MetaDto>("GET", "/meta");
  csrfHeader = known.csrf.header;

  /** A query string from defined values. */
  const query = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const text = params.toString();
    return text ? `?${text}` : "";
  };

  const queues: JobsClient["queues"] = async (list = {}) =>
    await request<QueueListDto>(
      "GET",
      `/queues${query({
        search: list.search,
        offset: list.offset,
        limit: list.limit ?? known.limits.maxQueues,
      })}`,
    );

  return {
    meta: known,
    queues,
    allQueues: async (search) => {
      const all: QueueSummaryDto[] = [];
      let offset = 0;
      for (;;) {
        const page = await queues({ search, offset });
        all.push(...page.items);
        if (!page.page.hasMore) {
          return all;
        }
        offset += page.items.length;
      }
    },
    addJob: async (queue, body) => {
      if (
        known.addableNames !== null &&
        !known.addableNames.includes(body.name)
      ) {
        throw new Error(`"${body.name}" is not an addable job name here`);
      }
      return await request<AddJobResultDto>(
        "POST",
        `/queues/${encodeURIComponent(queue)}/jobs`,
        body,
      );
    },
    permissions: async (asked = {}) =>
      await request<PermissionsDto>(
        "GET",
        `/meta/permissions${query({
          queue: asked.queue,
          runner: asked.runner,
          channel: asked.channel,
        })}`,
      ),
    openSocket: () => {
      if (!known.websocket) {
        throw new Error("This API has no live-events socket");
      }
      const origin = new URL(base);
      const port = known.websocket.port ?? origin.port;
      const scheme = origin.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(
        `${scheme}://${origin.hostname}${port ? `:${port}` : ""}${known.websocket.path}`,
        [JOBS_API_WS_SUBPROTOCOL],
      );
      const frames: JobsApiServerMessage[] = [];
      /** Waiters for a frame, each with its test. */
      const waiters: {
        match: (frame: JobsApiServerMessage) => boolean;
        resolve: (frame: JobsApiServerMessage) => void;
        reject: (error: Error) => void;
      }[] = [];
      /** Set once the socket has closed, or failed to open. */
      let ended: Error | undefined;
      const end = (reason: string) => {
        ended ??= new Error(`The live-events socket ${reason}`);
        for (const waiter of waiters.splice(0)) {
          waiter.reject(ended);
        }
      };
      socket.addEventListener("close", (event) => {
        end(`closed (${event.code})`);
      });
      socket.addEventListener("error", () => end("failed"));
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as JobsApiServerMessage;
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.match(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      });
      return {
        socket,
        frames,
        send: (message) => socket.send(JSON.stringify(message)),
        next: async <K extends JobsApiServerMessage["type"]>(
          type: K,
          match?: (frame: FrameOf<K>) => boolean,
        ) => {
          const accepts = (frame: JobsApiServerMessage) =>
            frame.type === type && (!match || match(frame as FrameOf<K>));
          const seen = frames.find(accepts);
          if (seen) {
            return seen as FrameOf<K>;
          }
          if (ended) {
            throw ended;
          }
          return await new Promise<FrameOf<K>>((resolve, reject) => {
            waiters.push({
              match: accepts,
              resolve: (frame) => resolve(frame as FrameOf<K>),
              reject,
            });
          });
        },
      };
    },
  };
}
