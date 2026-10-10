/** The Nest-generated map drives the same client type. */
import type { Routes } from "./nest-routes.gen";
import { createFlatClient } from "../codegen/client-types";

const client = createFlatClient<Routes>("/");
export async function run() {
  const u = await client.get("/api/users/:id", { params: { id: "1" } });
  if (u.status === 200) { const e: string = u.data.email; void e; }
  await client.post("/api/users", { body: { name: "a", email: "a@b.c" } });
  const h = await client.get("/api/health", {});
  if (h.status === 200) { const ok: boolean = h.data.ok; void ok; }
  // @ts-expect-error the body needs an email
  await client.post("/api/users", { body: { name: "a" } });
}

// negative control for @TypedRoute's return-type constraint lives in explore-types.ts
