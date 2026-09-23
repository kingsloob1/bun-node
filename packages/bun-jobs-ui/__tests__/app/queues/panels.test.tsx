import type { RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import {
  metaFixture,
  permissionsFixture,
  problem,
  throughputFixture,
} from "../fixtures";
import {
  detailFixture,
  errorToasts,
  findDialog,
  notifications,
  openDialog,
  renderQueue,
  repeatablesFixture,
  workersFixture,
} from "./fixtures";

setupDom();

/** Every call to `METHOD path`. */
function callsTo(calls: RecordedCall[], method: string, path: string) {
  return calls.filter((call) => call.method === method && call.path === path);
}

/** The panels' tab list once the screen loaded. */
async function panelTabs() {
  await page().findByTestId("queue-total");
  return page().findByRole("tablist", { name: "Queue details" });
}

/** The panel tab labels. */
async function panelLabels(): Promise<string[]> {
  await page().findByTestId("queue-total");
  const list = page().queryByRole("tablist", { name: "Queue details" });
  return list
    ? within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent ?? "")
    : [];
}

/** The limits editor. */
async function limitsForm() {
  await panelTabs();
  return page().findByRole("form", { name: "Queue limits" });
}

/** Sets an input's value. */
function type(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

describe("the limits editor", () => {
  it("starts from the stored limits and PUTs the edited form", async () => {
    const { calls } = renderQueue({
      handlers: {
        "PUT /queues/emails/limits": (call) => ({
          body: JSON.parse(call.body!),
        }),
      },
    });
    const form = await limitsForm();
    expect(
      (within(form).getByLabelText("Queue: rate max") as HTMLInputElement)
        .value,
    ).toBe("10");
    expect(
      (within(form).getByLabelText("Queue: rate window") as HTMLInputElement)
        .value,
    ).toBe("60000");
    expect(
      (within(form).getByLabelText("Queue: concurrency") as HTMLInputElement)
        .value,
    ).toBe("4");

    type(within(form).getByLabelText("Queue: rate window"), "1 minute");
    type(within(form).getByLabelText("Queue: concurrency"), "8");
    fireEvent.click(within(form).getByRole("button", { name: "Add a name" }));
    type(within(form).getByLabelText("Name 1"), "send");
    type(within(form).getByLabelText("send: concurrency"), "2");
    fireEvent.click(within(form).getByRole("button", { name: "Save limits" }));

    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Saved the limits of emails",
      ),
    );
    const put = callsTo(calls, "PUT", "/queues/emails/limits")[0]!;
    expect(put.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(put.body!)).toEqual({
      rate: { max: 10, duration: "1 minute" },
      concurrency: 8,
      names: { send: { concurrency: 2 } },
    });
    // The save invalidates the queue, so its detail (and limits) re-read.
    await waitFor(() =>
      expect(callsTo(calls, "GET", "/queues/emails").length).toBeGreaterThan(1),
    );
  });

  it("describes every input: what it limits, across every worker, and that empty means none", async () => {
    renderQueue();
    const form = await limitsForm();
    /** The hint wired to an input as its description. */
    const hintOf = (label: string) => {
      const input = within(form).getByLabelText(label);
      const id = input.getAttribute("aria-describedby") ?? "";
      return id
        .split(" ")
        .map((part) => document.getElementById(part)?.textContent ?? "")
        .join(" ");
    };
    expect(hintOf("Queue: rate max")).toContain("START in one rate window");
    expect(hintOf("Queue: rate max")).toContain("jobs on this queue");
    expect(hintOf("Queue: rate window")).toContain("“1 minute”");
    // The queue-wide cap is not a worker's own concurrency; say both apply.
    expect(hintOf("Queue: concurrency")).toContain("across every worker");
    expect(hintOf("Queue: concurrency")).toContain("each worker's own");
    expect(hintOf("Queue: concurrency")).toContain("Empty means no limit");
  });

  it("names the job in a per-name row's hints, and explains the name field", async () => {
    renderQueue();
    const form = await limitsForm();
    fireEvent.click(within(form).getByRole("button", { name: "Add a name" }));
    // Unnamed, the row's hints still say what they limit.
    const unnamed = within(form).getByLabelText("Name 1: rate max");
    expect(
      document.getElementById(
        unnamed.getAttribute("aria-describedby")?.split(" ")[0] ?? "",
      )?.textContent,
    ).toContain("jobs with this name");
    type(within(form).getByLabelText("Name 1"), "send");
    const sendRate = within(form).getByLabelText("send: rate max");
    const rateHint =
      document.getElementById(
        sendRate.getAttribute("aria-describedby")?.split(" ")[0] ?? "",
      )?.textContent ?? "";
    expect(rateHint).toContain("jobs named “send”");
    const nameInput = within(form).getByLabelText("Name 1");
    const nameHint =
      document.getElementById(
        nameInput.getAttribute("aria-describedby")?.split(" ")[0] ?? "",
      )?.textContent ?? "";
    expect(nameHint).toContain("on top of the queue's own");
    expect(nameHint).toContain("skipped, not waited behind");
  });

  it("removes every limit with PUT null after a confirmation", async () => {
    const { calls } = renderQueue({
      handlers: { "PUT /queues/emails/limits": { body: null } },
    });
    const form = await limitsForm();
    fireEvent.click(
      within(form).getByRole("button", { name: "Remove all limits…" }),
    );
    const dialog = await findDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove limits" }),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Removed the limits of emails",
      ),
    );
    expect(callsTo(calls, "PUT", "/queues/emails/limits")[0]!.body).toBe(
      "null",
    );
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("shows VALIDATION issues on their fields", async () => {
    renderQueue({
      handlers: {
        "PUT /queues/emails/limits": {
          status: 400,
          body: problem(400, "VALIDATION", "Invalid request", {
            issues: [
              { target: "body", path: "concurrency", message: "must be >= 1" },
              {
                target: "body",
                path: "names.send.rate.duration",
                message: "not a duration",
              },
            ],
          }),
        },
      },
    });
    const form = await limitsForm();
    fireEvent.click(within(form).getByRole("button", { name: "Add a name" }));
    type(within(form).getByLabelText("Name 1"), "send");
    type(within(form).getByLabelText("send: rate max"), "1");
    type(within(form).getByLabelText("send: rate window"), "soon");
    fireEvent.click(within(form).getByRole("button", { name: "Save limits" }));
    await within(form).findByText("must be >= 1");
    expect(within(form).getByText("not a duration")).toBeTruthy();
    expect(
      within(form)
        .getByLabelText("Queue: concurrency")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(
      within(form)
        .getByLabelText("send: rate window")
        .getAttribute("aria-invalid"),
    ).toBe("true");
    // Field issues are not repeated in a banner.
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("offers a retry on LIMITS_CONTENDED", async () => {
    let attempts = 0;
    const { calls } = renderQueue({
      handlers: {
        "PUT /queues/emails/limits": () => {
          attempts += 1;
          return attempts === 1
            ? {
                status: 409,
                body: problem(409, "LIMITS_CONTENDED", "Limits contended"),
              }
            : { body: { concurrency: 4 } };
        },
      },
    });
    const form = await limitsForm();
    fireEvent.click(within(form).getByRole("button", { name: "Save limits" }));
    const banner = await within(form).findByRole("alert");
    expect(banner.textContent).toContain("Retry to save again");
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(callsTo(calls, "PUT", "/queues/emails/limits")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Saved the limits of emails",
      ),
    );
  });

  it("is a read-only summary without queues.limits", async () => {
    renderQueue({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.limits": false }),
        },
      },
    });
    await panelTabs();
    const panel = await page().findByRole("tabpanel");
    await within(panel).findByText("Queue");
    expect(panel.textContent).toContain("10 per 1m");
    expect(panel.textContent).toContain("4 at once");
    expect(
      within(panel).queryByRole("button", { name: "Save limits" }),
    ).toBeNull();
  });
});

describe("the other panels", () => {
  it("lists workers with host, pid and heartbeat", async () => {
    renderQueue();
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    const row = await page().findByTestId("worker-row-w-1");
    expect(row.textContent).toContain("box-1");
    expect(row.textContent).toContain("4242");
    expect(row.textContent).toContain("2 / 4");
    expect(row.querySelectorAll("time")).toHaveLength(2);
    expect(new URLSearchParams(window.location.search).get("panel")).toBe(
      "workers",
    );
  });

  it("keeps the Memory column out of the panel, though the worker reports it", async () => {
    renderQueue();
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    const row = await page().findByTestId("worker-row-w-1");
    const table = row.closest("table")!;
    // The panel is a narrow control surface: it does not ask for the column,
    // so the reported `rssBytes` is simply not shown here.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).not.toContain("Memory");
    expect(table.textContent).not.toContain("MiB");
    // The heartbeat's round trip is a tooltip, not a column, so it is here.
    expect(row.querySelectorAll("time")[1]!.getAttribute("title")).toContain(
      "Last write took 12 ms",
    );
  });

  it("says nothing about housekeeping when no worker reports it", async () => {
    // The fixture worker predates `sweeps`. Absent is not `false`: it has
    // said nothing, and warning here would light up every fleet whose
    // workers have not been upgraded yet.
    renderQueue();
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    await page().findByTestId("worker-row-w-1");
    expect(page().queryByTestId("sweep-warning")).toBeNull();
  });

  it("warns when every live worker reports that it does not sweep", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/workers": {
          body: {
            items: [{ ...workersFixture.items[0]!, sweeps: false }],
          },
        },
      },
    });
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    const note = await page().findByTestId("sweep-warning");
    expect(note.dataset.uncertain).toBe("false");
    expect(note.textContent).toContain(
      "No live worker on this queue runs housekeeping",
    );
    // Untidy, not stuck: it must not read as "this queue is broken".
    expect(note.textContent).toContain("Jobs still run");
    expect(note.textContent).toContain("expired results");
  });

  it("says it may be nobody when some live workers are too old to say", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/workers": {
          body: {
            items: [
              { ...workersFixture.items[0]!, id: "w-1", sweeps: false },
              { ...workersFixture.items[0]!, id: "w-2" },
            ],
          },
        },
      },
    });
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    const note = await page().findByTestId("sweep-warning");
    expect(note.dataset.uncertain).toBe("true");
    expect(note.textContent).toContain("there may be nobody doing it");
  });

  it("says nothing when one live worker reports that it does sweep", async () => {
    renderQueue({
      handlers: {
        "GET /queues/emails/workers": {
          body: {
            items: [
              { ...workersFixture.items[0]!, id: "w-1", sweeps: false },
              { ...workersFixture.items[0]!, id: "w-2", sweeps: true },
            ],
          },
        },
      },
    });
    fireEvent.click(
      within(await panelTabs()).getByRole("tab", { name: "Workers" }),
    );
    await page().findByTestId("worker-row-w-2");
    expect(page().queryByTestId("sweep-warning")).toBeNull();
  });

  it("charts throughput with a window select and an accessible table", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?panel=throughput",
      handlers: {
        "GET /queues/emails/throughput": { body: throughputFixture() },
      },
    });
    await panelTabs();
    const chart = await page().findByRole("img", {
      name: /42 completed, 1 failed/,
    });
    expect(chart.querySelectorAll("rect.bar-completed")).toHaveLength(3);
    expect(chart.querySelectorAll("rect.bar-failed")).toHaveLength(1);
    const table = page().getByRole("table", { name: /jobs per minute/ });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(
      callsTo(calls, "GET", "/queues/emails/throughput")
        .at(-1)!
        .query.get("minutes"),
    ).toBe("60");
    fireEvent.change(page().getByLabelText("Window"), {
      target: { value: "360" },
    });
    await waitFor(() =>
      expect(
        callsTo(calls, "GET", "/queues/emails/throughput")
          .at(-1)!
          .query.get("minutes"),
      ).toBe("360"),
    );
    expect(new URLSearchParams(window.location.search).get("window")).toBe(
      "360",
    );
  });

  it("lists repeatables with their data and removes one after a confirmation", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "DELETE /queues/emails/repeatables/digest%3Acron": { status: 204 },
      },
    });
    const row = await page().findByTestId("repeatable-row-digest:cron");
    expect(row.textContent).toContain("0 9 * * * (Europe/London)");
    expect(row.textContent).toContain("4");
    expect(
      within(row).getByRole("button", { name: /Data of digest:cron/ }),
    ).toBeTruthy();
    expect(
      callsTo(calls, "GET", "/queues/emails/repeatables")[0]!.query.getAll(
        "include",
      ),
    ).toEqual(["data"]);
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Remove repeatable digest:cron",
      }),
    );
    const dialog = await findDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Removed the repeat series digest:cron",
      ),
    );
    const call = callsTo(
      calls,
      "DELETE",
      "/queues/emails/repeatables/digest%3Acron",
    )[0]!;
    expect(call.url).toContain("/repeatables/digest%3Acron");
  });

  it("shows every panel the backend and the caller allow", async () => {
    renderQueue();
    expect(await panelLabels()).toEqual([
      "Limits",
      "Job defaults",
      "Workers",
      "Throughput",
      "Repeatables",
    ]);
  });

  it("drops the limits panel when the feature is off or the detail has no limits key", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, limits: false },
          }),
        },
      },
    });
    expect(await panelLabels()).toEqual([
      "Job defaults",
      "Workers",
      "Throughput",
      "Repeatables",
    ]);
  });

  it("drops the limits panel when the backend cannot store limits", async () => {
    const { limits: _limits, ...detail } = detailFixture();
    renderQueue({ handlers: { "GET /queues/emails": { body: detail } } });
    await waitFor(async () =>
      expect(await panelLabels()).toEqual([
        "Job defaults",
        "Workers",
        "Throughput",
        "Repeatables",
      ]),
    );
  });

  it("drops workers and throughput without the feature or the permission", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, workers: false },
          }),
        },
        "GET /meta/permissions": {
          body: permissionsFixture({ "metrics.read": false }),
        },
      },
    });
    expect(await panelLabels()).toEqual([
      "Limits",
      "Job defaults",
      "Repeatables",
    ]);
  });

  it("drops throughput without the feature, and repeatables without repeatables.list", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, throughput: false },
          }),
        },
        "GET /meta/permissions": {
          body: permissionsFixture({
            "repeatables.list": false,
            "workers.list": false,
          }),
        },
      },
    });
    expect(await panelLabels()).toEqual(["Limits", "Job defaults"]);
  });

  it("renders no panels at all when none is allowed", async () => {
    renderQueue({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: {
              ...metaFixture().features,
              limits: false,
              workers: false,
              throughput: false,
              jobDefaults: false,
            },
          }),
        },
        "GET /meta/permissions": {
          body: permissionsFixture({ "repeatables.list": false }),
        },
      },
    });
    expect(await panelLabels()).toEqual([]);
    expect(page().queryByText("Details")).toBeNull();
  });
});

describe("repeatables, disable and enable", () => {
  /** The fixture list with the series disabled, and nothing scheduled. */
  function disabledList() {
    return {
      items: [
        {
          ...repeatablesFixture.items[0]!,
          disabled: true,
          nextRunAt: null,
          nextJobId: null,
        },
      ],
    };
  }

  /** Opens the repeatables panel and returns the fixture series' row. */
  async function row() {
    return page().findByTestId("repeatable-row-digest:cron");
  }

  it("offers Disable on an enabled series, POSTs it, toasts and refetches the list", async () => {
    let disabled = false;
    const { calls } = renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "GET /queues/emails/repeatables": () => ({
          body: disabled ? disabledList() : repeatablesFixture,
        }),
        "POST /queues/emails/repeatables/digest%3Acron/disable": () => {
          disabled = true;
          return { body: { disabled: true } };
        },
      },
    });
    const enabledRow = await row();
    expect(within(enabledRow).queryByText("Disabled")).toBeNull();
    expect(
      within(enabledRow).queryByRole("button", {
        name: "Enable repeatable digest:cron",
      }),
    ).toBeNull();
    const reads = callsTo(calls, "GET", "/queues/emails/repeatables").length;
    fireEvent.click(
      within(enabledRow).getByRole("button", {
        name: "Disable repeatable digest:cron",
      }),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Disabled the repeat series digest:cron",
      ),
    );
    const call = callsTo(
      calls,
      "POST",
      "/queues/emails/repeatables/digest%3Acron/disable",
    )[0]!;
    expect(call.body).toBeUndefined();
    await waitFor(() =>
      expect(
        callsTo(calls, "GET", "/queues/emails/repeatables").length,
      ).toBeGreaterThan(reads),
    );
    await waitFor(async () =>
      expect(within(await row()).getByText("Disabled")).toBeTruthy(),
    );
    expect(page().getByTestId("repeatable-next-digest:cron").textContent).toBe(
      "paused (disabled)",
    );
    expect(
      within(await row()).getByRole("button", {
        name: "Enable repeatable digest:cron",
      }),
    ).toBeTruthy();
  });

  it("shows a disabled series with its badge, a paused next run and Enable, and POSTs enable", async () => {
    const { calls } = renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "GET /queues/emails/repeatables": { body: disabledList() },
        "POST /queues/emails/repeatables/digest%3Acron/enable": {
          body: { enabled: true },
        },
      },
    });
    const disabledRow = await row();
    expect(within(disabledRow).getByText("Disabled")).toBeTruthy();
    expect(page().getByTestId("repeatable-next-digest:cron").textContent).toBe(
      "paused (disabled)",
    );
    expect(
      within(disabledRow).queryByRole("button", {
        name: "Disable repeatable digest:cron",
      }),
    ).toBeNull();
    fireEvent.click(
      within(disabledRow).getByRole("button", {
        name: "Enable repeatable digest:cron",
      }),
    );
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Enabled the repeat series digest:cron",
      ),
    );
    expect(
      callsTo(calls, "POST", "/queues/emails/repeatables/digest%3Acron/enable"),
    ).toHaveLength(1);
  });

  it("explains a 404 REPEATABLE_NOT_FOUND", async () => {
    renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "POST /queues/emails/repeatables/digest%3Acron/disable": {
          status: 404,
          body: problem(404, "REPEATABLE_NOT_FOUND", "Repeatable not found", {
            context: { queue: "emails", key: "digest:cron" },
          }),
        },
      },
    });
    fireEvent.click(
      within(await row()).getByRole("button", {
        name: "Disable repeatable digest:cron",
      }),
    );
    await waitFor(() =>
      expect(errorToasts().textContent).toContain(
        "The repeat series “digest:cron” no longer exists",
      ),
    );
    expect(errorToasts().textContent).toContain(
      "Could not change the repeat series",
    );
  });

  it("drops Disable without repeatables.disable, and Enable without repeatables.enable", async () => {
    renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "repeatables.disable": false }),
        },
      },
    });
    const enabledRow = await row();
    // The per-queue answer can arrive after the row; wait for it to settle.
    await waitFor(() =>
      expect(
        within(enabledRow).queryByRole("button", {
          name: "Disable repeatable digest:cron",
        }),
      ).toBeNull(),
    );
    expect(
      within(enabledRow).getByRole("button", {
        name: "Remove repeatable digest:cron",
      }),
    ).toBeTruthy();
  });

  it("drops Enable without repeatables.enable", async () => {
    renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({
            "repeatables.enable": false,
            "repeatables.remove": false,
          }),
        },
        "GET /queues/emails/repeatables": { body: disabledList() },
      },
    });
    const disabledRow = await row();
    await waitFor(() =>
      expect(
        within(disabledRow).queryAllByRole("button", { name: /repeatable/ }),
      ).toHaveLength(0),
    );
    // The badge is not an action: it shows whatever the caller may do.
    expect(within(disabledRow).getByText("Disabled")).toBeTruthy();
    // No actions at all, so no actions column.
    expect(
      page()
        .getByRole("table", { name: "Repeatables of emails" })
        .querySelectorAll("thead th"),
    ).toHaveLength(6);
  });

  it("offers neither when the API is read-only, but still shows the badge", async () => {
    renderQueue({
      path: "/queues/emails?panel=repeatables",
      handlers: {
        "GET /meta": {
          body: metaFixture({ readOnly: true, addableNames: null }),
        },
        "GET /queues/emails/repeatables": { body: disabledList() },
      },
    });
    const disabledRow = await row();
    expect(within(disabledRow).getByText("Disabled")).toBeTruthy();
    expect(
      within(disabledRow).queryAllByRole("button", { name: /repeatable/ }),
    ).toHaveLength(0);
  });
});
