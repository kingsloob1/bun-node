import type {
  ApplyJobDefaultsBody,
  ApplyJobDefaultsResultDto,
  JobDefaultsDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
} from "../../../app/api/contract";
import {
  APPLY_IRREVERSIBLE,
  CODE_SOURCE_HINT,
  EXHAUSTED_WARNING,
  INCLUDE_UNMARKED_HINT,
  RESET_CANNOT_RESTORE,
} from "../../../app/screens/queues/panels/jobDefaults/text";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import {
  findDialog,
  notifications,
  NOW,
  openDialog,
  renderQueue,
} from "./fixtures";

setupDom();

/**
 * The queue screen's Job defaults panel, its Settings… editor and its Apply
 * to pending jobs… action, against a mocked API: the routes are not served by
 * bun-jobs yet, so every answer here is the contract's shape, typed by it.
 */

/** `GET /queues/emails/job-defaults`: attempts and timeout overridden, attempts LOWERED below the code's. */
function defaultsFixture(
  overrides: Partial<JobDefaultsDto> = {},
): JobDefaultsDto {
  const code: JobDefaultsDto["code"] = {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    timeout: 0,
    priority: 0,
    removeOnComplete: false,
    removeOnFail: { count: 100 },
    keepLogs: 0,
    keepStacktraces: 10,
  };
  return {
    queue: "emails",
    effective: { ...code, attempts: 3, timeout: 30_000 },
    code,
    codeSource: "api",
    overridden: ["attempts", "timeout"],
    override: { attempts: 3, timeout: 30_000 },
    seq: 4,
    updatedAt: NOW - 60_000,
    propagationMs: 1_000,
    pending: {
      waiting: 1_200,
      delayed: 10,
      failed: 5,
      "waiting-children": 0,
      total: 1_215,
    },
    ...overrides,
  };
}

/** One apply answer. */
function batch(
  overrides: Partial<ApplyJobDefaultsResultDto> = {},
): ApplyJobDefaultsResultDto {
  return {
    seq: 4,
    keys: ["attempts", "timeout"],
    dryRun: false,
    examined: 1_000,
    rewritten: 900,
    unchanged: 50,
    skippedExplicit: 30,
    skippedUnmarked: 15,
    moved: 5,
    exhausted: 2,
    next: "c1",
    done: false,
    ...overrides,
  };
}

/** Every call to `METHOD path`. */
function callsTo(calls: RecordedCall[], method: string, path: string) {
  return calls.filter((call) => call.method === method && call.path === path);
}

/** The apply calls' bodies, in order. */
function applyBodies(calls: RecordedCall[]): ApplyJobDefaultsBody[] {
  return callsTo(calls, "POST", "/queues/emails/job-defaults/apply").map(
    (call) => JSON.parse(call.body!) as ApplyJobDefaultsBody,
  );
}

/** Options of {@link renderDefaults}. */
interface RenderDefaultsOptions {
  /** Extra permissions, over the defaults (both job-defaults actions are opt-in, so off). */
  actions?: Record<string, boolean>;
  /** `meta.readOnly`. */
  readOnly?: boolean;
  /** Route handlers, over the job-defaults read. */
  handlers?: Record<string, MockHandler | MockReply>;
}

/** The queue screen with the job-defaults read answered and the given permissions. */
function renderDefaults(options: RenderDefaultsOptions = {}) {
  return renderQueue({
    handlers: {
      "GET /meta": {
        body: metaFixture({ readOnly: options.readOnly ?? false }),
      },
      "GET /meta/permissions": {
        body: permissionsFixture(options.actions ?? {}),
      },
      "GET /queues/emails/job-defaults": { body: defaultsFixture() },
      ...options.handlers,
    },
  });
}

/** Both job-defaults actions granted. */
const BOTH = { "queues.defaults": true, "queues.applyDefaults": true };

/** The panel tab labels once the screen loaded. */
async function panelLabels(): Promise<string[]> {
  await page().findByTestId("queue-total");
  const list = await page().findByRole("tablist", { name: "Queue details" });
  return within(list)
    .getAllByRole("tab")
    .map((tab) => tab.textContent ?? "");
}

/** Opens the Job defaults tab and returns its panel once loaded. */
async function openPanel(): Promise<HTMLElement> {
  await page().findByTestId("queue-total");
  const tab = await page().findByRole("tab", { name: "Job defaults" });
  fireEvent.click(tab);
  return page().findByTestId("job-defaults-panel");
}

/** Opens Settings… and returns the dialog. */
async function openSettings(): Promise<HTMLElement> {
  const panel = await openPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Settings…" }));
  return findDialog();
}

/** Opens Apply to N pending jobs… and returns the dialog. */
async function openApply(): Promise<HTMLElement> {
  const panel = await openPanel();
  fireEvent.click(
    within(panel).getByRole("button", { name: /^Apply to .* pending jobs…$/ }),
  );
  return findDialog();
}

/** Sets an input's value. */
function type(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

describe("the Job defaults panel's gate", () => {
  it("is absent, and reads nothing, where the API does not serve job defaults", async () => {
    // `features.jobDefaults` is false in `runner` mode and on a driver
    // without support; the gate follows it and never probes the route.
    const meta = metaFixture();
    meta.features = { ...meta.features, jobDefaults: false };
    const { calls } = renderQueue({
      handlers: { "GET /meta": { body: meta } },
    });
    expect(await panelLabels()).not.toContain("Job defaults");
    expect(callsTo(calls, "GET", "/queues/emails/job-defaults")).toHaveLength(
      0,
    );
  });

  it("offers Settings… but not Apply where the apply route is not served", async () => {
    const meta = metaFixture();
    meta.features = { ...meta.features, jobDefaultsApply: false };
    renderDefaults({
      actions: BOTH,
      handlers: { "GET /meta": { body: meta } },
    });
    const panel = await openPanel();
    expect(
      within(panel).getByRole("button", { name: "Settings…" }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: /^Apply to/ }),
    ).toBeNull();
  });

  it("is a read-only summary when the read succeeds and neither action is granted", async () => {
    renderDefaults();
    const panel = await openPanel();
    const row = within(panel).getByTestId("job-default-row-attempts");
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("5");
    expect(row.textContent).toContain("Overridden");
    expect(
      within(panel).getByTestId("job-default-row-priority").textContent,
    ).toContain("code value");
    expect(panel.textContent).toContain(CODE_SOURCE_HINT);
    expect(panel.textContent).toContain("within about 1s");
    // The pending counts, per state and in total.
    expect(panel.textContent).toContain("1,200");
    expect(panel.textContent).toContain("1,215");
    expect(
      within(panel).queryByRole("button", { name: "Settings…" }),
    ).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: /^Apply to/ }),
    ).toBeNull();
  });

  it("builds one row per contract key, in the contract's order", async () => {
    renderDefaults();
    const panel = await openPanel();
    const rows = within(panel)
      .getAllByTestId(/^job-default-row-/)
      .map((row) => row.dataset.testid);
    expect(rows).toEqual(
      JOB_DEFAULT_KEYS.map((key) => `job-default-row-${key}`),
    );
  });

  it("offers Settings… with queues.defaults alone, and no Apply", async () => {
    renderDefaults({ actions: { "queues.defaults": true } });
    const panel = await openPanel();
    expect(
      within(panel).getByRole("button", { name: "Settings…" }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: /^Apply to/ }),
    ).toBeNull();
  });

  it("offers Apply with queues.applyDefaults alone, and no Settings…", async () => {
    renderDefaults({ actions: { "queues.applyDefaults": true } });
    const panel = await openPanel();
    expect(
      within(panel).getByRole("button", {
        name: "Apply to 1,215 pending jobs…",
      }),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", { name: "Settings…" }),
    ).toBeNull();
  });

  it("shows the panel at once when queues.defaults is granted, before the read answers", async () => {
    // A granted action proves the routes are registered: the tab does not
    // wait on the probe (here, one that never answers).
    renderDefaults({
      actions: BOTH,
      handlers: {
        "GET /queues/emails/job-defaults": () =>
          new Promise<MockReply>(() => {}),
      },
    });
    expect(await panelLabels()).toContain("Job defaults");
  });

  it("offers neither button on a read-only API, whatever the permissions say", async () => {
    renderDefaults({ actions: BOTH, readOnly: true });
    const panel = await openPanel();
    expect(
      within(panel).queryByRole("button", { name: "Settings…" }),
    ).toBeNull();
    expect(
      within(panel).queryByRole("button", { name: /^Apply to/ }),
    ).toBeNull();
  });

  it("is absent without queues.read, and never reads", async () => {
    const { calls } = renderDefaults({
      actions: { ...BOTH, "queues.read": false },
    });
    await page().findByTestId("queue-screen");
    await waitFor(() =>
      expect(callsTo(calls, "GET", "/meta/permissions").length).toBeGreaterThan(
        0,
      ),
    );
    expect(callsTo(calls, "GET", "/queues/emails/job-defaults")).toHaveLength(
      0,
    );
    expect(page().queryByRole("tab", { name: "Job defaults" })).toBeNull();
  });

  it("says why Apply is not offered when nothing is overridden", async () => {
    renderDefaults({
      actions: BOTH,
      handlers: {
        "GET /queues/emails/job-defaults": {
          body: defaultsFixture({
            overridden: [],
            override: {},
            effective: defaultsFixture().code,
          }),
        },
      },
    });
    const panel = await openPanel();
    expect(
      within(panel).getByTestId("apply-unavailable").textContent,
    ).toContain("Nothing is overridden");
    expect(
      within(panel).queryByRole("button", { name: /^Apply to/ }),
    ).toBeNull();
  });
});

describe("the job defaults editor", () => {
  it("builds its inputs from the contract's keys, bounds and backoff types", async () => {
    renderDefaults({ actions: BOTH });
    const dialog = await openSettings();
    for (const key of JOB_DEFAULT_KEYS) {
      expect(within(dialog).getByTestId(`job-default-${key}`)).toBeTruthy();
    }
    const attempts = within(dialog).getByLabelText(
      "Attempts",
    ) as HTMLInputElement;
    expect(attempts.min).toBe(String(JOB_DEFAULTS_BOUNDS.attempts.min));
    expect(attempts.max).toBe(String(JOB_DEFAULTS_BOUNDS.attempts.max));
    expect(attempts.value).toBe("3");
    const keepLogs = within(dialog).getByLabelText(
      "Log lines kept",
    ) as HTMLInputElement;
    expect(keepLogs.min).toBe(String(JOB_DEFAULTS_BOUNDS.keepLogs.min));
    const strategy = within(dialog).getByLabelText(
      "Backoff strategy",
    ) as HTMLSelectElement;
    expect([...strategy.options].map((option) => option.value)).toEqual([
      ...JOB_DEFAULT_BACKOFF_TYPES,
    ]);
    // Effective vs code, per setting, and what "code" means.
    expect(
      within(dialog).getByTestId("job-default-attempts").textContent,
    ).toContain("Now: 3 · Code: 5");
    expect(dialog.textContent).toContain(CODE_SOURCE_HINT);
  });

  it("sends a merge patch: only the changed keys, null for a key set back to the code's, and expectedSeq", async () => {
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "PUT /queues/emails/job-defaults": {
          body: defaultsFixture({ seq: 5 }),
        },
      },
    });
    const dialog = await openSettings();
    type(within(dialog).getByLabelText("Priority"), "7");
    // Typing a key's current value is no change.
    type(within(dialog).getByLabelText("Stack traces kept"), "10");
    fireEvent.click(
      within(within(dialog).getByTestId("job-default-timeout")).getByRole(
        "button",
        { name: "Use code value" },
      ),
    );
    expect(
      within(dialog).getByTestId("job-default-timeout").textContent,
    ).toContain("Will use the code value (none) once saved");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Saved the job defaults of emails. Producers pick this up within about 1s.",
      ),
    );
    const put = callsTo(calls, "PUT", "/queues/emails/job-defaults")[0]!;
    expect(JSON.parse(put.body!)).toEqual({
      timeout: null,
      priority: 7,
      expectedSeq: 4,
    });
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("sends a backoff and a retention in the stored shapes", async () => {
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "PUT /queues/emails/job-defaults": {
          body: defaultsFixture({ seq: 5 }),
        },
      },
    });
    const dialog = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("Backoff strategy"), {
      target: { value: "fixed" },
    });
    type(within(dialog).getByLabelText("Backoff delay (ms)"), "2000");
    type(within(dialog).getByLabelText("Backoff longest delay (ms)"), "8000");
    fireEvent.change(within(dialog).getByLabelText("Completed jobs"), {
      target: { value: "limit" },
    });
    type(within(dialog).getByLabelText("Completed jobs: most kept"), "50");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/queues/emails/job-defaults")).toHaveLength(
        1,
      ),
    );
    expect(
      JSON.parse(
        callsTo(calls, "PUT", "/queues/emails/job-defaults")[0]!.body!,
      ),
    ).toEqual({
      backoff: { type: "fixed", delay: 2000, max: 8000 },
      removeOnComplete: { count: 50 },
      expectedSeq: 4,
    });
  });

  it("refuses a value outside the contract's bounds before sending", async () => {
    const { calls } = renderDefaults({ actions: BOTH });
    const dialog = await openSettings();
    type(
      within(dialog).getByLabelText("Attempts"),
      String(JOB_DEFAULTS_BOUNDS.attempts.max + 1),
    );
    expect(
      within(dialog).getByTestId("job-default-attempts").textContent,
    ).toContain("from 1 to 1,000");
    const save = within(dialog).getByRole("button", {
      name: "Save defaults",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(callsTo(calls, "PUT", "/queues/emails/job-defaults")).toHaveLength(
      0,
    );
  });

  it("resets every key with DELETE, and says beside Reset that rewritten jobs cannot be restored", async () => {
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "DELETE /queues/emails/job-defaults": {
          body: defaultsFixture({
            overridden: [],
            override: {},
            effective: defaultsFixture().code,
            seq: 5,
          }),
        },
      },
    });
    const dialog = await openSettings();
    const reset = within(dialog).getByRole("button", {
      name: "Reset to code values",
    });
    // The caveat is the button's own description, next to it.
    const noteId = reset.getAttribute("aria-describedby")!;
    const note = document.getElementById(noteId)!;
    expect(note.textContent).toBe(RESET_CANNOT_RESTORE);
    expect(note.textContent).toContain("cannot restore jobs already rewritten");
    expect(reset.parentElement).toBe(note.parentElement);
    fireEvent.click(reset);
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Reset the job defaults of emails to the code values.",
      ),
    );
    expect(
      callsTo(calls, "DELETE", "/queues/emails/job-defaults"),
    ).toHaveLength(1);
  });

  it("refuses on a seq conflict and asks to re-read, then saves against the new seq", async () => {
    let reads = 0;
    let puts = 0;
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "GET /queues/emails/job-defaults": () => {
          reads += 1;
          return { body: defaultsFixture({ seq: reads === 1 ? 4 : 9 }) };
        },
        "PUT /queues/emails/job-defaults": () => {
          puts += 1;
          return puts === 1
            ? {
                status: 409,
                body: problem(409, "CONTROL_CONTENDED", "Control contended"),
              }
            : { body: defaultsFixture({ seq: 10 }) };
        },
      },
    });
    const dialog = await openSettings();
    type(within(dialog).getByLabelText("Priority"), "7");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("changed since you opened them");
    expect(alert.textContent).toContain("Nothing was saved");
    fireEvent.click(
      within(alert).getByRole("button", { name: "Re-read the defaults" }),
    );
    // The form starts over from the fresh read: the edit is gone.
    await waitFor(() =>
      expect(
        (within(dialog).getByLabelText("Priority") as HTMLInputElement).value,
      ).toBe("0"),
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();
    type(within(dialog).getByLabelText("Priority"), "8");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save defaults" }),
    );
    await waitFor(() => expect(puts).toBe(2));
    const bodies = callsTo(calls, "PUT", "/queues/emails/job-defaults").map(
      (call) => JSON.parse(call.body!),
    );
    expect(bodies[0]).toEqual({ priority: 7, expectedSeq: 4 });
    expect(bodies[1]).toEqual({ priority: 8, expectedSeq: 9 });
  });
});

describe("applying the defaults to pending jobs", () => {
  it("is its own confirmation: the values written, the states (all ticked), includeUnmarked off, and that it cannot be undone", async () => {
    renderDefaults({ actions: BOTH });
    const dialog = await openApply();
    expect(dialog.textContent).toContain(APPLY_IRREVERSIBLE);
    expect(
      within(dialog).getByRole("list", { name: "Values written" }).textContent,
    ).toContain("Attempts: 3");
    for (const state of JOB_DEFAULTS_APPLY_STATES) {
      const label = {
        waiting: "Waiting (1,200)",
        delayed: "Delayed (10)",
        failed: "Retrying (5)",
        "waiting-children": "Waiting children (0)",
      }[state];
      expect(
        (within(dialog).getByLabelText(label) as HTMLInputElement).checked,
      ).toBe(true);
    }
    const unmarked = within(dialog).getByLabelText(
      "Include jobs added before this version",
    ) as HTMLInputElement;
    expect(unmarked.checked).toBe(false);
    expect(dialog.textContent).toContain(INCLUDE_UNMARKED_HINT);
  });

  it("walks every batch, cursor to next, until done, and reports the counts", async () => {
    let call = 0;
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "POST /queues/emails/job-defaults/apply": () => {
          call += 1;
          return {
            body:
              call === 1
                ? batch({ next: "c1" })
                : call === 2
                  ? batch({ next: "c2" })
                  : batch({
                      examined: 215,
                      rewritten: 200,
                      unchanged: 10,
                      skippedExplicit: 5,
                      skippedUnmarked: 0,
                      moved: 0,
                      exhausted: 1,
                      next: null,
                      done: true,
                    }),
          };
        },
      },
    });
    const dialog = await openApply();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Apply to 1,215 pending jobs",
      }),
    );
    const result = await within(dialog).findByTestId("apply-result");
    const bodies = applyBodies(calls);
    expect(bodies).toHaveLength(3);
    const common = {
      seq: 4,
      states: [...JOB_DEFAULTS_APPLY_STATES],
      limit: 1000,
      dryRun: false,
      includeUnmarked: false,
    };
    expect(bodies[0]).toEqual(common);
    expect(bodies[1]).toEqual({ ...common, cursor: "c1" });
    expect(bodies[2]).toEqual({ ...common, cursor: "c2" });
    const text = result.textContent ?? "";
    expect(text).toContain("Applied to every pending job");
    // 1000 + 1000 + 215; 900 + 900 + 200; …
    expect(text).toContain("Examined2,215");
    expect(text).toContain("Rewritten2,000");
    expect(text).toContain("Unchanged110");
    expect(text).toContain("Skipped as explicit65");
    expect(text).toContain("Skipped, added before this version30");
    expect(text).toContain("Moved10");
    expect(text).toContain("Exhausted5");
    expect(text).toContain("5 jobs got one final attempt");
  });

  it("stops between batches on Cancel, and can continue from the cursor", async () => {
    let call = 0;
    let release: () => void = () => {};
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "POST /queues/emails/job-defaults/apply": async () => {
          call += 1;
          if (call === 2) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return {
            body: batch({
              next: call >= 3 ? null : `c${call}`,
              done: call >= 3,
            }),
          };
        },
      },
    });
    const dialog = await openApply();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Apply to 1,215 pending jobs",
      }),
    );
    // Batch 1 answered; batch 2 is in flight.
    const progress = await within(dialog).findByTestId("apply-progress");
    await waitFor(() => expect(call).toBe(2));
    expect(progress.textContent).toContain("examined 1,000");
    expect(progress.textContent).toContain("rewritten 900 so far");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      within(dialog).getByRole("button", {
        name: "Stopping after this batch…",
      }),
    ).toBeTruthy();
    release();
    const result = await within(dialog).findByTestId("apply-result");
    expect(result.textContent).toContain("Stopped after 2 batches");
    expect(applyBodies(calls)).toHaveLength(2);

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Continue from where it stopped",
      }),
    );
    await waitFor(() => expect(applyBodies(calls)).toHaveLength(3));
    expect(applyBodies(calls)[2]!.cursor).toBe("c2");
    await within(dialog).findByText(
      "Applied to every pending job in the chosen states.",
    );
    expect(within(dialog).getByTestId("apply-result").textContent).toContain(
      "Examined3,000",
    );
  });

  it("previews with dryRun first, showing what WOULD change, then applies for real", async () => {
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "POST /queues/emails/job-defaults/apply": (request) => {
          const body = JSON.parse(request.body!) as ApplyJobDefaultsBody;
          return {
            body: batch({
              dryRun: body.dryRun === true,
              next: null,
              done: true,
            }),
          };
        },
      },
    });
    const dialog = await openApply();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Preview (dry run)" }),
    );
    const preview = await within(dialog).findByRole("region", {
      name: "Preview",
    });
    expect(preview.textContent).toContain("nothing was written");
    expect(preview.textContent).toContain("Would be rewritten900");
    expect(preview.textContent).toContain("2 jobs would get one final attempt");
    expect(applyBodies(calls)[0]!.dryRun).toBe(true);
    // Still on the confirmation, with the real action offered.
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Apply to 1,215 pending jobs",
      }),
    );
    await within(dialog).findByTestId("apply-result");
    expect(applyBodies(calls)[1]!.dryRun).toBe(false);
  });

  it("sends only the ticked states, and includeUnmarked when ticked", async () => {
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "POST /queues/emails/job-defaults/apply": {
          body: batch({ next: null, done: true }),
        },
      },
    });
    const dialog = await openApply();
    fireEvent.click(within(dialog).getByLabelText("Retrying (5)"));
    fireEvent.click(within(dialog).getByLabelText("Delayed (10)"));
    fireEvent.click(
      within(dialog).getByLabelText("Include jobs added before this version"),
    );
    // The count follows the ticked states.
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Apply to 1,200 pending jobs",
      }),
    );
    await within(dialog).findByTestId("apply-result");
    expect(applyBodies(calls)[0]).toMatchObject({
      states: ["waiting", "waiting-children"],
      includeUnmarked: true,
    });
  });

  it("warns that a lowered attempts gives exhausted jobs ONE final attempt", async () => {
    renderDefaults({ actions: BOTH });
    const dialog = await openApply();
    expect(
      within(dialog).getByTestId("exhausted-warning").textContent,
    ).toContain(EXHAUSTED_WARNING);
  });

  it("does not warn when attempts is not being lowered", async () => {
    const raised = defaultsFixture();
    raised.effective = { ...raised.effective, attempts: 8 };
    raised.override = { ...raised.override, attempts: 8 };
    renderDefaults({
      actions: BOTH,
      handlers: { "GET /queues/emails/job-defaults": { body: raised } },
    });
    const dialog = await openApply();
    expect(within(dialog).queryByTestId("exhausted-warning")).toBeNull();
  });

  it("stops on DEFAULTS_CHANGED, asks to re-read, and applies the new seq after", async () => {
    let reads = 0;
    let call = 0;
    const { calls } = renderDefaults({
      actions: BOTH,
      handlers: {
        "GET /queues/emails/job-defaults": () => {
          reads += 1;
          return { body: defaultsFixture({ seq: reads === 1 ? 4 : 6 }) };
        },
        "POST /queues/emails/job-defaults/apply": () => {
          call += 1;
          if (call === 2) {
            return {
              status: 409,
              body: problem(
                409,
                "DEFAULTS_CHANGED",
                "Job defaults changed since they were confirmed",
              ),
            };
          }
          return {
            body: batch(call === 1 ? {} : { seq: 6, next: null, done: true }),
          };
        },
      },
    });
    const dialog = await openApply();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Apply to 1,215 pending jobs",
      }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("changed since you confirmed them");
    expect(alert.textContent).toContain("900 jobs had already been rewritten");
    expect(applyBodies(calls)).toHaveLength(2);
    fireEvent.click(
      within(alert).getByRole("button", { name: "Re-read the defaults" }),
    );
    const again = await within(dialog).findByRole("button", {
      name: "Apply to 1,215 pending jobs",
    });
    fireEvent.click(again);
    await within(dialog).findByTestId("apply-result");
    const bodies = applyBodies(calls);
    expect(bodies[0]!.seq).toBe(4);
    expect(bodies[2]!.seq).toBe(6);
    expect(bodies[2]!.cursor).toBeUndefined();
  });
});
