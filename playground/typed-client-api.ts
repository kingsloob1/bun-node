/**
 * The typed-client section's small API (`typed-client.ts`, served under
 * `/playground/client`): a `defineRoutes` registry with zod schemas, in the
 * shape of bun-client's codegen fixture app, plus a few routes that exist to
 * show one client behaviour each.
 *
 * Its route map is generated from this file and committed beside it:
 *
 * ```bash
 * cd playground
 * bun run gen:client          # writes typed-client-api.gen.ts and typed-client-api.zod.gen.ts
 * bun run check:client        # the same with --check: exit 1 when either is stale
 * ```
 *
 * `bun-client generate --module` reads the default export, a function
 * returning a router, and documents it as `{ title: "API", version: "1" }`;
 * the section's `devTypes()` endpoint documents the running copy the same
 * way, so the two give the same module.
 *
 * | Route | What it is for |
 * | --- | --- |
 * | `GET /api/users/:id` | a 200; a 404 whose `code` is narrowed to `x-bun-errors` (`NOT_FOUND`, `GONE`); an `ETag`, so a refetch is a 304; tags `user:{id}` and `users` |
 * | `GET /api/users` | the list, tagged `users` |
 * | `POST /api/users` | a body the client checks before sending (`email` is a format); `409 CONFLICT`; invalidates `users` |
 * | `DELETE /api/users/:id` | 204; invalidates `user:{id}` and `users` (a deleted user then reads `GONE`) |
 * | `GET /api/flaky/:ticket` | 503 with `Retry-After: 1` on a ticket's first request, then 200 |
 * | `GET /api/slow` | sleeps `?ms=` (default 1000, at most 5000) |
 * | `GET /api/brew` | declares a 200 and answers 418, which no manifest lists |
 * | `GET /api/drifted/:id` | declares a `User` and answers one whose `role` the schema refuses |
 * | `GET /api/orgs/:id` | behind bun-cache's `cacheResponse({ surrogateKeys: "Cache-Tag" })`, tagged `team:<team>` from the data |
 * | `GET /api/jobs/:id/events` | an event stream (`sse({ progress, done, gap })`) written with `res.sse({ contract, resume })`: three events with ids `1`–`3`, replayed after a known `Last-Event-ID`, a `gap` first for an unknown one |
 *
 * `extraApi` is one more route, `GET /api/users/:id/badge`, which the page's
 * "add a route" button mounts at run time: the dev endpoint's hash moves, so
 * a running `bun-client watch` rewrites its file.
 */
import type { Cache } from "@kingsleyweb/bun-cache";
import type {
  BunRequest,
  BunResponse,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { addCacheTags, cacheResponse } from "@kingsleyweb/bun-cache/http";
import {
  BunRouter,
  defineRoutes,
  sse,
  validate,
} from "@kingsleyweb/bun-common";
import { z } from "zod";

export const Role = z.enum(["admin", "member"]).meta({ id: "Role" });

export const User = z
  .object({
    id: z.string(),
    name: z.string().meta({ description: "The display name." }),
    email: z.email(),
    role: Role,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "User" });

export const Problem = z
  .object({
    type: z.string(),
    title: z.string(),
    code: z.string(),
    detail: z.string().optional(),
  })
  .meta({ id: "Problem" });

export const Org = z
  .object({ id: z.string(), name: z.string(), team: z.string() })
  .meta({ id: "Org" });

/** A user, as the API stores and answers it. */
export type StoredUser = z.output<typeof User>;

/** One request that reached the API, for the page's "server saw" column. */
export interface ServerHit {
  /** Its number: one more than the hit before it ({@link ApiState.seq}). */
  seq: number;
  /** When, in ms since the epoch. */
  at: number;
  /** The method. */
  method: string;
  /** The path under the API's mount, with its query (`/api/users/42?x=1`). */
  url: string;
  /** The `x-request-id` header, when sent (the tracing middleware sets one). */
  requestId?: string;
  /** The `If-None-Match` header, when sent (the query layer's revalidation). */
  ifNoneMatch?: string;
  /** The `Last-Event-ID` header, when sent (an event stream resuming). */
  lastEventId?: string;
}

/** The API's state: what its handlers read and write. */
export interface ApiState {
  /** The users, by id. */
  users: Map<string, StoredUser>;
  /** Ids deleted this run: reading one answers `404 GONE`. */
  deleted: Set<string>;
  /** The orgs, by id. */
  orgs: Map<string, z.output<typeof Org>>;
  /** Requests each `flaky` ticket has seen. */
  flaky: Map<string, number>;
  /** The next id `POST /api/users` gives. */
  nextId: number;
  /** Every request that reached the API, newest last (the last 200). */
  hits: ServerHit[];
  /** The last hit's number (`0` before any). */
  seq: number;
}

/** What {@link createApi} builds. */
export interface Api {
  /** The router: the registry at `/api`, a request log and a problem+json error handler. */
  router: BunRouter;
  /** The `extraApi` route on a router of its own, mounted beside {@link router} by the page's "add a route" button. */
  extraRouter: BunRouter;
  /** The handlers' state. */
  state: ApiState;
  /** The cache behind `GET /api/orgs/:id`. */
  cache: Cache;
  /**
   * The router documented with the extra route too: what the dev endpoint
   * documents after the "add a route" button. Built on first use.
   */
  withExtra: () => BunRouter;
}

/** The seed users. */
const SEED_USERS: StoredUser[] = [
  {
    id: "42",
    name: "Ada",
    email: "ada@example.com",
    role: "admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "43",
    name: "Grace",
    email: "grace@example.com",
    role: "member",
    createdAt: "2026-02-01T00:00:00.000Z",
  },
];

/** A problem+json body for `code`. */
function problem(code: string, title: string) {
  return { type: "about:blank", title, code };
}

/** The params of a route with one `:id`. */
const IdParams = z.object({ id: z.string() });

/** A job's event stream: the route's declaration, and its writer's contract. */
const JobEvents = sse({
  progress: z.object({ percent: z.number() }),
  done: z.object({ result: z.string() }),
  gap: null,
});

/** Records a request in `state.hits`, keeping the last 200. */
function record(state: ApiState, req: BunRequest): void {
  const requestId = req.get("x-request-id");
  const ifNoneMatch = req.get("if-none-match");
  const lastEventId = req.get("last-event-id");
  state.hits.push({
    seq: ++state.seq,
    at: Date.now(),
    method: req.method,
    url: req.originalUrl,
    ...(requestId == null ? {} : { requestId }),
    ...(ifNoneMatch == null ? {} : { ifNoneMatch }),
    ...(lastEventId == null ? {} : { lastEventId }),
  });
  if (state.hits.length > 200) state.hits.splice(0, state.hits.length - 200);
}

/** The registry, over `state`. */
function registry(state: ApiState) {
  return defineRoutes("/api", (r) => ({
    getUser: r
      .get(
        "/users/:id",
        validate(
          { params: IdParams },
          { responses: { 200: User, 404: Problem } },
        ),
        (req, res) => {
          const user = state.users.get(req.params.id);
          if (user !== undefined) {
            // An ETag, so the query layer's refetch can be answered 304.
            res.setEtag(true);
            res.status(200).json(user);
          } else if (state.deleted.has(req.params.id)) {
            res.status(404).json(problem("GONE", "That user was deleted"));
          } else {
            res.status(404).json(problem("NOT_FOUND", "No such user"));
          }
        },
      )
      .describe({
        summary: "Read one user",
        tags: ["Users"],
        errors: ["NOT_FOUND", "GONE"],
        cache: { tags: ["user:{id}", "users"] },
      }),
    listUsers: r
      .get(
        "/users",
        validate(
          { query: z.object({ role: Role.optional() }) },
          { responses: { 200: z.array(User) } },
        ),
        (req, res) => {
          const role = req.query.role;
          res
            .status(200)
            .json(
              [...state.users.values()].filter(
                (user) => role === undefined || user.role === role,
              ),
            );
        },
      )
      .describe({
        summary: "List the users",
        tags: ["Users"],
        cache: { tags: ["users"] },
      }),
    createUser: r
      .post(
        "/users",
        validate(
          {
            body: z.object({
              name: z.string().min(1),
              email: z.email(),
              role: Role.default("member"),
            }),
          },
          { responses: { 201: User, 409: Problem } },
        ),
        (req, res) => {
          const { name, email, role } = req.body;
          if ([...state.users.values()].some((u) => u.email === email)) {
            res.status(409).json(problem("CONFLICT", "That email is taken"));
            return;
          }
          const user: StoredUser = {
            id: String(state.nextId++),
            name,
            email,
            role,
            createdAt: new Date().toISOString(),
          };
          state.users.set(user.id, user);
          res.status(201).json(user);
        },
      )
      .describe({
        summary: "Create a user",
        tags: ["Users"],
        errors: ["CONFLICT"],
        cache: { invalidates: ["users"] },
      }),
    deleteUser: r
      .delete(
        "/users/:id",
        validate(
          { params: IdParams },
          { responses: { 204: null, 404: Problem } },
        ),
        (req, res) => {
          if (!state.users.delete(req.params.id)) {
            res.status(404).json(problem("NOT_FOUND", "No such user"));
            return;
          }
          state.deleted.add(req.params.id);
          void res.status(204).end();
        },
      )
      .describe({
        summary: "Delete a user",
        tags: ["Users"],
        errors: ["NOT_FOUND"],
        cache: { invalidates: ["user:{id}", "users"] },
      }),
    flaky: r
      .get(
        "/flaky/:ticket",
        validate(
          { params: z.object({ ticket: z.string() }) },
          {
            responses: {
              200: z.object({ ticket: z.string(), attempts: z.number() }),
              503: Problem,
            },
          },
        ),
        (req, res) => {
          const { ticket } = req.params;
          const attempts = (state.flaky.get(ticket) ?? 0) + 1;
          state.flaky.set(ticket, attempts);
          if (attempts === 1) {
            res.setHeader("retry-after", "1");
            res.status(503).json(problem("UNAVAILABLE", "Try again in 1 s"));
            return;
          }
          res.status(200).json({ ticket, attempts });
        },
      )
      .describe({
        summary: "Fail a ticket's first request, with Retry-After",
        tags: ["Failure modes"],
        errors: ["UNAVAILABLE"],
      }),
    slow: r
      .get(
        "/slow",
        validate(
          {
            query: z.object({
              ms: z.coerce.number().int().min(0).max(5000).default(1000),
            }),
          },
          { responses: { 200: z.object({ sleptMs: z.number() }) } },
        ),
        async (req, res) => {
          await Bun.sleep(req.query.ms);
          res.status(200).json({ sleptMs: req.query.ms });
        },
      )
      .describe({
        summary: "Answer after ?ms= milliseconds",
        tags: ["Failure modes"],
      }),
    brew: r
      .get(
        "/brew",
        validate({}, { responses: { 200: z.object({ coffee: z.string() }) } }),
        (_req, res) => {
          // Declared: a 200. Answered: a status no manifest lists, which
          // the typed `res` refuses, hence the plain BunResponse.
          (res as BunResponse)
            .status(418)
            .json(problem("TEAPOT", "I'm a teapot"));
        },
      )
      .describe({
        summary: "Brew coffee (it never does)",
        tags: ["Failure modes"],
      }),
    drifted: r
      .get(
        "/drifted/:id",
        validate({ params: IdParams }, { responses: { 200: User } }),
        (req, res) => {
          // A handler that drifted from its schema: `owner` is no Role. The
          // server does not check its responses here (responseValidation
          // is off by default), so the client's check is what sees it. The
          // typed `res` refuses the body, hence the plain BunResponse.
          (res as BunResponse).status(200).json({
            id: req.params.id,
            name: "Drift",
            email: "drift@example.com",
            role: "owner",
            createdAt: "2026-03-01T00:00:00.000Z",
          });
        },
      )
      .describe({
        summary: "Answer a body its own schema refuses",
        tags: ["Failure modes"],
      }),
    getOrg: r
      .get(
        "/orgs/:id",
        validate(
          { params: IdParams },
          { responses: { 200: Org, 404: Problem } },
        ),
        (req, res) => {
          const org = state.orgs.get(req.params.id);
          if (org === undefined) {
            res.status(404).json(problem("NOT_FOUND", "No such org"));
            return;
          }
          // A tag the route cannot declare: it comes from the data, and
          // reaches the client in the Cache-Tag header.
          addCacheTags(res, `team:${org.team}`);
          res.status(200).json(org);
        },
      )
      .describe({
        summary: "Read one org (cached)",
        tags: ["Orgs"],
        errors: ["NOT_FOUND"],
      }),
    jobEvents: r
      .get(
        "/jobs/:id/events",
        validate(
          { params: IdParams },
          {
            responses: {
              200: {
                content: { "text/event-stream": JobEvents },
              },
            },
          },
        ),
        (req, res) => {
          // Three events with ids; a resumed stream replays those after the
          // client's Last-Event-ID, and one it cannot resume from (an id it
          // never sent) gets the declared `gap` first, then all of them.
          const job = req.params.id;
          const events = [
            { id: "1", event: "progress", data: { percent: 50 } },
            { id: "2", event: "progress", data: { percent: 100 } },
            { id: "3", event: "done", data: { result: `job ${job} done` } },
          ] as const;
          const last = req.get("last-event-id") ?? undefined;
          const from = events.findIndex(({ id }) => id === last);
          const gap = last !== undefined && from === -1;
          const stream = res.status(200).sse({
            contract: JobEvents,
            retry: 1000,
            // Called only with a Last-Event-ID: what came after it, or a gap.
            resume: () => (gap ? "gap" : events.slice(from + 1)),
          });
          // A fresh stream, or one past a gap, gets every event.
          if (last === undefined || gap) {
            for (const event of events) void stream.send(event);
          }
          stream.close();
        },
      )
      .describe({
        summary: "A job's progress, as server-sent events",
        tags: ["Server-sent events"],
      }),
  }));
}

/** The route the "add a route" button mounts at run time. */
export const extraApi = defineRoutes("/api", (r) => ({
  getUserBadge: r
    .get(
      "/users/:id/badge",
      validate(
        { params: IdParams },
        {
          responses: {
            200: z.object({ id: z.string(), badge: z.string() }),
          },
        },
      ),
      (req, res) => {
        res.status(200).json({ id: req.params.id, badge: "early adopter" });
      },
    )
    .describe({
      summary: "Read a user's badge (added at run time)",
      tags: ["Users"],
    }),
}));

/** A registry: its mount and its router. */
interface Registry {
  /** The registry's mount. */
  readonly mount: "/api";
  /** Its router. */
  readonly router: BunRouter<"/api">;
}

/**
 * A router with `registries` mounted, logging every request under `/api`
 * into `state`, `GET /api/orgs/:id` behind `cache`'s `cacheResponse()`, and
 * a failed request check under `/api` answered as problem+json. All three
 * are scoped to `/api`, so mounted in the playground they see nothing of
 * the page's own routes.
 */
function wrap(
  state: ApiState,
  cache: Cache,
  ...registries: Registry[]
): BunRouter {
  const router = new BunRouter();
  router.use("/api", (req, _res, next) => {
    record(state, req);
    next();
  });
  // Ahead of the route (a registry's verb takes only a validator and the
  // handler); `use` is a prefix match, so it covers every org.
  router.use(
    "/api/orgs",
    cacheResponse(cache, {
      ttl: 60_000,
      tags: ["orgs"],
      surrogateKeys: "Cache-Tag",
    }),
  );
  for (const each of registries) router.use(each.mount, each.router);
  router.use("/api", ((error, _req, res, _next) => {
    const { status, message } = error as { status?: number; message?: string };
    res.status(status ?? 500).json(problem("INVALID", message ?? "Failed"));
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/**
 * Builds the API: fresh state (the seed users and orgs), its own memory
 * cache for `GET /api/orgs/:id`, and the routers.
 */
export function createApi(): Api {
  const state: ApiState = {
    users: new Map(SEED_USERS.map((user) => [user.id, { ...user }])),
    deleted: new Set(),
    orgs: new Map([
      ["7", { id: "7", name: "Analytical Engines", team: "blue" }],
      ["8", { id: "8", name: "Difference Ltd", team: "green" }],
    ]),
    flaky: new Map(),
    nextId: 100,
    hits: [],
    seq: 0,
  };
  const cache = createCache({
    driver: memoryDriver(),
    namespace: "playground-client",
  });
  const routes = registry(state);
  const router = wrap(state, cache, routes);
  // Mounted beside `router`, whose log and error handler already cover
  // `/api`, so it carries neither.
  const extraRouter = new BunRouter();
  extraRouter.use(extraApi.mount, extraApi.router);
  let withExtra: BunRouter | undefined;
  return {
    router,
    extraRouter,
    state,
    cache,
    withExtra: () => (withExtra ??= wrap(state, cache, routes, extraApi)),
  };
}

/** One documenting copy, for `bun-client generate --module` (and the page's `--check`). */
let documenting: BunRouter | undefined;

/** What `bun-client generate --module typed-client-api.ts` reads: the router, built once per process. */
export default function documentedRouter(): BunRouter {
  return (documenting ??= createApi().router);
}
