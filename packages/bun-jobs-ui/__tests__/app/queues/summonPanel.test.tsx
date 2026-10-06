import type {
  SummonCheckDto,
  SummonOutcomeKind,
  SummonStatusDto,
} from "../../../app/api/types";
import type { MockReply } from "../mockFetch";
import { SUMMON_OUTCOMES } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import {
  summonActionsOffered,
  summonEventSummary,
  summonOutcome,
} from "../../../app/screens/queues/panels/summonText";
import { expectAbsent, expectUndefined } from "../assert";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import { findDialog, notifications, renderQueue } from "./fixtures";

setupDom();

/**
 * A queue's summoning (`GET /queues/:queue/summon`, "summon now" and reset):
 * the queue screen's Summon panel.
 *
 * The rules it keeps: a queue with no summoner in the API's process (409
 * `SUMMON_NOT_CONFIGURED`) has no tab at all, since `/meta` has no flag for
 * it; the two actions need the opt-in `queues.summon` and a local
 * controller, and ask first; and an outcome this build does not know is
 * shown as its raw string.
 */

const NOW = Date.now();

/** A summon status: a local, working controller with one attempt on its way. */
function statusFixture(
  overrides: Partial<SummonStatusDto> = {},
): SummonStatusDto {
  return {
    queue: "emails",
    local: true,
    inert: false,
    summoner: {
      provider: {
        name: "@acme/bun-jobs-ecs",
        version: "1.2.0",
        kind: "ecs",
        displayName: "Amazon ECS",
        apiVersion: { core: "0.1", summon: "0.1" },
      },
      providerId: "@acme/bun-jobs-ecs@1.2.0~1",
      readiness: "ready",
      capabilities: {
        style: "launch",
        dedupe: { kind: "none" },
        passes: "argv",
        bootBudgetMs: 180_000,
        shutdown: { signal: "SIGTERM", graceMs: 10_000 },
        maxLifetimeMs: null,
        enforcesLifetime: false,
      },
      facts: { cluster: "jobs-prod", region: "eu-west-1" },
    },
    pending: [
      {
        id: "s-1",
        at: NOW - 20_000,
        until: NOW + 160_000,
        count: 1,
        kind: "ecs",
      },
    ],
    failures: 0,
    budget: {
      hour: 3,
      perHour: 30,
      day: 12,
      perDay: 300,
      hourResetsAt: Date.UTC(2026, 0, 1, 1),
      dayResetsAt: Date.UTC(2026, 0, 2),
    },
    last: { id: "s-1", outcome: "started", at: NOW - 20_000 },
    ...overrides,
  };
}

/** The grants and handlers a summon-capable caller has. */
function granted(
  status: SummonStatusDto | MockReply = statusFixture(),
  extra: Record<string, MockReply> = {},
): Record<string, MockReply> {
  return {
    "GET /meta/permissions": {
      body: permissionsFixture({ "queues.summon": true }),
    },
    "GET /queues/emails/summon":
      "status" in status && typeof status.status === "number"
        ? (status as MockReply)
        : { body: status },
    ...extra,
  };
}

/** Opens the Summon panel of `emails`. */
async function openPanel(handlers: Record<string, MockReply>) {
  const rendered = renderQueue({
    path: "/queues/emails?panel=summon",
    handlers,
  });
  const panel = await page().findByTestId(
    "queue-summon",
    {},
    { timeout: 5_000 },
  );
  return { ...rendered, panel };
}

/** The panel tab labels once the screen loaded. */
async function tabLabels(): Promise<string[]> {
  await page().findByTestId("queue-total");
  // The summon read decides the tab; give it a moment to answer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const list = page().queryByRole("tablist", { name: "Queue details" });
  return list
    ? within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent ?? "")
    : [];
}

describe("the Summon tab", () => {
  it("is offered where the queue has a summoner, after Demand", async () => {
    renderQueue({ handlers: granted() });
    await waitFor(async () => expect(await tabLabels()).toContain("Summon"));
    const labels = await tabLabels();
    expect(labels.indexOf("Summon")).toBe(labels.indexOf("Demand") + 1);
  });

  it("is absent where the queue has no summoner here (409 SUMMON_NOT_CONFIGURED), and on a server without the routes", async () => {
    const replies: MockReply[] = [
      {
        status: 409,
        body: problem(409, "SUMMON_NOT_CONFIGURED", "No summon controller"),
      },
      { status: 404, body: problem(404, "NOT_FOUND", "Not found") },
    ];
    for (const reply of replies) {
      const { unmount, calls } = renderQueue({
        handlers: { "GET /queues/emails/summon": reply },
      });
      expect(await tabLabels()).not.toContain("Summon");
      expect(calls.some((call) => call.path === "/queues/emails/summon")).toBe(
        true,
      );
      unmount();
    }
  });

  it("is absent, and nothing is read, without queues.read", async () => {
    const { calls } = renderQueue({
      handlers: {
        ...granted(),
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.read": false }),
        },
      },
    });
    await page().findByTestId("queue-screen");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(page().queryByRole("tab", { name: "Summon" }));
    expect(calls.some((call) => call.path === "/queues/emails/summon")).toBe(
      false,
    );
  });
});

describe("the Summon panel", () => {
  it("shows the last outcome, what is on its way, the budget and the summoner", async () => {
    const { panel } = await openPanel(granted());
    expect(within(panel).getByTestId("summon-last").textContent).toContain(
      "Started",
    );
    expect(within(panel).getByTestId("summon-pending-count").textContent).toBe(
      "1",
    );
    expect(within(panel).getByTestId("summon-pending-s-1")).not.toBeNull();
    expect(within(panel).getByTestId("summon-budget").textContent).toBe(
      "3 of 30 this hour, 12 of 300 today (UTC)",
    );
    expect(within(panel).getByTestId("summon-provider").textContent).toContain(
      "Amazon ECS",
    );
    const summoner = within(panel).getByTestId("summon-summoner");
    expect(summoner.textContent).toContain("jobs-prod");
    expect(summoner.textContent).toContain("Launch: starts new units");
    // No backoff or circuit running: not shown.
    expectAbsent(within(panel).queryByTestId("summon-backoff"));
    expectAbsent(within(panel).queryByTestId("summon-circuit"));
    // No handles sent: no column, nothing marks them withheld.
    expect(panel.textContent).not.toMatch(/handle/i);
  });

  it("shows a budget the policy turned off as counts with no limit", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          budget: {
            hour: 41,
            day: 120,
            off: true,
            hourResetsAt: Date.UTC(2026, 0, 1, 1),
            dayResetsAt: Date.UTC(2026, 0, 2),
          },
        }),
      ),
    );
    expect(within(panel).getByTestId("summon-budget").textContent).toBe(
      "Off: 41 this hour, 120 today (UTC), no limit",
    );
  });

  it("shows a backoff and an open circuit while they run, and the failures that caused them", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          failures: 5,
          backoffUntil: NOW + 60_000,
          circuitOpenUntil: NOW + 900_000,
          last: {
            id: "s-9",
            outcome: "lost",
            at: NOW - 5_000,
            detail: "no worker registered",
          },
          pending: [],
        }),
      ),
    );
    expect(within(panel).getByTestId("summon-failures").textContent).toBe("5");
    expect(
      within(panel).getByTestId("summon-backoff").querySelector("time"),
    ).not.toBeNull();
    expect(
      within(panel).getByTestId("summon-circuit").querySelector("time"),
    ).not.toBeNull();
    const last = within(panel).getByTestId("summon-last");
    expect(last.textContent).toContain("Lost");
    expect(last.textContent).toContain("no worker registered");
  });

  it("says why an inert controller summons nothing", async () => {
    const { panel } = await openPanel(
      granted(statusFixture({ inert: true, inertReason: "newer-marker" })),
    );
    expect(within(panel).getByTestId("summon-inert").textContent).toContain(
      "newer version",
    );
  });

  it("shows an outcome this build does not know as its raw string", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          last: {
            id: "s-2",
            outcome: "hibernated" as SummonOutcomeKind,
            at: NOW,
          },
        }),
      ),
    );
    expect(within(panel).getByTestId("summon-last").textContent).toContain(
      "hibernated",
    );
  });

  it("shows the platform handles when the API sends them", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          pending: [
            {
              id: "s-1",
              at: NOW,
              until: NOW + 60_000,
              count: 1,
              kind: "ecs",
              handles: ["arn:aws:ecs:eu-west-1:123456789012:task/jobs/abc"],
            },
          ],
        }),
      ),
    );
    expect(panel.textContent).toContain(
      "arn:aws:ecs:eu-west-1:123456789012:task/jobs/abc",
    );
  });
});

describe("the summoner's readiness and Test connection", () => {
  /** The summoner's provider id in the fixture. */
  const ID = "@acme/bun-jobs-ecs@1.2.0~1";

  /** `GET /providers` listing the summoner's provider, with or without a preflight. */
  function providers(preflight: boolean): MockReply {
    return {
      body: {
        api: { core: "0.1", summon: "0.1" },
        providers: [
          {
            id: ID,
            provider: statusFixture().summoner!.provider,
            readiness: "ready",
            facts: {},
            preflight,
            configSchema: false,
          },
        ],
      },
    };
  }

  /** Every grant, both provider actions among them. */
  const WITH_PROVIDERS = {
    body: permissionsFixture({
      "providers.read": true,
      "providers.validate": true,
    }),
  };

  it("shows the summoner's readiness, and no declared capabilities while it is pending", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          summoner: {
            ...statusFixture().summoner!,
            readiness: "pending",
            capabilities: undefined,
          },
        }),
      ),
    );
    const summoner = within(panel).getByTestId("summon-summoner");
    const badge = within(summoner).getByTestId("summon-readiness");
    expect(badge.textContent).toBe("Pending");
    expect(badge.title).toContain("still being validated");
    // Not declared yet, so not shown: no invented style.
    expect(summoner.textContent).not.toContain("Style");
    expect(summoner.textContent).not.toContain("Boot budget");
  });

  it("offers Test connection where the provider has a preflight and the caller may validate", async () => {
    const { panel } = await openPanel({
      ...granted(statusFixture(), {
        "GET /providers": providers(true),
        [`POST /providers/${encodeURIComponent(ID)}/validate`]: {
          body: { id: ID, ok: true, checks: [] },
        },
      }),
      "GET /meta/permissions": WITH_PROVIDERS,
    });
    const button = await within(panel).findByRole("button", {
      name: "Test connection: Amazon ECS",
    });
    fireEvent.click(button);
    const result = await within(panel).findByTestId("provider-test-result");
    expect(result.textContent).toBe("Connected.");
  });

  it("offers no Test connection for a provider without a preflight, or without providers.read", async () => {
    const first = await openPanel({
      ...granted(statusFixture(), { "GET /providers": providers(false) }),
      "GET /meta/permissions": WITH_PROVIDERS,
    });
    await waitFor(() =>
      expect(first.calls.some((call) => call.path === "/providers")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(
      within(first.panel).queryByRole("button", { name: /Test connection/ }),
    );
    first.unmount();

    // providers.validate alone: the preflight is unknown, so nothing is read or offered.
    const second = await openPanel({
      ...granted(statusFixture(), { "GET /providers": providers(true) }),
      "GET /meta/permissions": {
        body: permissionsFixture({
          "queues.summon": true,
          "providers.validate": true,
        }),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expectAbsent(
      within(second.panel).queryByRole("button", { name: /Test connection/ }),
    );
    expect(second.calls.some((call) => call.path === "/providers")).toBe(false);
  });
});

describe("Summon now and Reset", () => {
  it("asks first, sends force as chosen, toasts what the check did and re-reads", async () => {
    const answer: SummonCheckDto = {
      action: "summoned",
      id: "s-7",
      outcome: "started",
    };
    const { panel, calls } = await openPanel(
      granted(statusFixture(), {
        "POST /queues/emails/summon": { body: answer },
      }),
    );
    const reads = () =>
      calls.filter(
        (call) =>
          call.method === "GET" && call.path === "/queues/emails/summon",
      ).length;
    const before = reads();
    fireEvent.click(within(panel).getByRole("button", { name: "Summon now…" }));
    const dialog = await findDialog();
    // Skip the cooldown is on by default; turn it off.
    fireEvent.click(within(dialog).getByLabelText("Skip the cooldown"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Summon now" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain("Started: attempt s-7"),
    );
    const post = calls.find(
      (call) => call.method === "POST" && call.path === "/queues/emails/summon",
    )!;
    expect(JSON.parse(post.body!)).toEqual({ force: false });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("says why a check summoned nothing", async () => {
    const { panel } = await openPanel(
      granted(statusFixture(), {
        "POST /queues/emails/summon": {
          body: { action: "skipped", reason: "circuit-open" },
        },
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Summon now…" }));
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Summon now" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Nothing summoned: the circuit is open after repeated failures",
      ),
    );
  });

  it("resets after asking, and sends no body", async () => {
    const { panel, calls } = await openPanel(
      granted(statusFixture({ failures: 3 }), {
        "POST /queues/emails/summon/reset": {
          body: statusFixture({ failures: 0 }),
        },
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Reset…" }));
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Reset the summon state of emails",
      ),
    );
    const post = calls.find(
      (call) => call.path === "/queues/emails/summon/reset",
    )!;
    expectUndefined(post.body);
  });

  /**
   * Asserts the actions are absent once the queue's own permissions have
   * answered: before that they are absent anyway, so an earlier check proves
   * nothing, and no sleep is long enough to be sure. The queue header's Pause
   * button is gated by the same permissions (`useCanMutate`), so once it is
   * there they have answered. Read-only needs no wait: it comes from `/meta`,
   * which loads before the screen renders.
   */
  async function expectNoActions(
    handlers: Record<string, MockReply>,
    { readOnly = false }: { readOnly?: boolean } = {},
  ) {
    const { panel } = await openPanel(handlers);
    if (!readOnly) {
      const header = await page().findByRole("group", {
        name: "Queue actions",
      });
      await within(header).findByRole("button", { name: /Pause/ });
    }
    expectAbsent(within(panel).queryByRole("button", { name: "Summon now…" }));
    expectAbsent(within(panel).queryByRole("button", { name: "Reset…" }));
    return panel;
  }

  it("offers neither without queues.summon", async () => {
    await expectNoActions({
      "GET /queues/emails/summon": { body: statusFixture() },
    });
  });

  it("offers neither read-only", async () => {
    await expectNoActions(
      {
        ...granted(),
        "GET /meta": { body: metaFixture({ readOnly: true }) },
      },
      { readOnly: true },
    );
  });

  it("offers neither for a controller in another process, and says why", async () => {
    const panel = await expectNoActions(
      granted(statusFixture({ local: false })),
    );
    expect(within(panel).getByTestId("summon-remote").textContent).toContain(
      "another process",
    );
  });
});

describe("summon text", () => {
  it("offers the actions only to a caller who may, on a controller in the API's process", () => {
    expect(summonActionsOffered({ local: true }, true)).toBe(true);
    expect(summonActionsOffered({ local: true }, false)).toBe(false);
    // Read from another process's controller: read-only, whoever asks.
    expect(summonActionsOffered({ local: false }, true)).toBe(false);
  });

  it("says how each outcome counts toward the circuit, as the controller counts it", () => {
    // Throttled is `unavailable` and not counted; quota and plain
    // `unavailable` are counted; auth and misconfiguration open it at once.
    const unavailable = summonOutcome("unavailable").hint;
    expect(unavailable).toContain("throttled call");
    expect(unavailable).toContain("except a throttle");
    const failed = summonOutcome("failed").hint;
    expect(failed).toContain(
      "auth or misconfiguration error opens the circuit at once",
    );
    expect(failed).toContain("counts only if no worker registers in time");
  });

  it("names every outcome the contract lists", () => {
    for (const outcome of SUMMON_OUTCOMES) {
      expect(summonOutcome(outcome).label).not.toBe(outcome);
    }
  });

  it("writes a summon event in one line", () => {
    expect(
      summonEventSummary({
        id: "s-1",
        outcome: "started",
        kind: "ecs",
        count: 2,
        reason: "add",
      }),
    ).toBe("Started 2 workers (ecs), because a job was added");
    expect(
      summonEventSummary({
        id: "",
        outcome: "budget-exhausted",
        kind: "ecs",
        detail: "hourly",
      }),
    ).toBe("Budget exhausted (ecs): hourly");
  });
});
