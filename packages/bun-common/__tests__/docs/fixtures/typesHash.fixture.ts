/**
 * The fixture app for `__tests__/docs/typesHash.test.ts` (typed-client plan
 * PR-M1): HTTP routes on the root, a mounted sub-router, a `defineRoutes`
 * registry and a channel, so both documents have content. Run directly, it
 * prints the documents' hash, which the test compares with the one it
 * computes in its own process.
 */
import process from "node:process";
import { z } from "zod";
import { BunRouter } from "../../../lib/BunRouter";
import { validate } from "../../../lib/BunValidate";
import { BunWebSocket } from "../../../lib/BunWebSocket";
import { defineChannel } from "../../../lib/channel";
import { defineRoutes } from "../../../lib/defineRoutes";
import type {
  AsyncApiDocument,
  OpenApiDocument,
} from "../../../lib/docs/index";
import {
  generateAsyncApi,
  generateOpenApi,
  typesHash,
} from "../../../lib/docs/index";

/** What the fixture can vary, so the test can change one thing at a time. */
export interface FixtureVariant {
  /** The type of `User.name`. Default: `"string"`. */
  readonly nameType?: "string" | "number";
  /** Adds `GET /health`. Default: `false`. */
  readonly extraRoute?: boolean;
  /** The summary of `GET /users/:id`. Default: `"Read one user"`. */
  readonly summary?: string;
  /** The error codes of `GET /users/:id`. Default: `["NOT_FOUND"]`. */
  readonly errors?: readonly string[];
}

/** Builds the fixture app (a fresh one each call). */
export function fixtureApp(variant: FixtureVariant = {}): {
  /** The app's router. */
  router: BunRouter;
  /** The socket its channel registers on; generation never serves it. */
  socket: BunWebSocket;
} {
  const router = new BunRouter();
  const socket = new BunWebSocket({
    newInstance: false,
    getServer: () => undefined,
    router,
  });

  const User = z.object({
    id: z.string(),
    name: variant.nameType === "number" ? z.number() : z.string(),
  });

  const users = new BunRouter();
  users
    .get(
      "/:id",
      validate(
        { params: z.object({ id: z.string() }) },
        { responses: { 200: User, 404: null } },
      ),
      (req, res) => res.status(200).json({ id: req.params.id, name: "a" }),
    )
    .describe({
      summary: variant.summary ?? "Read one user",
      errors: variant.errors ?? ["NOT_FOUND"],
      cache: { tags: ["user:{id}"] },
    });
  router.use("/users", users);

  const posts = defineRoutes("/posts", (r) => ({
    listPosts: r.get(
      "/",
      validate({ query: z.object({ page: z.coerce.number().default(1) }) }),
      (_req, res) => res.json([]),
    ),
  }));
  router.use(posts.mount, posts.router);

  if (variant.extraRoute === true) {
    router.get("/health", (_req, res) => res.json({ ok: true }));
  }

  const chat = defineChannel({
    path: "/rooms/:room",
    receives: { say: z.object({ text: z.string() }) },
    sends: { said: z.object({ text: z.string() }) },
    meta: { name: "chat" },
  });
  router.ws(chat.path, chat.checks(), chat.handler({}), chat.options());
  return { router, socket };
}

/** The fixture app's two documents. */
export function fixtureDocuments(variant: FixtureVariant = {}): {
  /** The OpenAPI document. */
  openapi: OpenApiDocument;
  /** The AsyncAPI document. */
  asyncapi: AsyncApiDocument;
} {
  const { router } = fixtureApp(variant);
  const options = { title: "Fixture", version: "1.0.0" };
  return {
    openapi: generateOpenApi(router, options).document,
    asyncapi: generateAsyncApi(router, options).document,
  };
}

if (import.meta.main) {
  process.stdout.write(`${typesHash(fixtureDocuments())}\n`);
}
