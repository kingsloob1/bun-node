import type {
  SummonCheckDto,
  SummonOutcomeKind,
  SummonStatusDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { SUMMON_OUTCOMES } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import {
  attemptCoverage,
  COVERAGE_MISSING_HINT,
  SHARED_UNIT_FORBIDDEN,
  showCoverage,
  SUMMON_PARTIAL_HINT,
  summonActionsOffered,
  summonCheckSummary,
  summonEventSummary,
  summonInert,
  summonLastDetail,
  summonLastMissing,
  summonOutcome,
  summonPartialText,
  summonStateKnown,
} from "../../../app/screens/queues/panels/summonText";
import { expectAbsent, expectNone, expectUndefined } from "../assert";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import {
  errorToasts,
  findDialog,
  notifications,
  renderQueue,
} from "./fixtures";
import { policyFixture } from "./summonPolicyFixture";

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

/** What the panel says of summon state the server could not read. */
const UNREADABLE_TEXT =
  "This queue's summon state cannot be read: it is not in a shape any version of bun-jobs writes, so its attempts, failures and budget are unknown here.";

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
async function openPanel(handlers: Record<string, MockHandler | MockReply>) {
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
    // What is left in each window; summonBudget.test.tsx covers the rest.
    expect(
      within(panel).getByTestId("summon-budget-hour").textContent,
    ).toContain("27 of 30 left this hour");
    expect(
      within(panel).getByTestId("summon-budget-day").textContent,
    ).toContain("288 of 300 left today");
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

  it("shows no counts for summon state that cannot be read, only why", async () => {
    // What `GET /queues/:queue/summon` answers for it: nothing pending, no
    // failures and no budget, as placeholders rather than facts.
    const { panel } = await openPanel(
      granted(
        statusFixture({
          local: false,
          summoner: undefined,
          inert: true,
          inertReason: "unreadable-marker",
          budget: undefined,
          pending: [],
          failures: 0,
          last: undefined,
        }),
      ),
    );
    expect(within(panel).getByTestId("summon-inert").textContent).toBe(
      UNREADABLE_TEXT,
    );
    expect(within(panel).getByTestId("summon-stored").textContent).toContain(
      "another process",
    );
    expect(within(panel).getByTestId("summon-last").textContent).toBe(
      "None yet",
    );
    for (const testId of [
      "summon-pending-count",
      "summon-failures",
      "summon-budget",
      "summon-backoff",
      "summon-circuit",
    ]) {
      expectAbsent(within(panel).queryByTestId(testId));
    }
    expect(panel.textContent).not.toContain("On their way");
    expect(panel.textContent).not.toContain("Consecutive failures");
    expectAbsent(within(panel).queryByRole("table"));
  });

  it("still shows the counts of other inert state, zeros included", async () => {
    // The control for the test above: the same remote, budgetless, inert
    // status, but for a reason whose counts were read.
    const { panel } = await openPanel(
      granted(
        statusFixture({
          local: false,
          summoner: undefined,
          inert: true,
          inertReason: "newer-marker",
          budget: undefined,
          pending: [],
          failures: 0,
          last: undefined,
        }),
      ),
    );
    expect(within(panel).getByTestId("summon-pending-count").textContent).toBe(
      "0",
    );
    expect(within(panel).getByTestId("summon-failures").textContent).toBe("0");
    expect(panel.textContent).toContain("On their way");
    expect(panel.textContent).toContain("Consecutive failures");
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
    expect(within(panel).getByTestId("summon-stored").textContent).toContain(
      "another process",
    );
  });

  it("shows a remote queue's budget with its limits unknown, not as off", async () => {
    const panel = await expectNoActions(
      granted(
        statusFixture({
          local: false,
          summoner: undefined,
          budget: {
            hour: 1,
            day: 1,
            limitsUnknown: true,
            hourResetsAt: Date.now() + 23 * 60_000,
            dayResetsAt: Date.now() + 9 * 3_600_000,
          },
        }),
      ),
    );
    const budget = within(panel).getByTestId("summon-budget");
    expect(budget.textContent).toBe(
      "1 this hour, 1 today (UTC), limits unknown",
    );
    expect(budget.dataset.limitsUnknown).toBe("true");
    expect(panel.textContent).not.toContain("no limit");
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

  it("says why summon state that cannot be read is inert, in its own words", () => {
    expect(summonInert("unreadable-marker")).toBe(UNREADABLE_TEXT);
    expect(summonInert("unreadable-marker")).not.toContain(
      'This controller is inert ("',
    );
  });

  it("treats only unreadable summon state as unknown", () => {
    expect(summonStateKnown({ inertReason: "unreadable-marker" })).toBe(false);
    expect(summonStateKnown({ inertReason: "newer-marker" })).toBe(true);
    expect(summonStateKnown({ inertReason: "summoned-process" })).toBe(true);
    expect(summonStateKnown({})).toBe(true);
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

describe("a shared summon unit", () => {
  /** The unit's queues the caller may read, `emails` (this tab's) first. */
  const UNIT = ["emails", "thumbs", "previews"];

  /** A shared unit's status, as any of its queues answers it. */
  function unitStatus(
    overrides: Partial<SummonStatusDto> = {},
  ): SummonStatusDto {
    return statusFixture({ queues: UNIT, ...overrides });
  }

  /**
   * `GET /meta/permissions` answered per target: the untargeted map without
   * `queues.summon`, so only a queue's own map can grant it; each queue in
   * `grants` with `queues.summon` as given, `"pending"` never answering.
   */
  function perQueue(grants: Record<string, boolean | "pending">): MockHandler {
    return (call: RecordedCall) => {
      const queue = call.query.get("queue");
      if (queue === null) {
        return { body: permissionsFixture() };
      }
      const grant = grants[queue] ?? false;
      if (grant === "pending") {
        return new Promise<MockReply>(() => {});
      }
      return { body: permissionsFixture({ "queues.summon": grant }) };
    };
  }

  /** The queues `/meta/permissions` was asked about, `null` for untargeted. */
  function askedAbout(calls: readonly RecordedCall[]): (string | null)[] {
    return calls
      .filter((call) => call.path === "/meta/permissions")
      .map((call) => call.query.get("queue"));
  }

  /** Handlers for a shared unit's tab: its status and per-queue grants. */
  function unitHandlers(
    grants: Record<string, boolean | "pending">,
    status: SummonStatusDto = unitStatus(),
    extra: Record<string, MockReply> = {},
  ): Record<string, MockHandler | MockReply> {
    return {
      "GET /meta/permissions": perQueue(grants),
      "GET /queues/emails/summon": { body: status },
      ...extra,
    };
  }

  /**
   * Opens the tab and waits until every member's map has been asked for
   * and a moment has passed for the answers to land.
   */
  async function openUnit(handlers: Record<string, MockHandler | MockReply>) {
    const opened = await openPanel(handlers);
    await waitFor(() =>
      expect(new Set(askedAbout(opened.calls))).toEqual(
        new Set([null, ...UNIT]),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return opened;
  }

  it("names the unit's queues, this one marked, each linked to its Summon tab", async () => {
    const { panel } = await openUnit(
      unitHandlers({ emails: true, thumbs: true, previews: true }),
    );
    const unit = within(panel).getByTestId("summon-unit");
    expect(unit.textContent).toBe(
      "One process for 3 queues: emails (this queue), thumbs, previews",
    );
    expect(
      within(unit)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "/jobs/queues/emails?panel=summon",
      "/jobs/queues/thumbs?panel=summon",
      "/jobs/queues/previews?panel=summon",
    ]);
    // No overlaps reported: no notice.
    expectAbsent(within(panel).queryByTestId("summon-overlaps"));
  });

  it("warns when another group's summoned workers were seen on the unit's queues", async () => {
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus({ overlaps: ["batch", "media"] }),
      ),
    );
    const notice = within(panel).getByTestId("summon-overlaps");
    expect(notice.className).toContain("notice");
    expect(notice.textContent).toBe(
      "Workers summoned for another summon group (batch, media) were seen on this unit's queues at the last check: two units may be serving the same queues.",
    );
  });

  it("offers Summon now and Reset where every member allows queues.summon", async () => {
    const { panel } = await openUnit(
      unitHandlers({ emails: true, thumbs: true, previews: true }),
    );
    await within(panel).findByRole("button", { name: "Summon now…" });
    expect(within(panel).getByRole("button", { name: "Reset…" })).toBeTruthy();
  });

  it("offers neither where one member refuses queues.summon", async () => {
    const { panel } = await openUnit(
      unitHandlers({ emails: true, thumbs: true, previews: false }),
    );
    // The queue's own map has answered: its header's Pause is there.
    const header = await page().findByRole("group", { name: "Queue actions" });
    await within(header).findByRole("button", { name: /Pause/ });
    expectAbsent(within(panel).queryByRole("button", { name: "Summon now…" }));
    expectAbsent(within(panel).queryByRole("button", { name: "Reset…" }));
  });

  it("offers neither while a member's map is still loading", async () => {
    const { panel } = await openUnit(
      unitHandlers({ emails: true, thumbs: "pending", previews: true }),
    );
    expectAbsent(within(panel).queryByRole("button", { name: "Summon now…" }));
    expectAbsent(within(panel).queryByRole("button", { name: "Reset…" }));
  });

  it("offers neither read-only, whatever the members allow", async () => {
    const { panel } = await openUnit({
      ...unitHandlers({ emails: true, thumbs: true, previews: true }),
      "GET /meta": { body: metaFixture({ readOnly: true }) },
    });
    expectAbsent(within(panel).queryByRole("button", { name: "Summon now…" }));
    expectAbsent(within(panel).queryByRole("button", { name: "Reset…" }));
  });

  it("says a 403 on Summon now needs queues.summon on every queue of the unit", async () => {
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus(),
        {
          "POST /queues/emails/summon": {
            status: 403,
            body: problem(403, "FORBIDDEN", "Forbidden", {
              detail: "Not allowed to summon this unit",
            }),
          },
        },
      ),
    );
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Summon now…" }),
    );
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Summon now" }));
    await waitFor(() =>
      expect(errorToasts().textContent).toContain(SHARED_UNIT_FORBIDDEN),
    );
    expect(errorToasts().textContent).toContain(
      "Not allowed to summon this unit",
    );
  });

  it("says the same of a 403 on Reset", async () => {
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus(),
        {
          "POST /queues/emails/summon/reset": {
            status: 403,
            body: problem(403, "FORBIDDEN", "Forbidden"),
          },
        },
      ),
    );
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Reset…" }),
    );
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(errorToasts().textContent).toContain(SHARED_UNIT_FORBIDDEN),
    );
  });

  it("keeps a single queue's tab as it was: no unit line, no overlaps notice, its own map alone decides", async () => {
    const { panel, calls } = await openPanel(granted());
    await within(panel).findByRole("button", { name: "Summon now…" });
    expect(within(panel).getByRole("button", { name: "Reset…" })).toBeTruthy();
    expectAbsent(within(panel).queryByTestId("summon-unit"));
    expectAbsent(within(panel).queryByTestId("summon-overlaps"));
    expect(panel.textContent).not.toContain("Shared unit");
    // No other queue's map is read.
    expect(
      askedAbout(calls).filter((queue) => queue !== null && queue !== "emails"),
    ).toEqual([]);
  });

  it("gates a single queue by its own map even when it is not granted elsewhere", async () => {
    // The untargeted map refuses, `emails`' own map grants: offered, as before.
    const { panel } = await openPanel({
      "GET /meta/permissions": perQueue({ emails: true }),
      "GET /queues/emails/summon": { body: statusFixture() },
    });
    await within(panel).findByRole("button", { name: "Summon now…" });
  });

  it("shows no shared-unit toast for a single queue's 403", async () => {
    const { panel } = await openPanel(
      granted(statusFixture(), {
        "POST /queues/emails/summon": {
          status: 403,
          body: problem(403, "FORBIDDEN", "Forbidden"),
        },
      }),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Summon now…" }));
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Summon now" }));
    // The dialog shows the refusal in place, as it always has.
    await within(dialog).findByText("Forbidden");
    expect(errorToasts().textContent).not.toContain(SHARED_UNIT_FORBIDDEN);
  });

  it("warns of overlaps on a single queue too, in its own words", async () => {
    const { panel } = await openPanel(
      granted(statusFixture({ overlaps: ["media"] })),
    );
    expect(within(panel).getByTestId("summon-overlaps").textContent).toBe(
      "Workers summoned for another summon group (media) were seen on this queue at the last check: two units may be serving the same queue.",
    );
    expectAbsent(within(panel).queryByTestId("summon-unit"));
  });

  /** The `data-testid`s of the coverage badges in an attempt's row, in order. */
  function coverageIds(row: HTMLElement): string[] {
    return [
      ...row.querySelectorAll<HTMLElement>('[data-testid^="summon-coverage-"]'),
    ].map((badge) => badge.dataset.testid ?? "");
  }

  it("shows each attempt's coverage of the unit's queues, in the unit's order then by name, this queue marked", async () => {
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus({
          pending: [
            {
              id: "s-1",
              at: NOW - 20_000,
              until: NOW + 160_000,
              count: 1,
              kind: "ecs",
              coverage: {
                zeta: "pending",
                previews: "missing",
                archive: "registered",
                thumbs: "registered",
                emails: "pending",
              },
            },
            {
              id: "s-2",
              at: NOW - 10_000,
              until: NOW + 170_000,
              count: 1,
              kind: "ecs",
            },
          ],
        }),
      ),
    );
    const table = within(panel).getByRole("table", {
      name: "Summon attempts on their way for emails",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Attempt",
      "Started",
      "Lost unless a worker registers",
      "Workers",
      "Summoner",
      "Coverage",
    ]);
    const row = within(panel).getByTestId("summon-pending-s-1");
    expect(coverageIds(row)).toEqual([
      "summon-coverage-s-1-emails",
      "summon-coverage-s-1-thumbs",
      "summon-coverage-s-1-previews",
      "summon-coverage-s-1-archive",
      "summon-coverage-s-1-zeta",
    ]);
    const mine = within(row).getByTestId("summon-coverage-s-1-emails");
    expect(mine.textContent).toBe("emails pending");
    expect(mine.className).toContain("badge-neutral");
    expect(mine.parentElement?.textContent).toBe("emails pending (this queue)");
    const registered = within(row).getByTestId("summon-coverage-s-1-thumbs");
    expect(registered.textContent).toBe("✓ thumbs");
    expect(registered.className).toContain("badge-success");
    expect(registered.parentElement?.textContent).toBe("✓ thumbs");
    expect(registered.hasAttribute("title")).toBe(false);
    const missing = within(row).getByTestId("summon-coverage-s-1-previews");
    expect(missing.textContent).toBe("✗ previews missing");
    expect(missing.className).toContain("badge-danger");
    expect(missing.title).toBe(COVERAGE_MISSING_HINT);
    expect(COVERAGE_MISSING_HINT).toBe(
      "No worker registered on this queue before the attempt's boot budget ran out.",
    );
    // An attempt without coverage, beside one with (negative control): "—".
    const bare = within(panel).getByTestId("summon-pending-s-2");
    expectNone(coverageIds(bare));
    expect(bare.querySelectorAll("td")[4]?.textContent).toBe("—");
  });

  it("has no Coverage column where no attempt carries coverage (negative control)", async () => {
    // A shared unit whose coverage reads failed: its attempt has none.
    const { panel } = await openUnit(
      unitHandlers({ emails: true, thumbs: true, previews: true }),
    );
    const row = within(panel).getByTestId("summon-pending-s-1");
    expectAbsent(
      within(panel).queryByRole("columnheader", { name: "Coverage" }),
    );
    expectNone(coverageIds(row));
    expect(row.querySelectorAll("td")).toHaveLength(4);
  });

  it("says which queues a partial last attempt missed, in place of its raw detail", async () => {
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus({
          last: {
            id: "s-1",
            outcome: "registered",
            at: NOW - 5_000,
            detail: "partial:thumbs,previews",
            missing: ["thumbs", "previews"],
          },
        }),
      ),
    );
    const last = within(panel).getByTestId("summon-last");
    const line = within(last).getByTestId("summon-last-missing");
    expect(line.textContent).toBe(
      "Partial: no worker registered on thumbs, previews",
    );
    expect(line.className).toContain("summon-last-missing");
    // After the outcome badge and its time.
    const time = last.querySelector("time");
    expect(
      time !== null &&
        (time.compareDocumentPosition(line) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
    expect(last.textContent).toContain("Registered");
    expect(last.textContent).not.toContain("partial:");
    expect(panel.textContent).toContain(SUMMON_PARTIAL_HINT);
  });

  it("shows no partial line, and the detail as before, without missing (negative control)", async () => {
    // An outcome an older bun-jobs wrote: the detail alone names the queues.
    const { panel } = await openUnit(
      unitHandlers(
        { emails: true, thumbs: true, previews: true },
        unitStatus({
          last: {
            id: "s-1",
            outcome: "registered",
            at: NOW - 5_000,
            detail: "partial:previews",
          },
        }),
      ),
    );
    const last = within(panel).getByTestId("summon-last");
    expectAbsent(within(last).queryByTestId("summon-last-missing"));
    expect(last.textContent).toEndWith(" — partial:previews");
    expect(panel.textContent).not.toContain(SUMMON_PARTIAL_HINT);
  });
});

describe("a shared unit's summon text", () => {
  it("names the queues a shared unit's event is for, and the ones it missed", () => {
    expect(
      summonEventSummary({
        id: "s-1",
        outcome: "registered",
        kind: "ecs",
        count: 1,
        queues: ["renders", "thumbs", "previews"],
        missing: ["previews"],
        detail: "partial:previews",
        eventId: "e-1",
      }),
    ).toBe(
      "Registered 1 worker (ecs), for renders, thumbs, previews; missing previews",
    );
    expect(
      summonEventSummary({
        id: "s-1",
        outcome: "started",
        kind: "ecs",
        reason: "add",
        queues: ["renders", "thumbs"],
      }),
    ).toBe("Started (ecs), because a job was added, for renders, thumbs");
    // A detail other than the partial one stays.
    expect(
      summonEventSummary({
        id: "s-1",
        outcome: "failed",
        kind: "ecs",
        queues: ["renders"],
        detail: "quota",
      }),
    ).toBe("Failed (ecs), for renders: quota");
  });

  it("lists an attempt's coverage in the unit's order, then by name, a state it does not know as text", () => {
    const badges = attemptCoverage(
      {
        b: "registered",
        thumbs: "missing",
        a: "hibernating" as "pending",
        emails: "pending",
      },
      ["emails", "thumbs", "previews"],
      "thumbs",
    );
    expect(badges).toEqual([
      {
        queue: "emails",
        label: "emails pending",
        tone: "neutral",
        title: undefined,
        current: false,
      },
      {
        queue: "thumbs",
        label: "✗ thumbs missing",
        tone: "danger",
        title: COVERAGE_MISSING_HINT,
        current: true,
      },
      {
        queue: "a",
        label: "a hibernating",
        tone: "neutral",
        title: undefined,
        current: false,
      },
      {
        queue: "b",
        label: "✓ b",
        tone: "success",
        title: undefined,
        current: false,
      },
    ]);
    // Without the unit's order, by name alone.
    expect(
      attemptCoverage({ b: "pending", a: "pending" }, undefined, "x")?.map(
        (badge) => badge.queue,
      ),
    ).toEqual(["a", "b"]);
    // No coverage (one queue's attempt, a failed read), or not an object.
    expectUndefined(attemptCoverage(undefined, ["emails"], "emails"));
    expectUndefined(
      attemptCoverage(
        ["emails"] as unknown as Record<string, "pending">,
        undefined,
        "emails",
      ),
    );
    expect(showCoverage([{}, { coverage: {} }])).toBe(true);
    expect(showCoverage([{}, {}])).toBe(false);
  });

  it("names a partial attempt's missing queues, and leaves out the partial detail only then", () => {
    expect(summonPartialText(["thumbs", "previews"])).toBe(
      "Partial: no worker registered on thumbs, previews",
    );
    const partial = { detail: "partial:previews", missing: ["previews"] };
    expect(summonLastMissing(partial)).toEqual(["previews"]);
    expectUndefined(summonLastDetail(partial));
    // Without missing, the detail is all there is.
    expect(summonLastDetail({ detail: "partial:previews" })).toBe(
      "partial:previews",
    );
    expectNone(summonLastMissing({}));
    expectNone(
      summonLastMissing({ missing: "previews" as unknown as string[] }),
    );
    // Another detail stays beside missing.
    expect(summonLastDetail({ detail: "quota", missing: ["previews"] })).toBe(
      "quota",
    );
    expectUndefined(summonLastDetail({}));
  });

  it("names the queue whose demand a check read", () => {
    const demand = {
      queue: "thumbs",
      at: NOW,
      paused: false,
      waiting: 0,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: null,
      demand: 0,
      outstanding: 0,
      capped: false,
      exact: true,
    };
    expect(summonCheckSummary({ action: "none", demand })).toBe(
      "Nothing to summon: demand on thumbs is 0",
    );
    expect(summonCheckSummary({ action: "none" })).toBe("Nothing to summon");
  });
});

describe("the Policy block", () => {
  /** `/meta` with `features.summonPolicy` as given. */
  function meta(summonPolicy: boolean): MockReply {
    return {
      body: metaFixture({
        features: { ...metaFixture().features, summonPolicy },
      }),
    };
  }

  /** Handlers for a status with `policy`, the feature on unless `feature` says otherwise. */
  function withPolicy(
    status: Partial<SummonStatusDto> = {},
    feature = true,
  ): Record<string, MockReply> {
    return granted(statusFixture({ policy: policyFixture(), ...status }), {
      "GET /meta": meta(feature),
    });
  }

  /** The Policy block's row `id` (its value), once the block is there. */
  async function policyRow(panel: HTMLElement, id: string) {
    const block = await within(panel).findByTestId("summon-policy");
    return within(block).getByTestId(`summon-policy-${id}`);
  }

  /** The "default" tags inside `element`. */
  function defaults(element: HTMLElement): number {
    return within(element).queryAllByTestId("summon-policy-default").length;
  }

  it("follows the Summoner, tagging each default and no value the policy set", async () => {
    const { panel } = await openPanel(
      withPolicy({
        policy: policyFixture({ explicit: ["cooldown", "backoff.initial"] }),
      }),
    );
    const block = await within(panel).findByTestId("summon-policy");
    expect(within(block).getByRole("heading").textContent).toBe("Policy");
    // After the Summoner, in document order.
    const order = [
      ...panel.querySelectorAll(
        '[data-testid="summon-summoner"], [data-testid="summon-policy"]',
      ),
    ].map((element) => element.getAttribute("data-testid"));
    expect(order).toEqual(["summon-summoner", "summon-policy"]);
    // Set by the policy: no tag.
    const cooldown = await policyRow(panel, "cooldown");
    expect(cooldown.textContent).toBe("15s");
    expect(defaults(cooldown)).toBe(0);
    // Set in part: the default piece alone is tagged.
    const backoff = await policyRow(panel, "backoff");
    expect(backoff.textContent).toBe("5s, doubling to 30s default");
    expect(defaults(backoff)).toBe(1);
    // Untouched: one tag for the row.
    const triggers = await policyRow(panel, "triggers");
    expect(triggers.textContent).toBe(
      "On add · Events (coalesced 250ms) · Poll every 10s default",
    );
    expect(defaults(triggers)).toBe(1);
    const circuit = await policyRow(panel, "circuit");
    expect(circuit.textContent).toBe("opens after 3 failures, for 1m default");
  });

  it("reads a null jobsPerWorker as one worker regardless of depth", async () => {
    const { panel } = await openPanel(
      withPolicy({ policy: policyFixture({ jobsPerWorker: null }) }),
    );
    expect((await policyRow(panel, "workers")).textContent).toBe(
      "at most 4 · one regardless of depth · at most 3 starting default",
    );
  });

  it("shows a trigger kind this build does not know as raw text", async () => {
    const webhook = { kind: "webhook", on: true, every: 5_000 } as never;
    const { panel } = await openPanel(
      withPolicy({
        policy: policyFixture({
          triggers: [{ kind: "poll", on: false }, webhook],
        }),
      }),
    );
    const triggers = await policyRow(panel, "triggers");
    expect(triggers.textContent).toBe(
      "Poll off default · webhook (on: true, every: 5000)",
    );
    expect(within(triggers).getByText("Poll off").className).toBe("muted");
  });

  it("is not shown with the feature off, policy or not (negative control)", async () => {
    const { panel } = await openPanel(withPolicy({}, false));
    await within(panel).findByTestId("summon-summoner");
    expectAbsent(within(panel).queryByTestId("summon-policy"), "the block");
    expectAbsent(
      within(panel).queryByTestId("summon-policy-elsewhere"),
      "the line",
    );
    // Nor is the Budget row tagged.
    expectNone(
      within(panel).queryAllByTestId("summon-policy-default"),
      "default tags",
    );
  });

  it("says in one line that a stored status's policy is known only where its controller runs", async () => {
    const { panel } = await openPanel(
      withPolicy({ local: false, summoner: undefined, policy: undefined }),
    );
    const line = await within(panel).findByTestId("summon-policy-elsewhere");
    expect(line.textContent).toBe(
      "Its policy is known only where its controller runs.",
    );
    expect(line.className).toBe("muted");
    expectAbsent(within(panel).queryByTestId("summon-policy"), "the block");
  });

  it("shows a shared unit's per-queue capacities with their overrides, and none for one queue", async () => {
    const { panel } = await openPanel(
      withPolicy({
        queues: ["emails", "thumbs"],
        policy: policyFixture({
          perQueue: {
            emails: { jobsPerWorker: 2, maxWorkers: 4, explicit: [] },
            thumbs: {
              jobsPerWorker: null,
              maxWorkers: 1,
              explicit: ["jobsPerWorker", "maxWorkers"],
            },
          },
        }),
      }),
    );
    const block = await within(panel).findByTestId("summon-policy");
    const table = within(block).getByTestId("summon-policy-per-queue");
    const emails = within(table).getByTestId("summon-policy-per-queue-emails");
    expect(emails.textContent).toBe("emails2 jobs per worker4");
    expectNone(
      within(emails).queryAllByTestId("summon-policy-override"),
      "emails' overrides",
    );
    const thumbs = within(table).getByTestId("summon-policy-per-queue-thumbs");
    expect(thumbs.textContent).toBe(
      "thumbsone regardless of depth override1 override",
    );
    expect(
      within(thumbs).getAllByTestId("summon-policy-override"),
    ).toHaveLength(2);
    // After Workers.
    const labels = [...block.querySelectorAll("dt")].map(
      (dt) => dt.textContent,
    );
    expect(labels.indexOf("Per queue")).toBe(labels.indexOf("Workers") + 1);
  });

  it("has no per-queue table for one queue's controller (negative control)", async () => {
    const { panel } = await openPanel(withPolicy());
    const block = await within(panel).findByTestId("summon-policy");
    expectAbsent(
      within(block).queryByTestId("summon-policy-per-queue"),
      "the per-queue table",
    );
  });

  it('takes the shutdown from the summoner\'s capabilities, "none" included, and has none before them', async () => {
    const first = await openPanel(withPolicy());
    expect((await policyRow(first.panel, "shutdown")).textContent).toBe(
      "SIGTERM, 10s grace",
    );
    first.unmount();

    const ready = statusFixture().summoner!;
    const none = await openPanel(
      withPolicy({
        summoner: {
          ...ready,
          capabilities: {
            ...ready.capabilities!,
            shutdown: { signal: "none", graceMs: 0 },
          },
        },
      }),
    );
    const shutdown = await policyRow(none.panel, "shutdown");
    expect(shutdown.textContent).toBe("no stop signal (in-invocation)");
    // Not a policy value: never tagged.
    expect(defaults(shutdown)).toBe(0);
    none.unmount();

    const pending = await openPanel(
      withPolicy({
        summoner: { ...ready, readiness: "pending", capabilities: undefined },
      }),
    );
    const block = await within(pending.panel).findByTestId("summon-policy");
    expectAbsent(
      within(block).queryByTestId("summon-policy-shutdown"),
      "the Shutdown row",
    );
  });

  it("shows no group thresholds on a shared unit, and shows them for a per-queue member of a shared circuit", async () => {
    const unit = await openPanel(
      withPolicy({
        queues: ["emails", "thumbs"],
        policy: policyFixture({
          perQueue: {
            emails: { jobsPerWorker: 2, maxWorkers: 4, explicit: [] },
            thumbs: { jobsPerWorker: 2, maxWorkers: 4, explicit: [] },
          },
        }),
      }),
    );
    const block = await within(unit.panel).findByTestId("summon-policy");
    expectAbsent(
      within(block).queryByTestId("summon-policy-group-circuit"),
      "the group's thresholds",
    );
    unit.unmount();

    // Control: a per-queue member with circuit.group shows them.
    const member = await openPanel(
      withPolicy({
        policy: policyFixture({
          circuit: {
            failures: 3,
            resetAfter: 60_000,
            group: { failures: 2, resetAfter: 300_000 },
          },
        }),
      }),
    );
    expect((await policyRow(member.panel, "group-circuit")).textContent).toBe(
      "opens after 2 failures across the group, for 5m default",
    );
  });

  it("reads an absent boot budget as the provider's default, never a number", async () => {
    const { bootBudget: _absent, ...policy } = policyFixture();
    const ready = statusFixture().summoner!;
    const { panel } = await openPanel(
      withPolicy({
        policy,
        summoner: { ...ready, readiness: "pending", capabilities: undefined },
      }),
    );
    const boot = await policyRow(panel, "boot-budget");
    expect(boot.textContent).toBe("(provider default)");
  });

  it("relabels the summoner's boot budget as the provider's default", async () => {
    const { panel } = await openPanel(withPolicy());
    const summoner = within(panel).getByTestId("summon-summoner");
    const labels = [...summoner.querySelectorAll("dt")].map(
      (dt) => dt.textContent,
    );
    expect(labels).toContain("Provider default boot budget");
    expect(labels).not.toContain("Boot budget");
    // The policy's own, in the Policy block.
    expect((await policyRow(panel, "boot-budget")).textContent).toBe(
      "2m default",
    );
  });

  it("tags the Budget row default where the policy gave no budget, and not where it gave one", async () => {
    const first = await openPanel(withPolicy());
    await within(first.panel).findByTestId("summon-policy");
    const budget = within(first.panel).getByTestId("summon-budget");
    expect(defaults(budget.closest("dd") as HTMLElement)).toBe(1);
    first.unmount();

    const set = await openPanel(
      withPolicy({ policy: policyFixture({ explicit: ["budget"] }) }),
    );
    await within(set.panel).findByTestId("summon-policy");
    const own = within(set.panel).getByTestId("summon-budget");
    expect(defaults(own.closest("dd") as HTMLElement)).toBe(0);
  });
});
