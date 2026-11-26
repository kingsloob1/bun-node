/**
 * Errors (plan §4.3, evidence E4): with `onAPIError: { throw: true }` a
 * failure inside better-auth reaches bun-common's error handlers; without it
 * better-auth answers an empty `500`, which bun-auth logs and warns about.
 * better-auth's own `4xx` answers are never turned into errors.
 */
import type {
  BunRequest,
  BunResponse,
  NextFunction,
  RouterErrorMiddlewareHandler,
} from "@kingsleyweb/bun-common";
import { BunHttpAdapter, createTestLogger } from "@kingsleyweb/bun-common";
import { describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { mountAuth } from "../lib";
import {
  cookieOf,
  jsonPost,
  makePlainAuth,
  ORIGIN,
  PASSWORD,
  warningsIn,
} from "./helpers";

// Every case signs up or in through better-auth, whose scrypt hashing is
// CPU-bound: on a loaded machine one case outlasted bun:test's 5 s (seed
// 797066127 at a load of 161).
setDefaultTimeout(30_000);

/** An adapter with better-auth mounted and an error handler that records what reached it. */
function appWith(onAPIError: { throw?: boolean }) {
  const failing = { on: false };
  const auth = makePlainAuth({ onAPIError }, failing);
  const { logger, events } = createTestLogger();
  const app = new BunHttpAdapter(0, { logger });
  const reached: string[] = [];
  mountAuth(app, auth);
  app.use(((err, _req: BunRequest, res: BunResponse, _next: NextFunction) => {
    reached.push((err as Error).message);
    res.status(503).json({ handled: true });
  }) satisfies RouterErrorMiddlewareHandler);
  return { app, failing, events, reached };
}

const signIn = () =>
  jsonPost({ email: "ann@example.test", password: PASSWORD });

describe("an internal error in better-auth", () => {
  it("with onAPIError.throw, reaches the app's error handlers, and bun-auth does not warn", async () => {
    const { app, failing, events, reached } = appWith({ throw: true });
    failing.on = true;
    const response = await app.fetch(
      `${ORIGIN}/api/auth/sign-in/email`,
      signIn(),
    );
    expect(response.status).toBe(503);
    expect(reached).toEqual(["db connection lost"]);
    expect(warningsIn(events)).not.toContain("error-handling");
    expect(events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("without it, is better-auth's empty 500, logged by bun-auth, with a warning at mount", async () => {
    const { app, failing, events, reached } = appWith({});
    expect(warningsIn(events)).toEqual(["error-handling"]);
    failing.on = true;
    // better-auth prints `# SERVER_ERROR:` itself.
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let response: Response;
    try {
      response = await app.fetch(`${ORIGIN}/api/auth/sign-in/email`, signIn());
    } finally {
      quiet.mockRestore();
    }
    expect(response.status).toBe(500);
    expect(reached).toEqual([]);
    const errors = events.filter((event) => event.level === "error");
    expect(errors.map((event) => event.fields)).toEqual([
      { status: 500, method: "POST", path: "/api/auth/sign-in/email" },
    ]);
    expect(errors[0]?.message).toContain("onAPIError: { throw: true }");
  });

  it("negative control: a 4xx answer is an answer, neither an error nor logged", async () => {
    const { app, events, reached } = appWith({ throw: true });
    const response = await app.fetch(
      `${ORIGIN}/api/auth/sign-in/email`,
      signIn(),
    );
    expect(response.status).toBe(401);
    expect(reached).toEqual([]);
    expect(events.filter((event) => event.level === "error")).toEqual([]);
  });

  it("a session lookup that fails goes to the error handlers too", async () => {
    const { requireSession } = await import("../lib");
    const failing = { on: false };
    const auth = makePlainAuth({}, failing);
    const app = new BunHttpAdapter(0, { logger: () => {} });
    const reached: string[] = [];
    app.get(
      "/me",
      requireSession(auth),
      (_req: BunRequest, res: BunResponse) => {
        res.send("never");
      },
    );
    app.use(((err, _req: BunRequest, res: BunResponse, _next: NextFunction) => {
      reached.push((err as Error).message);
      res.status(503).send("handled");
    }) satisfies RouterErrorMiddlewareHandler);
    mountAuth(app, auth);
    const up = await app.fetch(
      `${ORIGIN}/api/auth/sign-up/email`,
      jsonPost({ email: "bob@example.test", password: PASSWORD, name: "Bob" }),
    );
    failing.on = true;
    const response = await app.fetch(`${ORIGIN}/me`, {
      headers: { cookie: cookieOf(up) },
    });
    expect(response.status).toBe(503);
    expect(reached.length).toBe(1);
  });
});
