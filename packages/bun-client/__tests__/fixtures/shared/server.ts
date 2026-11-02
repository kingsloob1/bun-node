/**
 * The server half of the shared-schemas fixture: a bun-common router that
 * validates with the shared module's schemas, as a monorepo's server would.
 */
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { NewUser, User } from "./schemas";

/** A router serving `POST /users` with the shared schemas. */
export function sharedServer(): BunRouter {
  const router = new BunRouter();
  router.post(
    "/users",
    validate({ body: NewUser }, { responses: { 201: User } }),
    (req, res) => res.status(201).json({ id: "1", name: req.body.name }),
  );
  router.use(((error, _req, res, _next) => {
    res.status((error as { status?: number }).status ?? 500).json({
      message: String(error),
    });
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}
