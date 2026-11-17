/**
 * Step-up (the user's decision 5): a `401 step_up_required` opens the
 * `stepUpUrl` popup; the host's `{ type: "bun-security:step-up", ok: true }`
 * from the popup's origin retries the action once; a popup closed without
 * it retries nothing. Over the real client and a fake API and window.
 */
import type { StepUpWindow } from "../../../app/security/stepUp";
import { describe, expect, it } from "bun:test";
import { createSecurityClient, dataOf } from "../../../app/security/api/client";
import { ApiError } from "../../../app/security/api/errors";
import { breakGlassStore } from "../../../app/security/session/breakGlass";
import { STEP_UP_MESSAGE_TYPE, withStepUp } from "../../../app/security/stepUp";
import { mockApi, problem } from "./mockApi";
import { securityConfig } from "./config";

/** The ban the fake action places. */
const BAN = { scope: "global", ip: "203.0.113.9", reason: "abuse" };

/** A fake window: records `open`, delivers messages, closes the popup on demand. */
function fakeWindow(options: { blocked?: boolean } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const popup = { closed: false };
  const opened: string[] = [];
  const win: StepUpWindow = {
    location: { href: "https://admin.example.com/security/" },
    open: (url) => {
      opened.push(url);
      return options.blocked === true ? null : popup;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const post = (origin: string, data: unknown) => {
    for (const listener of [...listeners])
      listener({ origin, data } as MessageEvent);
  };
  return { win, popup, opened, post, listeners };
}

/** An API whose `POST /bans` wants a step-up first, then succeeds. */
function stepUpApi() {
  let stepped = false;
  const api = mockApi("/security/api", {
    "POST /bans": () =>
      stepped
        ? { status: 201, body: { id: "b1" } }
        : problem(401, "step_up_required", {
            stepUpUrl: "/auth/step-up?for=ban",
          }),
  });
  const client = createSecurityClient(securityConfig(), breakGlassStore(null), {
    fetch: api.fetch,
  });
  const action = () => dataOf(client.client.post("/bans", { body: BAN }));
  return { api, action, markStepped: () => (stepped = true) };
}

/** The `POST /bans` calls made. */
function bans(api: ReturnType<typeof stepUpApi>["api"]) {
  return api.calls.filter(
    (call) => call.method === "POST" && call.path === "/bans",
  );
}

describe("withStepUp", () => {
  it("opens stepUpUrl, and on the host's ok from its origin retries the action once", async () => {
    const { api, action, markStepped } = stepUpApi();
    const fake = fakeWindow();
    const result = withStepUp(action, fake.win);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.opened).toEqual([
      "https://admin.example.com/auth/step-up?for=ban",
    ]);
    // A message from another origin, and one of another type, are ignored.
    fake.post("https://evil.example.net", {
      type: STEP_UP_MESSAGE_TYPE,
      ok: true,
    });
    fake.post("https://admin.example.com", {
      type: "something-else",
      ok: true,
    });
    markStepped();
    fake.post("https://admin.example.com", {
      type: STEP_UP_MESSAGE_TYPE,
      ok: true,
    });
    expect((await result).id).toBe("b1");
    expect(bans(api).length).toBe(2);
    expect(fake.listeners.size).toBe(0);
  });

  it("a popup closed without the message retries nothing: the step-up error stands", async () => {
    const { api, action } = stepUpApi();
    const fake = fakeWindow();
    const result = withStepUp(action, fake.win);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.popup.closed = true;
    const error = await result.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("step_up_required");
    expect(bans(api).length).toBe(1);
    expect(fake.listeners.size).toBe(0);
  });

  it("ok: false retries nothing", async () => {
    const { api, action } = stepUpApi();
    const fake = fakeWindow();
    const result = withStepUp(action, fake.win);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.post("https://admin.example.com", {
      type: STEP_UP_MESSAGE_TYPE,
      ok: false,
    });
    expect(
      ((await result.catch((failure: unknown) => failure)) as ApiError).code,
    ).toBe("step_up_required");
    expect(bans(api).length).toBe(1);
  });

  it("a blocked popup retries nothing", async () => {
    const { api, action } = stepUpApi();
    const fake = fakeWindow({ blocked: true });
    expect(
      (
        (await withStepUp(action, fake.win).catch(
          (failure: unknown) => failure,
        )) as ApiError
      ).code,
    ).toBe("step_up_required");
    expect(bans(api).length).toBe(1);
  });

  it("any other failure passes through without a popup", async () => {
    const api = mockApi("/security/api", {
      "POST /bans": problem(403, "forbidden"),
    });
    const client = createSecurityClient(
      securityConfig(),
      breakGlassStore(null),
      { fetch: api.fetch },
    );
    const fake = fakeWindow();
    const error = await withStepUp(
      () => dataOf(client.client.post("/bans", { body: BAN })),
      fake.win,
    ).catch((failure: unknown) => failure);
    expect((error as ApiError).status).toBe(403);
    expect(fake.opened).toEqual([]);
  });
});
