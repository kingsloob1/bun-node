/**
 * Two frontends' documents from one app (issue #768): a customer surface and
 * a back office, each a filtered `generateOpenApi` document exported by name,
 * the shape a targets file's `module` source reads (`bun-client generate
 * --config`, a target's `document` naming its export). `/health` is in both.
 */
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { z } from "zod";

const Ok = z.object({ ok: z.boolean() });

/** The app: one customer route, one back-office route, and a health check. */
export function buildRouter(): BunRouter {
  const router = new BunRouter();
  for (const path of ["/api/orders", "/api/admin/users", "/health"]) {
    router.get(path, validate({}, { responses: { 200: Ok } }), (_req, res) => {
      res.json({ ok: true });
    });
  }
  return router;
}

const info = { title: "API", version: "1" } as const;

/** The customer client's document: everything but the back office. */
export const customer = generateOpenApi(buildRouter(), {
  ...info,
  filter: (route) => !route.path.startsWith("/api/admin"),
}).document;

/** The back office's document: its routes and the health check. */
export const backoffice = generateOpenApi(buildRouter(), {
  ...info,
  filter: (route) =>
    route.path.startsWith("/api/admin") || route.path === "/health",
}).document;

export default buildRouter;
