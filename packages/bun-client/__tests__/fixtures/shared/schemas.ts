/**
 * A browser-safe module of the server's own schemas (plan §5.1's second
 * row): it imports zod and nothing of a server, so both sides import it. The
 * server (`./server.ts`) validates with these schemas; the client loads this
 * module as its built-in schemas (`schemas: () => import("./schemas")`), so
 * nothing is lost to JSON Schema: the refinement below, which a generated
 * schema cannot carry (§5.3), runs on the client too.
 */
import type { SchemaSource } from "../../../lib/index";
import { z } from "zod";

/** A new user: a password and its confirmation must match (a cross-field refinement). */
export const NewUser = z
  .object({
    name: z.string().min(1),
    password: z.string().min(8),
    confirm: z.string(),
  })
  .refine((user) => user.password === user.confirm, {
    message: "The passwords differ",
    path: ["confirm"],
  });

/** A user, as the server answers it. */
export const User = z.object({ id: z.string(), name: z.string() });

/** The route map, written by hand beside the schemas (or generated). */
export interface Routes {
  "POST /users": {
    body: z.input<typeof NewUser>;
    responses: { 201: z.input<typeof User> };
  };
}

/** The client's built-in schemas: the server's own. */
export const schemas: SchemaSource<Routes>["schemas"] = {
  "POST /users": { body: NewUser, responses: { 201: User } },
};
