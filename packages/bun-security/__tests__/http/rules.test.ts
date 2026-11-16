/**
 * L7 request rules through `installSecurity` (PR-S8): a probe refused in
 * the early stage before its body is read, and a rule on the caller in the
 * route stage.
 */
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { installSecurity } from "../../lib/http/index";

/** An adapter with the engine installed, reading the caller from `x-user`. */
async function secured(policy: SecurityPolicy) {
  const app = new BunHttpAdapter(0, { logger: () => {} });
  await installSecurity(
    app,
    createSecurity<BunRequest>({
      policy,
      logger: () => {},
      identify: (req) => {
        const user = req.request.headers.get("x-user");
        return user === null ? undefined : { user };
      },
    }),
    { logger: () => {} },
  );
  return app;
}

describe("installSecurity: L7 request rules", () => {
  it("refuses a managed probe before its body is read, answering 404", async () => {
    const app = await secured({
      requestRules: { managed: { mode: "enforce" } },
    });
    let reached = false;
    app.post("/.env", (_req, res) => {
      reached = true;
      res.send("never");
    });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("x"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const refused = await app.fetch("/.env", {
      method: "POST",
      body,
      remoteAddress: "198.51.100.50",
    });
    expect([
      refused.status,
      ((await refused.json()) as { code: string }).code,
    ]).toEqual([404, "not_found"]);
    expect([pulls, reached]).toEqual([0, false]);
  });

  it("runs a rule on the caller in the route stage", async () => {
    const app = await secured({
      requestRules: {
        rules: [
          {
            id: "staff-only",
            when: {
              all: [
                { path: { prefix: "/admin" } },
                { not: { user: { prefix: "staff_" } } },
              ],
            },
          },
        ],
      },
    });
    app.get("/admin/report", (_req, res) => res.send("report"));
    expect(
      (await app.fetch("/admin/report", { headers: { "x-user": "staff_ada" } }))
        .status,
    ).toBe(200);
    expect(
      (await app.fetch("/admin/report", { headers: { "x-user": "mallory" } }))
        .status,
    ).toBe(403);
  });
});
