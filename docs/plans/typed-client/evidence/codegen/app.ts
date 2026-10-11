/** A small app on the REAL, unpatched BunRouter, written as statements. */
import { BunRouter } from "@kingsleyweb/bun-common";
import { z } from "zod";
import { dv } from "./describe";

const User = z.object({ id: z.string(), name: z.string(), email: z.email(), role: z.enum(["admin", "member"]), createdAt: z.iso.datetime() });
const Problem = z.object({ type: z.string(), title: z.string(), status: z.number(), code: z.string().optional() });

export function buildApp(extra?: (router: BunRouter) => void) {
  const app = new BunRouter();
  app.get("/users", dv({ query: z.object({ page: z.coerce.number().int().min(1).default(1), q: z.string().optional() }) }, { 200: z.object({ items: z.array(User), next: z.number().nullable() }) }), (req, res) => {
    res.json({ items: [], next: req.query.page + 1 });
  });
  app.get("/users/:id", dv({ params: z.object({ id: z.string() }) }, { 200: User, 404: Problem }), (req, res) => {
    res.json({ id: req.params.id, name: "a", email: "a@b.c", role: "member", createdAt: new Date().toISOString() });
  });
  app.post("/users", dv({ body: z.object({ name: z.string().min(1), email: z.email(), role: z.enum(["admin", "member"]).default("member") }) }, { 201: User, 409: Problem }), (req, res) => {
    res.status(201).json({ id: "1", ...req.body, createdAt: new Date().toISOString() });
  });
  app.delete("/users/:id", dv({ params: z.object({ id: z.string() }) }, { 204: null, 404: Problem }), (_req, res) => {
    res.status(204).end();
  });
  app.get("/legacy", (_req, res) => res.json({ ok: true })); // no validator

  const members = new BunRouter<"/orgs/:org">();
  members.get("/members/:id", dv({ params: z.object({ org: z.string(), id: z.string() }) }, { 200: z.object({ org: z.string(), id: z.string(), since: z.date() }) }), (req, res) => {
    res.json({ org: req.params.org, id: req.params.id, since: new Date() });
  });
  app.use("/orgs/:org", members);
  extra?.(app);
  return app;
}
