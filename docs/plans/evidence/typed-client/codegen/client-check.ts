/**
 * The generated map drives the same client type the inference path uses, and
 * the generated types equal what the schemas infer (after a JSON round trip).
 */
import type { z } from "zod";
import type { Jsonify } from "./client-types";
import type { Routes } from "./routes.gen";
import { createFlatClient } from "./client-types";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>() => {};

const client = createFlatClient<Routes>("/api");
export async function run() {
  const one = await client.get("/users/:id", { params: { id: "1" } });
  if (one.status === 200) { const role: "admin" | "member" = one.data.role; void role; }
  if (one.status === 404) { const t: string = one.data.title; void t; }
  const list = await client.get("/users", { query: { page: 2 } }); // page optional: it has a default
  if (list.status === 200) { const n: number | null = list.data.next; void n; }
  await client.post("/users", { body: { name: "a", email: "a@b.c" } }); // role optional: it has a default
  // @ts-expect-error email is required
  await client.post("/users", { body: { name: "a" } });
  // @ts-expect-error page is a number
  await client.get("/users", { query: { page: "2" } });
  // @ts-expect-error no such route
  await client.get("/nope", {});
  const m = await client.get("/orgs/:org/members/:id", { params: { org: "o", id: "1" } });
  if (m.status === 200) {
    // the generated type is `unknown` for a z.date(): JSON Schema cannot say "Date"; inference says string
    const since: unknown = m.data.since; void since;
  }
}

// parity: generated == Jsonify<inferred> for the routes whose schemas are representable
declare const User: z.ZodObject<{ id: z.ZodString; name: z.ZodString; email: z.ZodEmail; role: z.ZodEnum<{ admin: "admin"; member: "member" }>; createdAt: z.ZodISODateTime }>;
ok<Equal<Routes["GET /users/:id"]["responses"][200], Jsonify<z.output<typeof User>>>>();
// negative control: the Date field differs (generated unknown, inferred-and-jsonified string)
type Member = { org: string; id: string; since: Date };
// @ts-expect-error the generated `since` is unknown, not string
ok<Equal<Routes["GET /orgs/:org/members/:id"]["responses"][200], Jsonify<Member>>>();
