/**
 * AD (a), plan §9.4: one golden document for a fixture router exercising
 * every feature — a mount, a wildcard, a regex param, a validator,
 * `.describe()`, `hidden`, and all four request targets — regenerated with
 * `UPDATE_DOCS_FIXTURE=1`. The warnings list is part of the fixture: the
 * wildcard route is undocumentable and says so.
 */
import { describe, expect, it } from "bun:test";
import process from "node:process";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { validate } from "../../lib/BunValidate";
import type { OpenApiResult } from "../../lib/docs/index";
import { generateOpenApi } from "../../lib/docs/index";

const FIXTURE = new URL("./fixtures/openapi.golden.json", import.meta.url);

/** The fixture router: one of everything §9.4 names. */
function fixtureRouter(): BunRouter {
  const router = new BunRouter();
  router
    .get("/healthz", (_req, res) => res.json({ ok: true }))
    .describe({ hidden: true });
  router
    .get("/files/*rest", (_req, res) => res.json({}))
    .describe({ summary: "A wildcard — undocumentable" });
  router
    .get("/re/:id(\\d+)", (_req, res) => res.json({ id: 1 }))
    .describe({
      summary: "A regex-constrained parameter",
      responses: {
        200: { schema: z.object({ id: z.number() }) },
      },
    });

  const users = new BunRouter();
  users
    .get(
      "/:id",
      validate(
        {
          params: z.object({ id: z.string() }),
          query: z.object({ verbose: z.coerce.boolean().default(false) }),
          headers: z.object({ "x-tenant": z.string() }),
          cookies: z.object({ session: z.string().optional() }),
        },
        { responses: { 200: z.object({ id: z.string() }), 404: null } },
      ),
      (req, res) => res.json({ id: req.params.id }),
    )
    .describe({ summary: "Read one user", tags: ["Users"] });
  users
    .post(
      "/",
      validate(
        { body: z.object({ name: z.string() }) },
        { responses: { 201: z.object({ id: z.string(), name: z.string() }) } },
      ),
      (req, res) => res.status(201).json({ id: "u_1", name: req.body.name }),
    )
    .describe({ summary: "Create a user", tags: ["Users"] });
  router.use("/users", users);
  return router;
}

/** The golden result, generated fresh. */
function generate(): OpenApiResult {
  return generateOpenApi(fixtureRouter(), {
    title: "Golden fixture",
    version: "1.0.0",
    description: "Every feature at once.",
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  });
}

describe("the golden document (UPDATE_DOCS_FIXTURE=1 regenerates)", () => {
  it("matches the recorded fixture", async () => {
    const result = generate();
    if (process.env.UPDATE_DOCS_FIXTURE === "1") {
      await Bun.write(FIXTURE, `${JSON.stringify(result, null, 2)}\n`);
    }
    const recorded = await Bun.file(FIXTURE).json();
    expect(JSON.parse(JSON.stringify(result))).toEqual(recorded);
  });
});
