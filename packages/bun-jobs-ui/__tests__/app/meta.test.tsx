import type { JobsApiAction } from "../../app/api/contract";
import type { Permissions } from "../../app/api/types";
import { describe, expect, it } from "bun:test";
import { canPerform, useCan, useFeature } from "../../app/meta/hooks";
import { fireEvent, page, render, setupDom, waitFor } from "./dom";
import { metaFixture, permissionsFixture, problem } from "./fixtures";
import { renderApp } from "./renderApp";

setupDom();

describe("canPerform", () => {
  const permissions: Permissions = {
    actions: { "queues.pause": true, "queues.drain": false },
  };

  it("is true only for a present, true action", () => {
    expect(canPerform(permissions, "queues.pause")).toBe(true);
  });

  it("is false for an action present as false", () => {
    expect(canPerform(permissions, "queues.drain")).toBe(false);
  });

  it("is false for a pruned (absent) action", () => {
    expect("jobs.add" in permissions.actions).toBe(false);
    expect(canPerform(permissions, "jobs.add")).toBe(false);
  });
});

describe("the bootstrap", () => {
  it("loads meta and permissions, then marks the app ready", async () => {
    const { calls } = renderApp();
    expect(page().getByTestId("bootstrap-loading")).toBeTruthy();
    await page().findByTestId("app-ready");
    const paths = calls.map((call) => call.path);
    expect(paths).toContain("/meta");
    expect(paths).toContain("/meta/permissions");
  });

  it("shows the sign-in screen with the problem's detail on a 401, and retries", async () => {
    let denied = true;
    renderApp({
      handlers: {
        "GET /meta": () =>
          denied
            ? {
                status: 401,
                body: problem(401, "UNAUTHORIZED", "Unauthorized", {
                  detail: "Your session expired",
                }),
              }
            : { body: metaFixture() },
      },
    });
    const screen = await page().findByTestId("bootstrap-error");
    expect(screen.textContent).toContain("Sign in required");
    expect(screen.textContent).toContain("Your session expired");
    expect(screen.textContent).toContain("UNAUTHORIZED");
    expect(page().queryByTestId("app-ready")).toBeNull();

    denied = false;
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    await page().findByTestId("app-ready");
  });

  it("shows access denied on a 403 from permissions", async () => {
    renderApp({
      handlers: {
        "GET /meta/permissions": {
          status: 403,
          body: problem(403, "FORBIDDEN", "Forbidden", {
            detail: "Operators only",
          }),
        },
      },
    });
    const screen = await page().findByTestId("bootstrap-error");
    expect(screen.textContent).toContain("Access denied");
    expect(screen.textContent).toContain("Operators only");
  });

  it("shows a generic failure for anything else", async () => {
    renderApp({
      handlers: {
        "GET /meta": new Response("upstream down", {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "content-type": "text/plain" },
        }),
      },
    });
    const screen = await page().findByTestId("bootstrap-error");
    expect(screen.textContent).toContain("The jobs API could not be loaded");
    expect(screen.textContent).toContain("upstream down");
    expect(screen.textContent).toContain("HTTP_502");
  });
});

/** Renders what the hooks say. */
function Probe({ action }: { action: JobsApiAction }) {
  const can = useCan(action);
  const throughput = useFeature("throughput");
  return (
    <p data-testid="probe">{`${action}:${can} throughput:${throughput}`}</p>
  );
}

describe("useCan and useFeature", () => {
  it("read the loaded permissions and features", async () => {
    const { AppProviders } = await import("../../app/providers");
    const { createApiClient } = await import("../../app/api/client");
    const { createQueryClient } = await import("../../app/queryClient");
    const { mockFetch } = await import("./mockFetch");
    const { uiConfig } = await import("./fixtures");

    const mock = mockFetch({
      "GET /meta": {
        body: metaFixture({
          features: { ...metaFixture().features, throughput: false },
        }),
      },
      "GET /meta/permissions": {
        body: permissionsFixture({ "queues.drain": false }),
      },
    });
    const client = createApiClient(uiConfig(), { fetch: mock.fetch });
    const cases: [JobsApiAction, string][] = [
      ["queues.pause", "queues.pause:true throughput:false"],
      ["queues.drain", "queues.drain:false throughput:false"],
      ["jobs.add", "jobs.add:false throughput:false"],
    ];
    for (const [action, expected] of cases) {
      const view = render(
        <AppProviders
          config={uiConfig()}
          client={client}
          queryClient={createQueryClient({ retry: false })}
        >
          <Probe action={action} />
        </AppProviders>,
      );
      await waitFor(() =>
        expect(page().getByTestId("probe").textContent).toBe(expected),
      );
      view.unmount();
    }
  });
});
