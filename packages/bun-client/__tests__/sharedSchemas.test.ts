/**
 * The server's own schemas on the client (plan §5.1's second row, Q6): a
 * browser-safe module both sides import, given to the client as its schema
 * source. Its refinement, which generated zod cannot carry (§5.3), refuses a
 * request before it is sent; the server, validating with the same schema,
 * would refuse it too. The module's bundle-safety check is the five lines
 * the README gives an app.
 */
import type { Routes } from "./fixtures/shared/schemas";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createClient, ValidationError } from "../lib/index";
import { sharedServer } from "./fixtures/shared/server";

describe("the server's own schemas, from a shared module", () => {
  it("checks a cross-field rule before sending (control: the server refuses the same body)", async () => {
    const router = sharedServer();
    let sent = 0;
    const api = createClient<Routes>({
      baseUrl: "http://app.test",
      fetch: (request) => {
        sent++;
        return router.fetch(request);
      },
      mode: "development",
      retry: false,
      schemas: () => import("./fixtures/shared/schemas"),
    });
    const mismatch = { name: "Ada", password: "12345678", confirm: "87654321" };
    const error = await api
      .post("/users", { body: mismatch })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).issues).toEqual([
      {
        target: "body",
        path: "confirm",
        message: "The passwords differ",
        source: "builtin",
      },
    ]);
    expect(sent).toBe(0);

    // Control: sent anyway, the server refuses it with the same schema.
    const unchecked = await router.fetch(
      new Request("http://app.test/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mismatch),
      }),
    );
    expect(unchecked.status).toBe(400);

    const created = await api.post("/users", {
      body: { name: "Ada", password: "12345678", confirm: "12345678" },
    });
    expect(created.status).toBe(201);
    expect(sent).toBe(1);
  });

  it("the module is browser-safe: the README's five-line check passes (control: the server module fails it)", async () => {
    const isBrowserSafe = async (entry: string) => {
      const result = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        throw: false,
      });
      const code = result.success
        ? (await Promise.all(result.outputs.map((o) => o.text()))).join("")
        : "";
      return (
        result.success && !/["'](?:node|bun):|\bBun\.\w+|BunRouter/.test(code)
      );
    };
    const shared = join(import.meta.dir, "fixtures", "shared");
    expect(await isBrowserSafe(join(shared, "schemas.ts"))).toBe(true);
    expect(await isBrowserSafe(join(shared, "server.ts"))).toBe(false);
  });
});
