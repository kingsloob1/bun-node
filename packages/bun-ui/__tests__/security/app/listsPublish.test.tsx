/**
 * Publishing the draft from the Lists screen (PR-U3, ui.md §3): at the head
 * read, through step-up (the first U3 action wired to `withStepUp`: a
 * `401 step_up_required` opens the host's popup and the publish is retried
 * once on its message), an approval shown on a `202`, a dangerous change
 * confirmed by typing the scope, another publish first a `409` shown with a
 * reload, and the impact estimate for an operator with `rules:test`. The
 * popup goes through the real `window`, whose `open` the test replaces.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { STEP_UP_MESSAGE_TYPE } from "../../../app/security/stepUp";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { policyApi, publishes } from "./listsApi";
import { allPermissions, defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The head's entries and the draft's (one entry added). */
const HEAD = [{ ip: "203.0.113.0/24", action: "block" }];
const DRAFT = [...HEAD, { ip: "192.0.2.1", action: "drop" }];

/** The spy replacing `window.open` in a test, restored after it. */
let openSpy: ReturnType<typeof spyOn<Window, "open">> | undefined;

afterEach(() => {
  openSpy?.mockRestore();
  openSpy = undefined;
});

/** Opens the Lists screen over a draft, and its publish dialog. */
async function openPublish(
  options: {
    publish?: (inner: MockHandler) => MockHandler;
    routes?: Record<string, MockHandler | MockReply>;
  } = {},
) {
  const fake = policyApi({ head: HEAD, draft: DRAFT });
  const inner = fake.routes["POST /policies/:scope/publish"] as MockHandler;
  const rendered = renderApp({
    path: "/lists?scope=global",
    routes: {
      ...fake.routes,
      ...options.routes,
      ...(options.publish === undefined
        ? {}
        : { "POST /policies/:scope/publish": options.publish(inner) }),
    },
  });
  await page().findByTestId("lists", {}, LOADED);
  fireEvent.click(page().getByTestId("lists-publish"));
  const dialog = await page().findByRole("dialog", {}, LOADED);
  return { ...rendered, dialog, state: fake.state };
}

/** Presses the dialog's Publish. */
function confirm(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
}

/** The bodies of the publishes made. */
function bodies(calls: readonly MockCall[]): unknown[] {
  return publishes(calls).map((call) => call.body);
}

/** Replaces `window.open` with one recording the URL and returning `popup`. */
function fakePopup(popup: { closed: boolean } | null) {
  const opened: string[] = [];
  openSpy = spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return popup as Window | null;
  });
  return opened;
}

/** Delivers a step-up page's message from `origin`. */
function stepUpMessage(origin: string, ok: boolean): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin,
      data: { type: STEP_UP_MESSAGE_TYPE, ok },
    }),
  );
}

/** A publish that wants a step-up first, then runs `inner`. */
function steppedUp(inner: MockHandler): MockHandler {
  let asked = false;
  return (call) => {
    if (asked) return inner(call);
    asked = true;
    return problem(401, "step_up_required", {
      stepUpUrl: "/auth/step-up?for=publish",
    });
  };
}

describe("publish", () => {
  it("publishes at the head read, with the CSRF header and the message; the screen shows the new version", async () => {
    const { api, dialog } = await openPublish();
    expect(dialog.textContent).toContain(
      "Against the published version: 1 entry added, 0 removed, 0 changed.",
    );
    fireEvent.change(within(dialog).getByLabelText("Message"), {
      target: { value: "drop a scanner" },
    });
    confirm(dialog);
    await page().findByText("Published version 4", {}, LOADED);
    expect(bodies(api.calls)).toEqual([
      { expectedHead: "pv_3", message: "drop a scanner" },
    ]);
    expect(publishes(api.calls)[0].headers.get("x-bun-security-csrf")).toBe(
      "1",
    );
    await waitFor(() =>
      expect(page().getByTestId("lists-source").textContent).toContain(
        "Showing published version 4",
      ),
    );
    expectAbsent(page().queryByTestId("lists-draft-badge"), "the draft badge");
  });

  it("a 401 step_up_required opens the host's step-up popup and, on its ok from its origin, retries the publish once", async () => {
    const opened = fakePopup({ closed: false });
    const { api, dialog } = await openPublish({ publish: steppedUp });
    confirm(dialog);
    await waitFor(() => expect(opened.length).toBe(1));
    expect(opened).toEqual(["http://localhost/auth/step-up?for=publish"]);
    // A message from another origin is ignored: nothing is retried.
    stepUpMessage("https://evil.example.net", true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(publishes(api.calls).length).toBe(1);
    stepUpMessage("http://localhost", true);
    await page().findByText("Published version 4", {}, LOADED);
    expect(bodies(api.calls)).toEqual([
      { expectedHead: "pv_3" },
      { expectedHead: "pv_3" },
    ]);
  });

  it("a popup closed without the message retries nothing: the step-up error stands in the dialog", async () => {
    const popup = { closed: false };
    fakePopup(popup);
    const { api, dialog } = await openPublish({ publish: steppedUp });
    confirm(dialog);
    await waitFor(() => expect(publishes(api.calls).length).toBe(1));
    popup.closed = true;
    expect(
      (await within(dialog).findByRole("alert", {}, LOADED)).textContent,
    ).toContain("step_up_required");
    expect(publishes(api.calls).length).toBe(1);
  });

  it("a 202 shows the approval opened instead of a new version", async () => {
    const { api, dialog } = await openPublish({
      publish: () => () => ({
        status: 202,
        body: {
          id: "ap_1",
          action: "policy.publish",
          scope: "global",
          status: "pending",
          author: "op",
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_086_400_000,
          decidedBy: null,
          decidedAt: null,
          reason: null,
          dangerous: ["lists: a drop entry"],
          summary: {},
          revision: 1,
        },
      }),
    });
    confirm(dialog);
    const approval = await page().findByTestId("lists-approval", {}, LOADED);
    expect(approval.textContent).toContain("Approval ap_1 opened (pending)");
    expect(approval.textContent).toContain("Dangerous: lists: a drop entry");
    expect(publishes(api.calls).length).toBe(1);
    expectAbsent(page().queryByRole("dialog"), "the publish dialog");
  });

  it("a dangerous change is confirmed by typing the scope, as the 428 asks", async () => {
    const { api, dialog } = await openPublish({
      publish: (inner) => (call) =>
        (call.body as { confirm?: string }).confirm === "global"
          ? inner(call)
          : problem(428, "confirmation_required", {
              detail:
                'this change is dangerous: type the scope\'s name ("global") in confirm to publish it',
              dangerous: ["lists: an allow entry widened to 10.0.0.0/8"],
            }),
    });
    confirm(dialog);
    const input = await within(dialog).findByLabelText(
      /This change is dangerous/,
      {},
      LOADED,
    );
    const publish = within(dialog).getByRole("button", {
      name: "Publish",
    }) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    // What made it dangerous, from the problem's context.
    expect(within(dialog).getByTestId("lists-dangerous").textContent).toBe(
      "lists: an allow entry widened to 10.0.0.0/8",
    );
    fireEvent.change(input, { target: { value: "global" } });
    expect(publish.disabled).toBe(false);
    confirm(dialog);
    await page().findByText("Published version 4", {}, LOADED);
    expect(bodies(api.calls)).toEqual([
      { expectedHead: "pv_3" },
      { expectedHead: "pv_3", confirm: "global" },
    ]);
  });

  it("another publish first is a 409: shown with a reload", async () => {
    const { dialog, state } = await openPublish();
    state.head = { id: "pv_9", number: 9, policy: { lists: [] } };
    confirm(dialog);
    const conflict = await page().findByTestId("lists-conflict", {}, LOADED);
    expect(conflict.textContent).toContain(
      "The published version changed since you read it.",
    );
    expectAbsent(page().queryByRole("dialog"), "the publish dialog");
    fireEvent.click(page().getByTestId("lists-reload"));
    await waitFor(() =>
      expect(page().getByTestId("lists-source").textContent).toContain(
        "over version 9",
      ),
    );
  });
});

describe("the impact estimate", () => {
  /** Permissions with `rules:test` set to `value`. */
  function permissions(value: boolean): MockReply {
    return {
      body: {
        scope: "global",
        permissions: { ...allPermissions(true), "rules:test": value },
      },
    };
  }

  it("is offered with rules:test, and shows what would change", async () => {
    const { api, dialog } = await openPublish({
      routes: {
        "GET /meta/permissions": permissions(true),
        "POST /policies/:scope/impact": {
          body: {
            scope: "global",
            window: { from: 0, to: 1 },
            services: { replayed: ["checkout"], skipped: [] },
            events: { read: 120, stoppedBy: null },
            sampledAllows: { read: 0, rates: [] },
            transitions: [
              { from: "allow", to: "refuse", count: 7 },
              { from: "refuse", to: "refuse", count: 3 },
            ],
            rules: [],
            routes: [],
            subjects: {},
            labels: [],
          },
        },
      },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Estimate impact" }),
    );
    const impact = await within(dialog).findByTestId(
      "lists-impact",
      {},
      LOADED,
    );
    expect(impact.textContent).toBe(
      "Replayed 120 stored events on 1 service(s).7: allow → refuse",
    );
    expect(
      api.calls.filter((call) => call.path.endsWith("/impact")).length,
    ).toBe(1);
  });

  it("is absent without rules:test", async () => {
    const { dialog } = await openPublish({
      routes: { "GET /meta/permissions": permissions(false) },
    });
    expectAbsent(
      within(dialog).queryByRole("button", { name: "Estimate impact" }),
      "Estimate impact",
    );
  });
});

describe("permissions", () => {
  it("without policy:publish there is no Publish on a draft that changes something", async () => {
    const fake = policyApi({ head: HEAD, draft: DRAFT });
    renderApp({
      path: "/lists?scope=global",
      routes: {
        ...fake.routes,
        ...defaultRoutes({
          permissions: {
            global: { "policy:read": true, "policy:draft": true },
          },
        }),
        "GET /policies/:scope": fake.routes["GET /policies/:scope"],
      },
    });
    await page().findByTestId("lists-diff", {}, LOADED);
    expectAbsent(page().queryByTestId("lists-publish"), "Publish");
    // The draft's own controls are there: the absence is the permission's.
    expect(page().getByTestId("lists-discard-draft").textContent).toBe(
      "Discard draft",
    );
  });
});
