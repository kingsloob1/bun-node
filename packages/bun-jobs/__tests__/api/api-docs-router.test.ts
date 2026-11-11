/**
 * The jobs API's documents through bun-common's `docsRouter()` (#771).
 *
 * `JobsApi.openapi()` writes OpenAPI `3.1.0`, and bun-common's own generator
 * `3.1.2`. `docsRouter`'s `openapi` used to take only the generator's type,
 * pinned to `"3.1.2"`, so handing it the jobs API's document was a type
 * error, though it served fine. It now takes any `3.1.x` document
 * (`OpenApi31Document`). This file is type-checked by `bun test --check`, so
 * the call below is the type test, with its controls beside it:
 *
 * - a `3.1.0` document is accepted, as a value and as a function;
 * - a `4.0.0` one is still refused (the widening is `3.1.x`, not `string`);
 * - the generator's own `OpenApiDocument` stays pinned to `"3.1.2"`;
 * - and at run time the jobs API's document is served as it is.
 */
import type {
  OpenApi31Document,
  OpenApiDocument as CommonOpenApiDocument,
} from "@kingsleyweb/bun-common/lib/docs";
import { docsRouter } from "@kingsleyweb/bun-common/lib/docs";
import { afterAll, describe, expect, it } from "bun:test";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { apiConfig, openContexts } from "./fixtures";

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

describe("docsRouter serves the jobs API's documents (#771)", () => {
  it("takes JobsApi.openapi() and asyncapi() with no cast, and serves them as they are", async () => {
    const api = createJobsApi(apiConfig());
    try {
      const asyncapi = api.asyncapi();
      expect(asyncapi).toBeDefined();
      const router = docsRouter({
        openapi: () => api.openapi(),
        ...(asyncapi === undefined ? {} : { asyncapi }),
      });
      const openapi = await router.fetch("/openapi.json");
      expect(openapi.status).toBe(200);
      const served = (await openapi.json()) as { openapi: string };
      expect(served.openapi).toBe("3.1.0");
      expect(served).toEqual(JSON.parse(JSON.stringify(api.openapi())));
      const events = await router.fetch("/asyncapi.json");
      expect(events.status).toBe(200);
      expect(((await events.json()) as { asyncapi: string }).asyncapi).toBe(
        "3.0.0",
      );

      // The document as a value, too.
      const once = docsRouter({ openapi: api.openapi() });
      expect((await once.fetch("/openapi.json")).status).toBe(200);
    } finally {
      await api.close();
    }
  });

  it("widens to 3.1.x only, and leaves the generator's own type pinned (compile-time controls)", () => {
    const jobsDocument: OpenApi31Document = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {},
    };
    // @ts-expect-error a 4.0.0 document is not an OpenAPI 3.1 one
    const four: OpenApi31Document = { openapi: "4.0.0", paths: {} };
    // @ts-expect-error the generator's type is still the version it writes
    const generated: CommonOpenApiDocument = jobsDocument;
    expect([four, generated]).toHaveLength(2);
  });
});
