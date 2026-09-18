/**
 * Shell auth: `authorize` and `middleware`. They guard the page and the
 * bundle, and answer denials in the API's problem shape.
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import type { JobsUiAuthorizeContext } from "../../lib/types";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { fetchShell, fixtureUi } from "./helpers";

/** The problem body of a response, asserting its headers on the way. */
async function problemOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as Record<string, unknown>;
}

describe("authorize", () => {
  it("allows with true or { allow: true }, sync or async", async () => {
    for (const authorize of [
      () => true,
      () => ({ allow: true as const }),
      async () => true,
      async () => {
        await Bun.sleep(1);
        return { allow: true as const };
      },
    ]) {
      const response = await fixtureUi({ authorize }).router.fetch("/");
      expect(response.status).toBe(200);
      await response.text();
    }
  });

  it("denies false with 403 FORBIDDEN, as a problem", async () => {
    const response = await fixtureUi({ authorize: () => false }).router.fetch(
      "/queues",
    );
    expect(response.status).toBe(403);
    expect(await problemOf(response)).toEqual({
      type: "urn:bun-jobs:error:FORBIDDEN",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
      detail: "Not allowed to open this page",
      instance: "/queues",
    });
  });

  it("denies with 401 UNAUTHORIZED and the given reason", async () => {
    const ui = fixtureUi({
      authorize: async () => ({
        allow: false,
        status: 401,
        reason: "Sign in first",
      }),
    });
    const response = await ui.router.fetch("/");
    expect(response.status).toBe(401);
    expect(await problemOf(response)).toMatchObject({
      type: "urn:bun-jobs:error:UNAUTHORIZED",
      title: "Authentication required",
      status: 401,
      code: "UNAUTHORIZED",
      detail: "Sign in first",
    });
  });

  it("fails closed: an unrecognised answer is 403", async () => {
    for (const answer of [undefined, null, 1, "yes", {}, { allow: "true" }]) {
      const ui = fixtureUi({
        authorize: () => answer as unknown as boolean,
      });
      const response = await ui.router.fetch("/");
      expect(response.status).toBe(403);
      expect(await problemOf(response)).toMatchObject({ code: "FORBIDDEN" });
    }
    // A status other than 401 is 403.
    const other = fixtureUi({
      authorize: () => ({ allow: false, status: 500 as 403 }),
    });
    expect((await other.router.fetch("/")).status).toBe(403);
  });

  it("answers a throw (or rejection) with a 500 problem and logs it", async () => {
    for (const authorize of [
      () => {
        throw new Error("session store down");
      },
      async () => {
        throw new Error("session store down");
      },
    ]) {
      const { logger, events } = createTestLogger();
      const ui = fixtureUi({ authorize, logger });
      const response = await ui.router.fetch("/");
      expect(response.status).toBe(500);
      const body = await problemOf(response);
      expect(body).toMatchObject({ code: "INTERNAL", status: 500 });
      // Never the error's own message.
      expect(JSON.stringify(body)).not.toContain("session store down");
      const logged = events.find((event) => event.level === "error");
      expect(logged?.error?.message).toBe("session store down");
    }
  });

  it("is told whether the request is for an asset, and its path", async () => {
    const seen: JobsUiAuthorizeContext[] = [];
    const ui = fixtureUi({
      authorize: (_req, context) => {
        seen.push(context);
        return true;
      },
    });
    const { shell } = await fetchShell(ui.router, "/queues/mail");
    await ui.router.fetch(shell.script.src.replace("/jobs", ""));
    expect(seen).toEqual([
      { asset: false, path: "/queues/mail" },
      { asset: true, path: shell.script.src.replace("/jobs", "") },
    ]);
  });

  it("can let assets through while guarding the page", async () => {
    const ui = fixtureUi({ authorize: (_req, { asset }) => asset });
    expect((await ui.router.fetch("/")).status).toBe(403);
    const open = fixtureUi();
    const { shell } = await fetchShell(open.router, "/");
    const asset = await ui.router.fetch(shell.script.src.replace("/jobs", ""));
    expect(asset.status).toBe(200);
  });

  it("guards HEAD too, with no body", async () => {
    const response = await fixtureUi({ authorize: () => false }).router.fetch(
      "/",
      { method: "HEAD" },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.text()).toBe("");
  });

  it("sees what the host's request carries (cookies, headers)", async () => {
    const ui = fixtureUi({
      authorize: (req) => req.cookies.session === "ok",
    });
    expect((await ui.router.fetch("/")).status).toBe(403);
    const allowed = await ui.router.fetch("/", {
      headers: { cookie: "session=ok" },
    });
    expect(allowed.status).toBe(200);
  });
});

describe("middleware", () => {
  it("runs in order, before authorize, and can feed it", async () => {
    const order: string[] = [];
    const first: RouterHandler = (req, _res, next) => {
      order.push("first");
      (req as unknown as { user?: string }).user = "ada";
      return next();
    };
    const second: RouterHandler = async (_req, _res, next) => {
      order.push("second");
      return next();
    };
    const ui = fixtureUi({
      middleware: [first, second],
      authorize: (req) => {
        order.push("authorize");
        return (req as unknown as { user?: string }).user === "ada";
      },
    });
    const response = await ui.router.fetch("/");
    expect(response.status).toBe(200);
    expect(order).toEqual(["first", "second", "authorize"]);
  });

  it("runs for assets too, and may answer the request itself", async () => {
    const hits: string[] = [];
    const ui = fixtureUi({
      middleware: [
        (req, res, next) => {
          hits.push(req.path);
          if (req.path.endsWith("/blocked")) {
            res.status(429).send("slow down");
            return;
          }
          return next();
        },
      ],
    });
    const { shell } = await fetchShell(ui.router, "/");
    await ui.router.fetch(shell.script.src.replace("/jobs", ""));
    const blocked = await ui.router.fetch("/blocked");
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toBe("slow down");
    expect(hits).toEqual([
      "/",
      shell.script.src.replace("/jobs", ""),
      "/blocked",
    ]);
  });

  it("does not run for methods the UI does not answer", async () => {
    let ran = 0;
    const ui = fixtureUi({
      middleware: [
        (_req, _res, next) => {
          ran++;
          return next();
        },
      ],
    });
    expect((await ui.router.fetch("/", { method: "POST" })).status).toBe(404);
    expect(ran).toBe(0);
  });
});
