/**
 * The API the `14-typed-client` examples share: a `defineRoutes` registry
 * with BunValidate schemas and `.describe({ errors, cache })`, over a small
 * in-memory user store that also counts what reached it.
 *
 * It is a helper, not an example: `run-all.ts` skips this folder. Its default
 * export is what `bun-client generate --module` reads, so the committed
 * `api.gen.ts` beside it is made from this very file (see
 * `generate-client.ts`).
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { BunRouter, defineRoutes, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

/** A user, as the API answers it. `createdAt` is an ISO string: the wire type. */
export const User = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.email(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "User" });

/** The error body every declared error status carries; `code` is narrowed per route by `.describe({ errors })`. */
export const Problem = z
  .object({ title: z.string(), code: z.string() })
  .meta({ id: "Problem" });

/** A user as stored. */
export type StoredUser = z.output<typeof User>;

/** What reached the API, for examples to assert on ("nothing was sent"). */
export interface ApiState {
  /** The users, by id. */
  users: Map<string, StoredUser>;
  /** Every request that reached a handler, as `"VERB /path"`, newest last. */
  hits: string[];
  /** The `If-None-Match` each `GET /users/:id` carried (`null`: none). */
  conditions: (string | null)[];
}

/** The path's `:id`. */
const IdParams = z.object({ id: z.string() });

/** A problem body. */
const problem = (code: string, title: string) => ({ title, code });

/** The registry over `state`. */
function registry(state: ApiState) {
  /** Counts a request. */
  const hit = (req: BunRequest): void => {
    state.hits.push(`${req.method} ${req.path}`);
  };

  return defineRoutes("/users", (r) => ({
    getUser: r
      .get(
        "/:id",
        validate(
          { params: IdParams },
          { responses: { 200: User, 404: Problem } },
        ),
        (req, res) => {
          hit(req);
          state.conditions.push(req.get("if-none-match") ?? null);
          const user = state.users.get(req.params.id);
          if (user === undefined) {
            res.status(404).json(problem("NOT_FOUND", "No such user"));
            return;
          }
          // An ETag, so a query refetch of an unchanged user is a 304.
          res.setEtag(true);
          res.status(200).json(user);
        },
      )
      .describe({
        summary: "Read one user",
        errors: ["NOT_FOUND"],
        cache: { tags: ["user:{id}", "users"] },
      }),
    listUsers: r
      .get(
        "/",
        validate(
          { query: z.object({ q: z.string().optional() }) },
          { responses: { 200: z.array(User) } },
        ),
        (req, res) => {
          hit(req);
          const q = req.query.q?.toLowerCase() ?? "";
          res
            .status(200)
            .json(
              [...state.users.values()].filter((user) =>
                user.name.toLowerCase().includes(q),
              ),
            );
        },
      )
      .describe({ summary: "List the users", cache: { tags: ["users"] } }),
    createUser: r
      .post(
        "/",
        validate(
          { body: z.object({ name: z.string().min(1), email: z.email() }) },
          { responses: { 201: User, 409: Problem } },
        ),
        (req, res) => {
          hit(req);
          const { name, email } = req.body;
          if ([...state.users.values()].some((user) => user.email === email)) {
            res.status(409).json(problem("CONFLICT", "That email is taken"));
            return;
          }
          const user: StoredUser = {
            id: String(state.users.size + 1),
            name,
            email,
            createdAt: new Date().toISOString(),
          };
          state.users.set(user.id, user);
          res.status(201).json(user);
        },
      )
      .describe({
        summary: "Create a user",
        errors: ["CONFLICT"],
        cache: { invalidates: ["users"] },
      }),
    renameUser: r
      .patch(
        "/:id",
        validate(
          { params: IdParams, body: z.object({ name: z.string().min(1) }) },
          { responses: { 200: User, 404: Problem } },
        ),
        (req, res) => {
          hit(req);
          const user = state.users.get(req.params.id);
          if (user === undefined) {
            res.status(404).json(problem("NOT_FOUND", "No such user"));
            return;
          }
          user.name = req.body.name;
          res.setEtag(true);
          res.status(200).json(user);
        },
      )
      .describe({
        summary: "Rename a user",
        errors: ["NOT_FOUND"],
        cache: { invalidates: ["user:{id}", "users"] },
      }),
  }));
}

/** What {@link createApi} builds. */
export interface Api {
  /** The registry: `RoutesOf<Api["users"]>` is the client's route map. */
  users: ReturnType<typeof registry>;
  /** The registry mounted on a router. */
  router: BunRouter;
  /** The store and the request log. */
  state: ApiState;
}

/** Builds the API with Ada and Grace stored. */
export function createApi(): Api {
  const state: ApiState = {
    users: new Map([
      [
        "1",
        {
          id: "1",
          name: "Ada",
          email: "ada@example.com",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        "2",
        {
          id: "2",
          name: "Grace",
          email: "grace@example.com",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    ]),
    hits: [],
    conditions: [],
  };
  const users = registry(state);
  const router = new BunRouter();
  router.use(users.mount, users.router);
  return { users, router, state };
}

/** What `bun-client generate --module helpers/api.ts` reads: a function returning the router. */
export default function documentedRouter(): BunRouter {
  return createApi().router;
}
