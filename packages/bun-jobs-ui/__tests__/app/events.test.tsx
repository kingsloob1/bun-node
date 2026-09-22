import type { MetaDto } from "../../app/api/types";
import {
  QUEUE_EVENT_TYPES,
  RUNNER_EVENT_TYPES,
  WORKER_EVENT_TYPES,
} from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import {
  channelName,
  defaultChoice,
  MAX_PAUSED,
  MAX_ROWS,
  parseChannel,
  parseTypes,
  prependRows,
  readTypes,
  scopesFor,
  typesFor,
} from "../../app/screens/events/eventLog";
import { act, fireEvent, page, setupDom, visit, waitFor, within } from "./dom";
import { metaFixture, queueListFixture } from "./fixtures";
import {
  installLiveFake,
  queueEvent,
  runnerEvent,
  workerEvent,
} from "./liveFake";
import { renderApp } from "./renderApp";
import { runnerListFixture } from "./runners/fixtures";

setupDom();
const live = installLiveFake({
  state: "live",
  events: "push",
  publishing: true,
});

/** Renders the app on `/events` (plus a query string). */
async function renderEvents(query = "", meta?: Partial<MetaDto>) {
  visit(`/jobs/events${query}`);
  const result = renderApp({
    handlers: {
      "GET /meta": { body: metaFixture(meta) },
      "GET /queues": { body: queueListFixture() },
      "GET /runners": { body: runnerListFixture() },
    },
  });
  await page().findByTestId("events-screen");
  await waitFor(() => expect(live.activeSubscriptions()).toHaveLength(1));
  return result;
}

/** The console's one subscription, as `{ channels, events }`. */
function subscription() {
  const [entry] = live.activeSubscriptions();
  return { channels: entry?.channels, events: entry?.events };
}

/** The rendered rows. */
function rows(): HTMLElement[] {
  return page().queryAllByTestId("event-row");
}

/** The URL's query parameters. */
function url(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Emits events inside one `act`. */
async function emit(...events: Parameters<typeof live.emit>[0][]) {
  await act(async () => {
    for (const event of events) {
      live.emit(event);
    }
  });
}

/** A `completed` event for job `id` of `emails`. */
function completed(id: string) {
  return queueEvent({
    type: "completed",
    target: "emails",
    id,
    payload: { id, returnValue: { ok: true } },
  });
}

/** `count` completed events, ids `<prefix>-0` upwards. */
function completedMany(prefix: string, count: number) {
  const events = [];
  for (let index = 0; index < count; index++) {
    events.push(completed(`${prefix}-${index}`));
  }
  return events;
}

/** Waits for a target field to become a select (its list has loaded). */
async function targetSelect(label: string): Promise<HTMLSelectElement> {
  let found: HTMLSelectElement | null = null;
  await waitFor(() => {
    const element = page().getByLabelText(label);
    if (!(element instanceof HTMLSelectElement)) {
      throw new TypeError(`${label} is not a select yet`);
    }
    found = element;
  });
  return found!;
}

/** Picks a scope in the channel select. */
function pickScope(label: string) {
  const select = page().getByLabelText("Channel", {
    selector: "select",
  }) as HTMLSelectElement;
  const option = [...select.options].find((item) => item.text === label)!;
  fireEvent.change(select, { target: { value: option.value } });
}

describe("eventLog", () => {
  it("offers the scopes each mode has", () => {
    expect(scopesFor("both")).toEqual([
      "all",
      "queues",
      "queue",
      "job",
      "workers",
      "queueWorkers",
      "runners",
      "runner",
    ]);
    expect(scopesFor("jobs")).toEqual([
      "queues",
      "queue",
      "job",
      "workers",
      "queueWorkers",
    ]);
    expect(scopesFor("runner")).toEqual(["runners", "runner"]);
    expect(channelName(defaultChoice("both"))).toBe("all");
    expect(channelName(defaultChoice("jobs"))).toBe("queues");
    expect(channelName(defaultChoice("runner"))).toBe("runners");
  });

  it("reads the worker channels back, and offers them only where queues exist", () => {
    // Worker events are off `all` and `queues`, so these are their own
    // channels; the one-queue pattern must not swallow `queue/x/workers`.
    expect(parseChannel("workers", "both")).toEqual({ scope: "workers" });
    expect(parseChannel("queue/emails/workers", "jobs")).toEqual({
      scope: "queueWorkers",
      queue: "emails",
    });
    expect(channelName({ scope: "queueWorkers", queue: "emails" })).toBe(
      "queue/emails/workers",
    );
    expect(parseChannel("workers", "runner")).toBeNull();
    expect(typesFor({ scope: "workers" })).toEqual(WORKER_EVENT_TYPES);
  });

  it("reads channels back, job ids decoded, and refuses what the mode lacks", () => {
    expect(parseChannel("queue/emails", "both")).toEqual({
      scope: "queue",
      queue: "emails",
    });
    expect(parseChannel("queue/emails/job/a%2Fb%20c", "jobs")).toEqual({
      scope: "job",
      queue: "emails",
      id: "a/b c",
    });
    expect(parseChannel("queue/emails/job/%uD800x", "jobs")).toEqual({
      scope: "job",
      queue: "emails",
      id: "\uD800x",
    });
    expect(parseChannel("runner/nightly", "runner")).toEqual({
      scope: "runner",
      runner: "nightly",
    });
    expect(parseChannel("runner/nightly", "jobs")).toBeNull();
    expect(parseChannel("all", "jobs")).toBeNull();
    expect(parseChannel("queue/a/b", "both")).toBeNull();
    expect(parseChannel("queue/emails/job/%E0%A4%A", "both")).toBeNull();
    expect(parseChannel(null, "both")).toBeNull();
    const job = { scope: "job", queue: "emails", id: "a/b c" } as const;
    expect(parseChannel(channelName(job), "both")).toEqual(job);
  });

  it("filters types to the channel's family", () => {
    expect(typesFor({ scope: "queue", queue: "q" })).toEqual(QUEUE_EVENT_TYPES);
    expect(typesFor({ scope: "runners" })).toEqual(RUNNER_EVENT_TYPES);
    expect(
      parseTypes("started,completed,bogus", typesFor({ scope: "all" })),
    ).toEqual(["completed", "started"]);
    expect(parseTypes("started,completed", QUEUE_EVENT_TYPES)).toEqual([
      "completed",
    ]);
    expect(parseTypes(null, QUEUE_EVENT_TYPES)).toEqual([]);
  });

  it("reads types bare or family-prefixed, reports what it ignores, and normalises to bare names", () => {
    expect(
      readTypes(
        "queue.completed,runner.started,completed,bogus,queue.started",
        typesFor({ scope: "all" }),
      ),
    ).toEqual({
      types: ["completed", "started"],
      ignored: [
        { name: "bogus", reason: "unknown" },
        { name: "queue.started", reason: "unknown" },
      ],
      normalized: "completed,started,bogus,queue.started",
    });
    // A family the channel does not carry: ignored, with why.
    expect(readTypes("runner.failed,queue.failed", QUEUE_EVENT_TYPES)).toEqual({
      types: ["failed"],
      ignored: [{ name: "runner.failed", reason: "channel" }],
      normalized: "failed,runner.failed",
    });
    expect(readTypes("started", QUEUE_EVENT_TYPES).ignored).toEqual([
      { name: "started", reason: "channel" },
    ]);
    expect(readTypes(null, QUEUE_EVENT_TYPES)).toEqual({
      types: [],
      ignored: [],
      normalized: null,
    });
    expect(parseTypes("queue.completed", QUEUE_EVENT_TYPES)).toEqual([
      "completed",
    ]);
  });

  it("keeps the newest rows, up to the cap", () => {
    const row = (key: number) =>
      ({
        key,
        kind: "gap",
        receivedAt: 0,
        gap: {
          type: "gap",
          epoch: "e",
          fromSeq: 0,
          toSeq: 0,
          reason: "coalesced",
        },
      }) as const;
    const first = prependRows([], [row(1), row(2)]);
    expect(first.map((item) => item.key)).toEqual([2, 1]);
    const capped = prependRows(first, [row(3), row(4)], 3);
    expect(capped.map((item) => item.key)).toEqual([4, 3, 2]);
  });
});

describe("the Events console", () => {
  it("subscribes to `all` in mode both, and shows events newest first with links", async () => {
    await renderEvents();
    expect(subscription()).toEqual({ channels: ["all"], events: undefined });
    expect(page().getByTestId("events-channel").textContent).toBe("all");

    await emit(
      completed("a/1"),
      runnerEvent({
        type: "started",
        target: "nightly",
        id: "run-7",
        payload: { runId: "run-7" },
      }),
    );
    const [runner, queue] = rows();
    expect(runner!.dataset.type).toBe("started");
    expect(runner!.textContent).toContain("runner");
    expect(
      within(runner!)
        .getByRole("link", { name: "nightly" })
        .getAttribute("href"),
    ).toBe("/jobs/runners/nightly");
    expect(runner!.textContent).toContain("run-7");

    expect(queue!.textContent).toContain("queue");
    expect(queue!.textContent).toContain("completed");
    expect(
      within(queue!).getByRole("link", { name: "emails" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails");
    expect(
      within(queue!).getByRole("link", { name: "a/1" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails/jobs/a%2F1");
    expect(
      queue!.querySelector('[aria-label^="Payload of completed"]'),
    ).toBeTruthy();
    expect(queue!.querySelector("time")!.getAttribute("dateTime")).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
  });

  it("links a worker event's target to its queue, under a kind badge of its own", async () => {
    await renderEvents("?channel=workers");
    expect(subscription().channels).toEqual(["workers"]);
    await emit(
      workerEvent({
        type: "state",
        target: "mail",
        id: "api.mail.4f2a",
        payload: {
          worker: "api.mail.4f2a",
          key: "api.mail",
          state: "paused",
          previous: "running",
          at: Date.now(),
        },
      }),
    );
    const [worker] = rows();
    expect(worker!.dataset.type).toBe("state");
    // A worker event's target is the QUEUE the worker consumes.
    expect(
      within(worker!).getByRole("link", { name: "mail" }).getAttribute("href"),
    ).toBe("/jobs/queues/mail");
    const kind = worker!.querySelector(".events-kind .badge")!;
    expect(kind.textContent).toBe("worker");
    // Its own tone: neither the queue's (info) nor the runner's (accent).
    expect(kind.className).toContain("badge-neutral");
    expect(kind.className).not.toContain("badge-accent");
    expect(kind.className).not.toContain("badge-info");
    expect(worker!.textContent).toContain("api.mail.4f2a");
  });

  it("opens on `queues` in mode jobs", async () => {
    await renderEvents("", { mode: "jobs" });
    expect(subscription().channels).toEqual(["queues"]);
  });

  it("reads the channel and types from the URL, dropping what does not fit", async () => {
    await renderEvents("?channel=runner/nightly&types=started,completed,bogus");
    expect(subscription()).toEqual({
      channels: ["runner/nightly"],
      events: ["started"],
    });
    expect(page().getByTestId("events-types-summary").textContent).toBe(
      "Types: started",
    );
    expect(page().getByTestId("events-types-ignored").textContent).toBe(
      "Ignored in the link's types: completed (runner/nightly does not carry it); bogus (not an event type).",
    );
  });

  it("accepts prefixed types in the URL and rewrites them bare", async () => {
    await renderEvents("?channel=queues&types=queue.completed,failed");
    await waitFor(() => expect(url().get("types")).toBe("completed,failed"));
    expect(subscription().events).toEqual(["completed", "failed"]);
    expect(page().getByTestId("events-types-summary").textContent).toBe(
      "Types: completed, failed",
    );
    expect(page().queryByTestId("events-types-ignored")).toBeNull();
  });

  it("notes unknown types instead of silently showing every type", async () => {
    await renderEvents("?channel=queues&types=bogus,runner.started");
    const note = await page().findByTestId("events-types-ignored");
    expect(note.textContent).toBe(
      "Ignored in the link's types: bogus (not an event type); runner.started (queues does not carry it). Showing every type.",
    );
    expect(subscription().events).toBeUndefined();
    // The names stay in the URL, so a reload shows the same note.
    expect(url().get("types")).toBe("bogus,runner.started");

    // Choosing a type from the filter replaces them.
    fireEvent.click(page().getByLabelText("completed"));
    await waitFor(() => expect(url().get("types")).toBe("completed"));
    expect(page().queryByTestId("events-types-ignored")).toBeNull();
  });

  it("falls back to the default channel for one the mode lacks", async () => {
    await renderEvents("?channel=runner/nightly", { mode: "jobs" });
    expect(subscription().channels).toEqual(["queues"]);
  });

  it("filters by type through the URL, and also drops other types it is handed", async () => {
    await renderEvents("?channel=queues");
    fireEvent.click(page().getByLabelText("failed"));
    fireEvent.click(page().getByLabelText("completed"));
    await waitFor(() => expect(url().get("types")).toBe("completed,failed"));
    expect(subscription().events).toEqual(["completed", "failed"]);

    // A wider filter held by another screen on the same channel reaches the
    // callback too: the console filters again.
    await act(async () => {
      live.activeSubscriptions()[0]!.onEvent!(
        queueEvent({ type: "progress", target: "emails", id: "x" }),
      );
    });
    expect(rows()).toHaveLength(0);
    await emit(completed("1"));
    expect(rows()).toHaveLength(1);

    fireEvent.click(page().getByRole("button", { name: "All types" }));
    await waitFor(() => expect(url().get("types")).toBeNull());
    expect(subscription().events).toBeUndefined();
  });

  it("picks a queue from the queue list", async () => {
    await renderEvents("?types=completed,started");
    pickScope("One queue");
    const queue = await targetSelect("Queue");
    expect([...queue.options].map((option) => option.value)).toEqual([
      "",
      "emails",
      "reports",
    ]);
    const watch = page().getByRole("button", { name: "Watch" });
    expect((watch as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(queue, { target: { value: "reports" } });
    fireEvent.click(watch);
    await waitFor(() => expect(url().get("channel")).toBe("queue/reports"));
    // `started` is a runner event: a queue channel cannot carry it.
    expect(url().get("types")).toBe("completed");
    expect(subscription()).toEqual({
      channels: ["queue/reports"],
      events: ["completed"],
    });
  });

  it("picks a job channel by queue and id, encoding the id", async () => {
    await renderEvents();
    pickScope("One job");
    const queue = await targetSelect("Queue");
    fireEvent.change(queue, { target: { value: "emails" } });
    fireEvent.change(page().getByLabelText("Job id"), {
      target: { value: "a/b c" },
    });
    fireEvent.click(page().getByRole("button", { name: "Watch" }));
    await waitFor(() =>
      expect(subscription().channels).toEqual(["queue/emails/job/a%2Fb%20c"]),
    );
    expect(url().get("channel")).toBe("queue/emails/job/a%2Fb%20c");
  });

  it("picks a runner from the runner list, and a broad scope at once", async () => {
    await renderEvents();
    pickScope("One runner");
    const runner = await targetSelect("Runner");
    fireEvent.change(runner, { target: { value: "sync" } });
    fireEvent.click(page().getByRole("button", { name: "Watch" }));
    await waitFor(() =>
      expect(subscription().channels).toEqual(["runner/sync"]),
    );

    pickScope("Every queue (queues)");
    await waitFor(() => expect(subscription().channels).toEqual(["queues"]));
    expect(url().get("channel")).toBe("queues");
  });

  it("keeps at most the latest 500 rows", async () => {
    await renderEvents();
    await emit(...completedMany("j", MAX_ROWS + 5));
    const shown = rows();
    expect(shown).toHaveLength(MAX_ROWS);
    expect(shown[0]!.textContent).toContain(`j-${MAX_ROWS + 4}`);
    expect(shown.at(-1)!.textContent).toContain("j-5");
    expect(page().getByTestId("events-count").textContent).toContain(
      "500 rows",
    );
  });

  it("pauses the display, holding what arrives, and resumes in order", async () => {
    await renderEvents();
    await emit(completed("before"));
    const pause = page().getByRole("button", { name: "Pause" });
    fireEvent.click(pause);
    // The same button now offers the opposite, by its label alone.
    expect(pause.textContent).toBe("Resume");
    expect(pause.hasAttribute("aria-pressed")).toBe(false);
    await emit(completed("p1"), completed("p2"));
    expect(rows()).toHaveLength(1);
    expect(page().getByTestId("events-held").textContent).toBe("2 held");

    fireEvent.click(page().getByRole("button", { name: "Resume" }));
    const shown = rows().map(
      (row) => row.querySelector(".events-id")!.textContent,
    );
    expect(shown).toEqual(["p2", "p1", "before"]);
    expect(page().queryByTestId("events-held")).toBeNull();
  });

  it("caps what a pause holds, counting the rest as dropped", async () => {
    await renderEvents();
    fireEvent.click(page().getByRole("button", { name: "Pause" }));
    await emit(...completedMany("h", MAX_PAUSED + 3));
    expect(page().getByTestId("events-held").textContent).toBe(
      `${MAX_PAUSED} held, 3 dropped`,
    );
    fireEvent.click(page().getByRole("button", { name: "Resume" }));
    expect(rows()).toHaveLength(MAX_PAUSED);
    expect(rows()[0]!.textContent).toContain(`h-${MAX_PAUSED - 1}`);
  });

  it("clears the log", async () => {
    await renderEvents();
    await emit(completed("1"), completed("2"));
    expect(rows()).toHaveLength(2);
    fireEvent.click(page().getByRole("button", { name: "Clear" }));
    expect(rows()).toHaveLength(0);
    expect(page().getByText("Waiting for events")).toBeTruthy();
  });

  it("shows a gap inline", async () => {
    await renderEvents();
    await emit(completed("1"));
    await act(async () =>
      live.gap({
        type: "gap",
        epoch: "e",
        fromSeq: 10,
        toSeq: 42,
        reason: "slow-consumer",
        channels: ["all"],
      }),
    );
    const [gap] = rows();
    expect(gap!.dataset.type).toBe("gap");
    expect(gap!.textContent).toContain("gap: slow-consumer");
    expect(gap!.textContent).toContain("events 10–42 may be missing on all");
  });

  it("leaves out the range of a gap that covers no sequenced event", async () => {
    await renderEvents("?channel=workers");
    // `queue-discovered` arrives before any sequenced event on the
    // connection, so its range is 0–0 and saying "events 0–0" reads as a
    // range of nothing.
    await act(async () =>
      live.gap({
        type: "gap",
        epoch: "e",
        fromSeq: 0,
        toSeq: 0,
        reason: "queue-discovered",
        channels: ["workers"],
      }),
    );
    const [gap] = rows();
    expect(gap!.textContent).toContain("gap: queue-discovered");
    expect(gap!.textContent).toContain("events may be missing on workers");
    expect(gap!.textContent).not.toContain("0–0");
  });

  it("shows the server's rejection of a channel, with the reason", async () => {
    await renderEvents("?channel=queue/secret");
    await act(async () =>
      live.reject({
        channel: "queue/secret",
        code: "FORBIDDEN",
        status: 403,
        detail: "not yours",
      }),
    );
    const alert = await page().findByTestId("events-rejected");
    expect(alert.textContent).toBe(
      "The server refused queue/secret: FORBIDDEN (not yours)",
    );
  });

  it("explains an empty log when producers do not publish", async () => {
    live.install({ state: "live", events: "push", publishing: false });
    await renderEvents();
    expect(
      page().getByText("Producers are not publishing events"),
    ).toBeTruthy();
  });

  it("explains an empty log when events are only the API's own", async () => {
    live.install({ state: "live", events: "local", publishing: true });
    await renderEvents();
    expect(page().getByText("Only this API process's own events")).toBeTruthy();
  });

  it("explains an empty log when live updates are off", async () => {
    live.install({ state: "refused", detail: "The server refused the socket" });
    await renderEvents();
    expect(page().getByText("Live updates are off")).toBeTruthy();
    expect(page().getByText("The server refused the socket")).toBeTruthy();
  });
});
