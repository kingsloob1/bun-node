/**
 * The posts API's contract, shared by the server (`../contract-sharing.ts`)
 * and the client (`./posts-client.ts`).
 *
 * It imports only the browser-safe entry, `@kingsleyweb/bun-common/contract`,
 * and zod, so a browser bundle can carry it: no Bun or Node API, no router.
 * The server builds its `validate()` middleware from these very schemas, so
 * the two ends check one declaration, not two copies of it.
 *
 * Not an example on its own: `run-all.ts` skips files under `modules/`.
 */
import { defineTransport, documented } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

/**
 * The API's transport: what a request carries (its query and body), and a
 * response keyed by its status. `validate()` uses bun-common's own HTTP
 * transport; this is the same shape, declared where a client can import it.
 */
export const postsApi = defineTransport({
  name: "posts-api",
  inbound: { parts: ["query", "body"], encodings: { query: "querystring" } },
  outbound: { key: "status", parts: ["body"] },
});

/** A new post: a title of at least three characters, and up to five tags. */
export const NewPost = z.object({
  title: z.string().min(3),
  tags: z.array(z.string()).max(5).default([]),
});

/** A stored post. `createdAt` is sent as a `Date`, crosses as a string and is parsed back into a `Date`. */
export const Post = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  tags: z.array(z.string()),
  createdAt: z.coerce.date(),
});

/** The body `validate(..., { onFailure: "respond" })` answers a bad request with. */
export const Problem = z.object({
  error: z.string(),
  issues: z.array(
    z.object({ target: z.string(), message: z.string(), path: z.string() }),
  ),
});

/** `POST /posts`: the request's body, and every response the client may get. */
export const createPost = postsApi.contract(
  {
    inbound: { body: NewPost },
    outbound: {
      201: { body: Post },
      400: { body: Problem },
      // Known only as JSON Schema: it documents the 500 and never checks it.
      500: {
        body: documented<{ error: string }>({
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        }),
      },
    },
  },
  { name: "createPost", description: "Creates a post." },
);
