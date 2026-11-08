/**
 * Throttles in the API document — the `429` and `x-bun-throttle`.
 *
 * ```bash
 * bun 16-throttle/openapi.ts
 * ```
 *
 * `generateOpenApi()` reads the throttles covering each route: a throttled
 * operation gets a documented `429` (problem+json, with the `Retry-After`,
 * `RateLimit-Policy` and `RateLimit` headers) and an `x-bun-throttle` list of
 * its limits. A route that skips the throttle has neither, and a `429` the
 * route declares itself wins over the generated one.
 */
import { BunHttpAdapter, skipThrottle } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Throttles in OpenAPI");

const adapter = new BunHttpAdapter(0, {
  throttle: {
    limits: {
      default: { limit: 600, window: "1m" },
      burst: { limit: 20, window: "1s" },
    },
  },
});
adapter.get("/users", (_req, res) => res.json([]));
adapter.get("/health", skipThrottle(), (_req, res) => res.send("ok"));
adapter
  .get("/custom", (_req, res) => res.send("ok"))
  .describe({
    responses: {
      200: { description: "fine" },
      429: { description: "Slow down, custom." },
    },
  });

/** The part of an operation this example reads. */
interface Operation {
  responses: Record<
    string,
    { description: string; headers?: object; content?: object }
  >;
  "x-bun-throttle"?: unknown;
}
const { document } = generateOpenApi(adapter, {
  title: "Throttled API",
  version: "1",
}) as unknown as { document: { paths: Record<string, { get: Operation }> } };

step("a throttled route");
const users = document.paths["/users"].get;
show("x-bun-throttle", users["x-bun-throttle"]);
check("429 documented", "429" in users.responses);
checkEqual("429 headers", Object.keys(users.responses["429"].headers ?? {}), [
  "Retry-After",
  "RateLimit-Policy",
  "RateLimit",
]);
checkEqual("429 body type", Object.keys(users.responses["429"].content ?? {}), [
  "application/problem+json",
]);
checkEqual("x-bun-throttle", users["x-bun-throttle"], [
  {
    name: "default",
    limit: 600,
    window: 60_000,
    algorithm: "sliding-window",
    scope: "global",
  },
  {
    name: "burst",
    limit: 20,
    window: 1000,
    algorithm: "sliding-window",
    scope: "global",
  },
]);

step("a skipped route");
const health = document.paths["/health"].get;
check("no 429", !("429" in health.responses));
checkEqual("no x-bun-throttle", health["x-bun-throttle"], undefined);

step("a route's own 429 wins");
checkEqual(
  "description",
  document.paths["/custom"].get.responses["429"].description,
  "Slow down, custom.",
);

summary();
