/** The synthetic N-route app: the inference spike's schema shapes, through dv(). */
import { BunRouter } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { dv } from "../describe";

export function synthetic(n: number) {
  const app = new BunRouter();
  const verbs = ["get", "post", "put", "delete", "get"] as const;
  for (let k = 0; k < n; k++) {
    const verb = verbs[k % 5]!;
    const path = verb === "post" ? `/r${k}/items` : `/r${k}/items/:id${k}`;
    const schemas: Record<string, z.ZodType> = { query: z.object({ page: z.coerce.number().int().optional(), [`q${k}`]: z.string().optional() }) };
    if (verb !== "post") schemas.params = z.object({ [`id${k}`]: z.string() });
    if (verb === "post" || verb === "put") schemas.body = z.object({ name: z.string().min(1), tags: z.array(z.string()), [`n${k}`]: z.number(), meta: z.object({ a: z.boolean() }).optional() });
    const responses = { 200: z.object({ id: z.string(), name: z.string(), [`n${k}`]: z.number(), createdAt: z.iso.datetime(), role: z.enum(["admin", "member"]), email: z.email().nullable() }), 404: z.object({ type: z.string(), title: z.string(), status: z.literal(404) }) };
    (app[verb] as (p: string, ...h: unknown[]) => unknown)(path, dv(schemas as never, responses), (_q: unknown, s: { end: () => void }) => s.end());
  }
  return app;
}

