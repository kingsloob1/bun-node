import type { WorkerDto } from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { WORKER_CONTROL_WAIT_MS } from "../../../app/api/workers";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { permissionsFixture, problem } from "../fixtures";
import { renderApp } from "../renderApp";
import { configResult, controlResult, workerFixture } from "./fixtures";

setupDom();

/** One write a test made. */
interface Recorded {
  /** Method and path, e.g. `POST /queues/emails/workers/w1/pause`. */
  call: string;
  /** The parsed JSON body, when the request carried one. */
  body?: unknown;
  /** The query, as sent. */
  query: string;
}

/**
 * Opens `/workers` with one worker, and records every write named in
 * `replies`. `grant` adds actions the permissions fixture leaves out (the
 * opt-in `workers.configure`).
 */
async function openWorkers({
  worker = workerFixture(),
  grant = {},
  replies = {},
}: {
  /** The one worker `GET /workers` returns. */
  worker?: WorkerDto;
  /** Extra permissions, over the fixture's. */
  grant?: Parameters<typeof permissionsFixture>[0];
  /** What each write answers, by `"METHOD /path"`. */
  replies?: Record<string, MockReply>;
} = {}) {
  const recorded: Recorded[] = [];
  const handlers: Record<string, MockHandler | MockReply> = {
    "GET /workers": { body: { items: [worker] } },
    "GET /meta/permissions": { body: permissionsFixture(grant) },
  };
  for (const [call, reply] of Object.entries(replies)) {
    handlers[call] = ({ body, query }) => {
      recorded.push({
        call,
        query: query.toString(),
        ...(body === undefined ? {} : { body: JSON.parse(body) }),
      });
      return reply;
    };
  }
  visit("/jobs/workers");
  renderApp({ handlers });
  const row = await page().findByTestId(`worker-row-${worker.id}`);
  return { row, recorded };
}

describe("a worker's lifecycle buttons", () => {
  it("pauses a running worker and says so", async () => {
    const { row, recorded } = await openWorkers({
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/pause": {
          body: controlResult(),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(recorded.map((entry) => entry.call)).toEqual([
        "POST /queues/emails/workers/api.emails.9f3c1d20/pause",
      ]),
    );
    // `wait` is a query parameter, not a body field: in the body it is
    // ignored and every instruction reads as unacknowledged.
    expect(recorded[0]!.query).toBe(`wait=${WORKER_CONTROL_WAIT_MS}`);
    expect(recorded[0]!.body).toBeUndefined();
    expect(await page().findByText(/Paused api\.emails/)).toBeTruthy();
  });

  it("says an unacknowledged instruction was only recorded", async () => {
    const { row } = await openWorkers({
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/pause": {
          status: 202,
          body: controlResult({ applied: false }),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    expect(
      await page().findByText(/Asked api\.emails.* to pause/),
    ).toBeTruthy();
  });

  it("starts a stopped worker, and offers it neither pause nor resume", async () => {
    const { row, recorded } = await openWorkers({
      worker: workerFixture({ state: "stopped", active: 0 }),
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/start": {
          body: controlResult({ desired: "running" }),
        },
      },
    });
    expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(recorded).toHaveLength(1));
  });

  it("explains a refusal in the user's terms", async () => {
    const { row } = await openWorkers({
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/pause": {
          status: 409,
          body: problem(409, "WORKER_STATE_CONFLICT", "Conflict"),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
    expect(
      await page().findByText(/no longer in the state that action needs/),
    ).toBeTruthy();
  });
});

describe("the Stop dialog", () => {
  it("says what stopping does, then stops without a persistence choice", async () => {
    const { row, recorded } = await openWorkers({
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/stop": {
          body: controlResult({ desired: "stopped", persisted: "process" }),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Stop…" }));
    const dialog = await page().findByRole("alertdialog");
    expect(dialog.textContent).toContain("finishes the job it is running");
    expect(dialog.textContent).toContain("A redeploy or a restart brings this");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stop worker" }),
    );
    await waitFor(() => expect(recorded).toHaveLength(1));
    // No choice offered, so no `persist` is sent: the deployment decides.
    expect(recorded[0]!.body).toBeUndefined();
  });

  it("offers both persistences when the deployment allows a choice, and sends it", async () => {
    const worker = workerFixture();
    const { row, recorded } = await openWorkers({
      worker: {
        ...worker,
        control: { ...worker.control!, stopPersistenceOverridable: true },
      },
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/stop": {
          body: controlResult({ desired: "stopped", persisted: "key" }),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Stop…" }));
    const dialog = await page().findByRole("alertdialog");
    fireEvent.change(within(dialog).getByRole("combobox"), {
      target: { value: "key" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stop worker" }),
    );
    await waitFor(() => expect(recorded).toHaveLength(1));
    // The choice travels in the body; the wait stays in the query.
    expect(recorded[0]!.body).toEqual({ persist: "key" });
    expect(recorded[0]!.query).toBe(`wait=${WORKER_CONTROL_WAIT_MS}`);
    expect(
      await page().findByText(/every replica of it stays stopped/),
    ).toBeTruthy();
  });
});

describe("the Stop toast", () => {
  /** The worker as the stop route re-reads it: still draining its job. */
  const stopping = workerFixture({
    state: "stopping",
    active: 1,
    control: { ...workerFixture().control!, pending: true },
  });

  /** Stops the one worker, the route answering `reply`; resolves the toast. */
  async function stopWith(reply: ReturnType<typeof controlResult>) {
    const { row } = await openWorkers({
      replies: {
        "POST /queues/emails/workers/api.emails.9f3c1d20/stop": {
          body: reply,
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Stop…" }));
    const dialog = await page().findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Stop worker" }),
    );
    const toasts = await page().findByRole("list", { name: "Notifications" });
    await waitFor(() => expect(toasts.textContent).not.toBe(""));
    return toasts.textContent ?? "";
  }

  it("says the worker is still stopping when the API reports it draining", async () => {
    // `applied` means the worker ACCEPTED the instruction; the re-read worker
    // says it is still finishing the job it holds.
    const toast = await stopWith(
      controlResult({ desired: "stopped", applied: true, worker: stopping }),
    );
    expect(toast).toContain(
      "Asked api.emails.9f3c1d20 to stop; it finishes its jobs first",
    );
    expect(toast).not.toContain("Stopped");
  });

  it("says the worker is still stopping when only control.pending says so", async () => {
    const toast = await stopWith(
      controlResult({
        desired: "stopped",
        applied: true,
        worker: { ...stopping, state: "running" },
      }),
    );
    expect(toast).toContain("Asked api.emails.9f3c1d20 to stop");
  });

  it("says Stopped for an idle worker whose re-read still reads stopping (a polling driver)", async () => {
    // Measured on the file driver: an IDLE worker's stop answers `applied`,
    // but the re-read was taken before it finished parking — `stopping`,
    // pending — though it holds no job and is stopped a moment later. "It
    // finishes its jobs first" would be false: it has none.
    const toast = await stopWith(
      controlResult({
        desired: "stopped",
        applied: true,
        persisted: "process",
        worker: { ...stopping, active: 0 },
      }),
    );
    expect(toast).toContain("Stopped api.emails.9f3c1d20");
    expect(toast).not.toContain("finishes its jobs");
  });

  it("still says it is finishing its jobs when an unacknowledged idle stop is only recorded", async () => {
    // Not accepted yet (`applied: false`): nothing says it stopped.
    const toast = await stopWith(
      controlResult({
        desired: "stopped",
        applied: false,
        worker: { ...stopping, active: 0 },
      }),
    );
    expect(toast).toContain("Asked api.emails.9f3c1d20 to stop");
  });

  it("says Stopped once the re-read worker is stopped", async () => {
    const toast = await stopWith(
      controlResult({
        desired: "stopped",
        applied: true,
        worker: workerFixture({ state: "stopped", active: 0 }),
      }),
    );
    expect(toast).toContain("Stopped api.emails.9f3c1d20");
    expect(toast).not.toContain("Asked");
  });

  it("keeps the replica note on a key-wide stop still draining", async () => {
    const toast = await stopWith(
      controlResult({
        desired: "stopped",
        applied: true,
        persisted: "key",
        worker: stopping,
      }),
    );
    expect(toast).toContain("Asked api.emails.9f3c1d20 to stop");
    expect(toast).toContain("every replica of it stays stopped until started");
  });
});

describe("a worker between states", () => {
  const stopping = workerFixture({
    state: "stopping",
    control: { ...workerFixture().control!, pending: true },
  });

  it("explains the missing lifecycle actions even while Settings… is offered", async () => {
    const { row } = await openWorkers({
      worker: stopping,
      grant: { "workers.configure": true },
    });
    expect(within(row).getByRole("button", { name: "Settings…" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Stop…" })).toBeNull();
    expect(
      within(row).getByTestId("worker-blocked-api.emails.9f3c1d20").textContent,
    ).toContain("between states");
  });

  it("explains them when nothing at all is offered", async () => {
    const { row } = await openWorkers({ worker: stopping });
    expect(within(row).queryByRole("button")).toBeNull();
    expect(
      within(row).getByTestId("worker-blocked-api.emails.9f3c1d20").textContent,
    ).toContain("between states");
  });

  it("says nothing when the caller may not pause anyway", async () => {
    const { row } = await openWorkers({
      worker: stopping,
      grant: { "workers.configure": true, "workers.pause": false },
    });
    expect(within(row).getByRole("button", { name: "Settings…" })).toBeTruthy();
    expect(
      within(row).queryByTestId("worker-blocked-api.emails.9f3c1d20"),
    ).toBeNull();
  });
});

describe("the Settings dialog", () => {
  it("is absent without the opt-in action", async () => {
    const { row } = await openWorkers();
    expect(within(row).queryByRole("button", { name: "Settings…" })).toBeNull();
  });

  it("sends only what changed, keyed by the stable key, with the seq it read", async () => {
    const { row, recorded } = await openWorkers({
      grant: { "workers.configure": true },
      replies: {
        "PUT /queues/emails/worker-configs/api.emails": {
          body: configResult(),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Settings…" }));
    const dialog = await page().findByRole("dialog");
    expect(dialog.textContent).toContain("reaches every worker carrying");
    // Save is disabled until something differs from what it runs with.
    const save = within(dialog).getByRole("button", { name: "Save settings" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/concurrency/), {
      target: { value: "5" },
    });
    fireEvent.click(save);
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(recorded[0]!.body).toEqual({ concurrency: 5, expectedSeq: 4 });
    expect(
      await page().findByText(/Saved the settings of api\.emails/),
    ).toBeTruthy();
  });

  it("says when a change is still waiting to be taken up", async () => {
    const worker = workerFixture();
    const { row } = await openWorkers({
      grant: { "workers.configure": true },
      worker: {
        ...worker,
        control: { ...worker.control!, pending: true, appliedSeq: 3 },
      },
    });
    expect(row.textContent).toContain("Change pending");
    fireEvent.click(within(row).getByRole("button", { name: "Settings…" }));
    const dialog = await page().findByRole("dialog");
    expect(
      within(dialog).getByTestId("worker-config-pending").textContent,
    ).toContain("still runs with");
  });

  it("shows what the code asks for, and puts a value back", async () => {
    const { row } = await openWorkers({
      grant: { "workers.configure": true },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Settings…" }));
    const dialog = await page().findByRole("dialog");
    // concurrency is overridden to 3 where the code asks for 2.
    expect(dialog.textContent).toContain("Overridden; its code asks for 2");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use code value" }),
    );
    expect(
      (within(dialog).getByLabelText(/concurrency/) as HTMLInputElement).value,
    ).toBe("2");
  });

  it("resets every override, and explains a contended write", async () => {
    const { row, recorded } = await openWorkers({
      grant: { "workers.configure": true },
      replies: {
        "DELETE /queues/emails/worker-configs/api.emails": {
          status: 409,
          body: problem(409, "CONTROL_CONTENDED", "Conflict"),
        },
      },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Settings…" }));
    const dialog = await page().findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset to code values" }),
    );
    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(
      await within(dialog).findByText(/Somebody else changed this worker/),
    ).toBeTruthy();
  });
});
