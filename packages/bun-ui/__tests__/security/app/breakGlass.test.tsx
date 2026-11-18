/**
 * The break-glass sign-in (the user's decision 6): offered from "Sign in
 * required" only when the API has the account; a login keeps the token in
 * `sessionStorage` and every call then carries it; expiry or a `401` clears
 * it; a lockout is shown.
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import {
  BREAK_GLASS_STORAGE_KEY,
  breakGlassStore,
} from "../../../app/security/session/breakGlass";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The header the token travels in. */
const HEADER = "x-bun-security-break-glass";

/** The default routes, every one answering 401 unless the call carries the token `token`. */
function signedOutUnless(token: string) {
  const routes = defaultRoutes();
  return Object.fromEntries(
    Object.entries(routes).map(([key, reply]) => [
      key,
      (call: MockCall) =>
        call.headers.get(HEADER) === token
          ? typeof reply === "function"
            ? reply(call)
            : reply
          : problem(401, "unauthenticated"),
    ]),
  );
}

/** Fills and submits the form. */
function signIn(password: string, code: string): void {
  fireEvent.change(page().getByLabelText(/Password/), {
    target: { value: password },
  });
  fireEvent.change(page().getByLabelText(/Authenticator code/), {
    target: { value: code },
  });
  fireEvent.click(
    page().getByRole("button", { name: "Sign in with break-glass" }),
  );
}

describe("the link", () => {
  it("is absent when the API has no break-glass account", async () => {
    renderApp({ routes: signedOutUnless("never") });
    expect(
      (await page().findByTestId("bootstrap-error", {}, LOADED)).textContent,
    ).toContain("Sign in required");
    expectAbsent(
      page().queryByTestId("break-glass-link"),
      "the break-glass link",
    );
  });

  it("is absent on a 403 even when the account exists", async () => {
    renderApp({
      config: { breakGlass: true },
      routes: { "GET /meta": problem(403, "forbidden") },
    });
    expect(
      (await page().findByTestId("bootstrap-error", {}, LOADED)).textContent,
    ).toContain("Access denied");
    expectAbsent(
      page().queryByTestId("break-glass-link"),
      "the break-glass link",
    );
  });
});

describe("a login", () => {
  it("keeps the token in sessionStorage, and every call then carries it", async () => {
    const expiresAt = Date.now() + 15 * 60_000;
    const { api } = renderApp({
      config: { breakGlass: true },
      routes: {
        ...signedOutUnless("bg-token"),
        "POST /break-glass/session": {
          body: { token: "bg-token", expiresAt, header: HEADER },
        },
      },
    });
    fireEvent.click(await page().findByTestId("break-glass-link", {}, LOADED));
    signIn("pw", "123456");
    await page().findByTestId("analytics", {}, LOADED);

    const login = api.calls.find(
      (call) => call.path === "/break-glass/session",
    )!;
    expect(login.method).toBe("POST");
    expect(login.body).toEqual({ password: "pw", code: "123456" });
    expect(login.headers.get("x-bun-security-csrf")).toBe("1");

    const stored = JSON.parse(
      window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY) ?? "null",
    ) as { token: string } | null;
    expect(stored?.token).toBe("bg-token");
    const after = api.calls.slice(api.calls.indexOf(login) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) expect(call.headers.get(HEADER)).toBe("bg-token");
    expect(
      (await page().findByTestId("break-glass-session", {}, LOADED))
        .textContent,
    ).toContain(
      `Break-glass session until ${new Date(expiresAt).toLocaleTimeString()}`,
    );
  });

  it("a wrong password or code says so, and keeps nothing", async () => {
    renderApp({
      config: { breakGlass: true },
      routes: {
        ...signedOutUnless("never"),
        "POST /break-glass/session": problem(401, "unauthenticated"),
      },
    });
    fireEvent.click(await page().findByTestId("break-glass-link", {}, LOADED));
    signIn("bad", "000000");
    expect(
      (await page().findByTestId("break-glass-error", {}, LOADED)).textContent,
    ).toContain("wrong");
    expectAbsent(window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY));
  });

  it("a 429 lockout is shown", async () => {
    renderApp({
      config: { breakGlass: true },
      routes: {
        ...signedOutUnless("never"),
        "POST /break-glass/session": problem(429, "break_glass_locked"),
      },
    });
    fireEvent.click(await page().findByTestId("break-glass-link", {}, LOADED));
    signIn("pw", "123456");
    expect(
      (await page().findByTestId("break-glass-error", {}, LOADED)).textContent,
    ).toContain("locked");
    expectAbsent(window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY));
  });
});

describe("the session ends", () => {
  it("on expiry: the token is cleared and calls stop carrying it", async () => {
    const expiresAt = Date.now() + 400;
    window.sessionStorage.setItem(
      BREAK_GLASS_STORAGE_KEY,
      JSON.stringify({ token: "bg-token", expiresAt, header: HEADER }),
    );
    const { api } = renderApp({
      config: { breakGlass: true },
      routes: signedOutUnless("bg-token"),
    });
    await page().findByTestId("break-glass-session", {}, LOADED);
    await page().findByTestId("bootstrap-error", {}, LOADED);
    expectAbsent(window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY));
    const last = api.calls.at(-1)!;
    expectAbsent(last.headers.get(HEADER));
  });

  it("on a 401: the token is cleared", async () => {
    window.sessionStorage.setItem(
      BREAK_GLASS_STORAGE_KEY,
      JSON.stringify({
        token: "revoked",
        expiresAt: Date.now() + 60_000,
        header: HEADER,
      }),
    );
    renderApp({
      config: { breakGlass: true },
      routes: signedOutUnless("other"),
    });
    await page().findByTestId("bootstrap-error", {}, LOADED);
    await waitFor(() =>
      expectAbsent(
        window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY),
        "the stored session",
      ),
    );
    expectAbsent(
      page().queryByTestId("break-glass-session"),
      "the session badge",
    );
  });
});

describe("the store", () => {
  it("answers null for an expired or malformed session, and clears it", () => {
    let now = 1_000;
    const store = breakGlassStore(window.sessionStorage, () => now);
    store.save({ token: "t", expiresAt: 2_000, header: HEADER });
    expect(store.current()?.token).toBe("t");
    now = 2_000;
    expectAbsent(store.current());
    expectAbsent(window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY));
    window.sessionStorage.setItem(BREAK_GLASS_STORAGE_KEY, "{not json");
    expectAbsent(store.current());
    expectAbsent(window.sessionStorage.getItem(BREAK_GLASS_STORAGE_KEY));
  });

  it("keeps the session for the page when storage refuses it", () => {
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    let now = 0;
    const store = breakGlassStore(refusing, () => now);
    store.save({ token: "t", expiresAt: 10, header: HEADER });
    expect(store.current()?.token).toBe("t");
    now = 10;
    expectAbsent(store.current());
    store.save({ token: "u", expiresAt: 20, header: HEADER });
    store.clear();
    expectAbsent(store.current());
  });
});
