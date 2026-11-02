/**
 * A `defineRoutes` registry mounted twice (`/users` and, through a parent
 * router, `/v2/users`), for the generator's `--module` path: both mounts
 * declare the property names as operation ids, and `generateOpenApi` keeps
 * the first mount's and suffixes the second's with where its mount differs
 * (`getUser`, `getUserV2`). `mounts.gen.ts` is generated from this file:
 *
 * ```bash
 * bun lib/codegen/cli.ts generate --module __tests__/codegen/fixtures/mounts.ts --out __tests__/codegen/fixtures/mounts.gen.ts
 * ```
 */
import { BunRouter, defineRoutes, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

export const User = z.object({ id: z.string(), version: z.string() });

export const users = defineRoutes("/users", (r) => ({
  getUser: r.get(
    "/:id",
    validate(
      { params: z.object({ id: z.string() }) },
      { responses: { 200: User } },
    ),
    (req, res) =>
      res.json({
        id: req.params.id,
        version: req.baseUrl.startsWith("/v2") ? "v2" : "v1",
      }),
  ),
  listUsers: r.get(
    "/",
    validate({}, { responses: { 200: z.array(User) } }),
    (_req, res) => res.json([]),
  ),
}));

/** A fresh router with the registry mounted at `/users` and `/v2/users`. */
export function buildRouter(): BunRouter {
  const router = new BunRouter();
  router.use(users.mount, users.router);
  const v2 = new BunRouter();
  v2.use(users.mount, users.router);
  router.use("/v2", v2);
  return router;
}

export default buildRouter;
