/**
 * `unauthorized` in the whole app: an authorization failure from the API or
 * the live socket sends the browser to the configured page, once, with the
 * page it was on; with the option off, or for a status it does not list,
 * nothing navigates and the screens show their messages as before.
 *
 * `location.assign` is stubbed: happy-dom would otherwise try to load the
 * target.
 */
import type { Mock } from "bun:test";
import type { MockReply } from "./mockFetch";
import type { UiUnauthorized } from "../../lib/shared/unauthorized.ts";
import { JOBS_API_WS_CLOSE } from "@kingsleyweb/bun-jobs/api/contract";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ApiError } from "../../app/api/errors";
import { parseUiConfig, UiConfigError } from "../../app/config";
import {
  UnauthorizedRedirectContext,
  createUnauthorizedRedirect,
} from "@kingsleyweb/bun-api-docs-ui/embed/unauthorized";
import { RouterProvider, Routes } from "../../app/router";
import { expectAbsent } from "./assert";
import { act, LOADED, page, render, setupDom, visit, waitFor } from "./dom";
import { metaFixture, problem, uiConfig } from "./fixtures";
import { FakeSocket, hello, settle } from "./live/fakes";
import { defaultHandlers, renderApp } from "./renderApp";

setupDom();

/** `unauthorized` as `jobsUi({ unauthorized: { redirectTo: "/login" } })` resolves it. */
const TO_LOGIN: UiUnauthorized = {
  redirectTo: "/login",
  returnParam: "returnTo",
  statuses: [401],
};

/** A 401 problem reply. */
const UNAUTHORIZED: MockReply = {
  status: 401,
  body: problem(401, "UNAUTHORIZED", "Authentication required", {
    detail: "Your session expired",
  }),
};

/** A 403 problem reply. */
const FORBIDDEN: MockReply = {
  status: 403,
  body: problem(403, "FORBIDDEN", "Forbidden", { detail: "Operators only" }),
};

let assign: Mock<(url: string | URL) => void>;

beforeEach(() => {
  FakeSocket.instances = [];
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
});

afterEach(() => {
  assign.mockRestore();
});

/** Every default route answering `reply`, except the bootstrap's two. */
function everyScreenRead(reply: MockReply) {
  return Object.fromEntries(
    Object.keys(defaultHandlers())
      .filter((key) => key !== "GET /meta" && key !== "GET /meta/permissions")
      .map((key) => [key, reply]),
  );
}

/** Waits for the stub to be called, then lets every other failure land too. */
async function navigated(): Promise<void> {
  await waitFor(() => expect(assign).toHaveBeenCalled());
  // The other reads were in flight together; let them all fail before counting.
  for (let index = 0; index < 5; index++) {
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

describe("unauthorized: API failures", () => {
  it("sends the browser to the target once, with the path, query and fragment, when several reads fail together", async () => {
    // The Overview: several sections read at once.
    visit("/jobs?q=mail#top");
    const { calls } = renderApp({
      config: { unauthorized: TO_LOGIN },
      handlers: everyScreenRead(UNAUTHORIZED),
    });
    await navigated();
    const failed = calls.filter(
      (call) => call.path !== "/meta" && call.path !== "/meta/permissions",
    );
    // Negative control on "together": more than one read did fail with 401.
    expect(failed.length).toBeGreaterThan(1);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      "/login?returnTo=%2Fjobs%3Fq%3Dmail%23top",
    );
  });

  it("redirects when the bootstrap itself is refused (a session that expired before the page loaded)", async () => {
    visit("/jobs/workers");
    renderApp({
      config: { unauthorized: TO_LOGIN },
      handlers: { "GET /meta": UNAUTHORIZED },
    });
    await navigated();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fjobs%2Fworkers");
  });

  it("leaves a 403 alone by default: the screens explain it", async () => {
    renderApp({
      config: { unauthorized: TO_LOGIN },
      handlers: { "GET /meta/permissions": FORBIDDEN },
    });
    const screen = await page().findByTestId("bootstrap-error", {}, LOADED);
    expect(screen.textContent).toContain("Access denied");
    expect(screen.textContent).toContain("Operators only");
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects on a 401 from the summon domain's reads (the typed client's path, once it lands)", async () => {
    visit("/jobs/summon");
    const { calls } = renderApp({
      config: { unauthorized: TO_LOGIN },
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, summonList: true },
          }),
        },
        "GET /summon": UNAUTHORIZED,
      },
    });
    await navigated();
    // Negative control on the source: the summon read is what was refused.
    expect(calls.map((call) => call.path)).toContain("/summon");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fjobs%2Fsummon");
  });

  it("redirects once from the docs section: the embedded viewer screens add no redirect of their own", async () => {
    visit("/jobs/docs/http");
    const { calls } = renderApp({
      config: { unauthorized: TO_LOGIN },
      handlers: { "GET /openapi.json": UNAUTHORIZED },
    });
    await navigated();
    // Negative control on the source: the document read is what was refused.
    expect(calls.map((call) => call.path)).toContain("/openapi.json");
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      "/login?returnTo=%2Fjobs%2Fdocs%2Fhttp",
    );
  });

  it("redirects a 403 too when statuses lists it", async () => {
    renderApp({
      config: { unauthorized: { ...TO_LOGIN, statuses: [401, 403] } },
      handlers: { "GET /meta/permissions": FORBIDDEN },
    });
    await navigated();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fjobs");
  });

  it("does not redirect a 401 when statuses lists only 403", async () => {
    renderApp({
      config: { unauthorized: { ...TO_LOGIN, statuses: [403] } },
      handlers: { "GET /meta": UNAUTHORIZED },
    });
    const screen = await page().findByTestId("bootstrap-error", {}, LOADED);
    expect(screen.textContent).toContain("Sign in required");
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("with returnParam off, goes to the target as written", async () => {
    visit("/jobs/queues");
    renderApp({
      config: {
        unauthorized: {
          redirectTo: "https://id.example/sign-in?app=jobs",
          returnParam: null,
          statuses: [401],
        },
      },
      handlers: { "GET /meta": UNAUTHORIZED },
    });
    await navigated();
    expect(assign).toHaveBeenCalledWith("https://id.example/sign-in?app=jobs");
  });

  it("keeps an absolute target absolute, adding the return path to its query", async () => {
    visit("/jobs/queues/emails");
    renderApp({
      config: {
        unauthorized: {
          ...TO_LOGIN,
          redirectTo: "https://id.example/sign-in?app=jobs",
          returnParam: "next",
        },
      },
      handlers: { "GET /meta": UNAUTHORIZED },
    });
    await navigated();
    expect(assign).toHaveBeenCalledWith(
      "https://id.example/sign-in?app=jobs&next=%2Fjobs%2Fqueues%2Femails",
    );
  });

  it("never follows a target that would load this UI again (an absolute URL into basePath)", async () => {
    renderApp({
      config: {
        unauthorized: {
          ...TO_LOGIN,
          redirectTo: "http://localhost/JOBS/sign-in",
        },
      },
      handlers: { "GET /meta": UNAUTHORIZED },
    });
    const screen = await page().findByTestId("bootstrap-error", {}, LOADED);
    expect(screen.textContent).toContain("Sign in required");
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects on a failed mutation, and on any client's error that carries a status", async () => {
    const { queryClient } = renderApp({ config: { unauthorized: TO_LOGIN } });
    await page().findByTestId("app-ready", {}, LOADED);
    expect(assign).not.toHaveBeenCalled();
    // The shape of bun-client's HttpError: not an ApiError, a numeric status.
    const foreign = Object.assign(new Error("HTTP 401"), { status: 401 });
    await act(async () => {
      await queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationFn: () => Promise.reject(foreign),
        })
        .execute(undefined)
        .catch(() => {});
    });
    expect(assign).toHaveBeenCalledTimes(1);
    // Once per page load: a second failure does not navigate again.
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: ["unauthorized-redirect-test"],
          queryFn: () =>
            Promise.reject(
              new ApiError({
                kind: "problem",
                status: 401,
                code: "UNAUTHORIZED",
                title: "Authentication required",
              }),
            ),
        })
        .catch(() => {});
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("is off by default: a 401 navigates nowhere and the sign-in screen shows", async () => {
    renderApp({ handlers: { "GET /meta": UNAUTHORIZED } });
    const screen = await page().findByTestId("bootstrap-error", {}, LOADED);
    expect(screen.textContent).toContain("Sign in required");
    expect(screen.textContent).toContain("Your session expired");
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("is off by default for every screen read too", async () => {
    renderApp({ handlers: everyScreenRead(UNAUTHORIZED) });
    await page().findByTestId("app-ready", {}, LOADED);
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        await Bun.sleep(5);
      });
    }
    expect(assign).not.toHaveBeenCalled();
    expectAbsent(page().queryByTestId("bootstrap-error"));
  });
});

describe("parseUiConfig: unauthorized", () => {
  it("reads a missing field as off, passes a resolved option, and refuses a malformed one", () => {
    const { unauthorized: _omit, ...withoutField } = uiConfig();
    expectAbsent(parseUiConfig(withoutField).unauthorized);
    expect(
      parseUiConfig(uiConfig({ unauthorized: TO_LOGIN })).unauthorized,
    ).toEqual(TO_LOGIN);
    for (const unauthorized of [
      "/login",
      { redirectTo: "/login" },
      { ...TO_LOGIN, statuses: [500] },
    ]) {
      expect(() => parseUiConfig({ ...uiConfig(), unauthorized })).toThrow(
        UiConfigError,
      );
    }
  });
});

describe("unauthorized: the live socket", () => {
  /** Renders the app with the fake socket, connected and live. */
  async function connectedApp(unauthorized: UiUnauthorized | null) {
    visit("/jobs/queues");
    renderApp({
      config: { unauthorized },
      live: { WebSocket: FakeSocket, random: () => 0 },
    });
    await page().findByTestId("app-ready", {}, LOADED);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const socket = FakeSocket.last;
    await act(async () => {
      socket.open();
      socket.receive(hello());
      await settle();
    });
    return socket;
  }

  it("redirects on the UNAUTHORIZED close", async () => {
    const socket = await connectedApp(TO_LOGIN);
    expect(assign).not.toHaveBeenCalled();
    await act(async () => {
      socket.drop(JOBS_API_WS_CLOSE.UNAUTHORIZED);
      await settle();
    });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fjobs%2Fqueues");
  });

  it("redirects when the server refuses a subscribe with 401", async () => {
    const socket = await connectedApp(TO_LOGIN);
    await waitFor(() =>
      expect(socket.ops("subscribe").length).toBeGreaterThan(0),
    );
    await act(async () => {
      for (const frame of socket.ops("subscribe")) {
        socket.receive({
          type: "ack",
          id: frame.id,
          op: "subscribe",
          channels: [],
          rejected: frame.channels.map((channel) => ({
            channel,
            code: "UNAUTHORIZED",
            status: 401,
          })),
          seq: 0,
        });
      }
      await settle();
    });
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("is off by default: the close only stops the socket", async () => {
    const socket = await connectedApp(null);
    await act(async () => {
      socket.drop(JOBS_API_WS_CLOSE.UNAUTHORIZED);
      await settle();
    });
    await waitFor(() =>
      expect(page().getByTestId("live-status").dataset.state).toBe("refused"),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("unauthorized: a crashed screen", () => {
  /** A screen that throws, as one whose chunk failed to load does. */
  function Broken(): never {
    throw new TypeError(
      "Failed to fetch dynamically imported module: /jobs/assets/x.js",
    );
  }

  /** `Routes` with the broken screen at `/`, under `redirect`, with the shell answering `status`. */
  function renderBroken(status: number, enabled = true) {
    const asked: string[] = [];
    const redirect = createUnauthorizedRedirect(
      enabled ? TO_LOGIN : null,
      "/jobs",
      {
        fetch: () =>
          (async (url: string, init?: RequestInit) => {
            asked.push(`${init?.method ?? "GET"} ${url}`);
            return new Response(null, { status });
          }) as unknown as typeof fetch,
      },
    );
    render(
      <UnauthorizedRedirectContext value={redirect}>
        <RouterProvider basePath="/jobs">
          <Routes
            routes={[{ path: "/", element: <Broken /> }]}
            notFound={null}
          />
        </RouterProvider>
      </UnauthorizedRedirectContext>,
    );
    return asked;
  }

  // React reports every caught render error on console.error; these are deliberate.
  let quiet: Mock<(...args: unknown[]) => void>;
  beforeEach(() => {
    quiet = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => quiet.mockRestore());

  it("asks the server with a HEAD of the shell, and redirects on a listed status", async () => {
    const asked = renderBroken(401);
    await page().findByTestId("screen-error", {}, LOADED);
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(asked).toEqual(["HEAD /jobs"]);
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fjobs");
  });

  it("stays on the crash panel when the shell still loads", async () => {
    const asked = renderBroken(200);
    await page().findByTestId("screen-error", {}, LOADED);
    await waitFor(() => expect(asked).toEqual(["HEAD /jobs"]));
    await settle();
    expect(assign).not.toHaveBeenCalled();
  });

  it("asks nothing when the option is off", async () => {
    const asked = renderBroken(401, false);
    await page().findByTestId("screen-error", {}, LOADED);
    await settle();
    expect(asked).toEqual([]);
    expect(assign).not.toHaveBeenCalled();
  });
});
