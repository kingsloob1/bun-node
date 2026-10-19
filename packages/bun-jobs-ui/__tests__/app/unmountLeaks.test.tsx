import type { ReactNode } from "react";
import type { EventWire, JobsApiServerMessage } from "../../app/api/types";
import type { LiveOptions } from "../../app/live";
import type { Handle, TrackedSocket } from "./handleLedger";
import type { MockHandler, MockReply } from "./mockFetch";
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
} from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { StrictMode, use, useEffect } from "react";
import { createApiClient } from "../../app/api/client";
import { RUN_LOG_POLL_MS } from "../../app/api/runnerLogs";
import { App } from "../../app/App";
import { COPY_FEEDBACK_MS } from "../../app/components/copy";
import { TOAST_DURATION_MS } from "../../app/components/toast";
import { UiConfigContext, useApiClient } from "../../app/context";
import { NOW_TICK_MS, sharedClockState } from "../../app/hooks/useNow";
import {
  LIVE_INVALIDATION_DELAY_MS,
  liveChannels,
  LiveContext,
  LiveOptionsContext,
  LiveProvider,
  pollInterval,
} from "../../app/live";
import { MetaContext } from "../../app/meta/hooks";
import { AppProviders } from "../../app/providers";
import { createQueryClient, POLL_INTERVAL_MS } from "../../app/queryClient";
import { JOB_POLL_MS, LOG_POLL_MS } from "../../app/screens/job/polling";
import { QUEUE_REFRESH } from "../../app/screens/queues/live";
import { RUNNER_REFRESH } from "../../app/screens/runners/live";
import { WORKER_REFRESH } from "../../app/screens/workers/live";
import {
  act,
  cleanup,
  fireEvent,
  page,
  render,
  setupDom,
  visit,
  within,
} from "./dom";
import {
  metaFixture,
  permissionsFixture,
  queueListFixture,
  uiConfig,
} from "./fixtures";
import { assertReleased, HandleLedger, nativeSleep } from "./handleLedger";
import { AWKWARD_ID, jobApiPath, jobFixture, jobMeta } from "./job/fixtures";
import { hello } from "./live/fakes";
import { mockFetch } from "./mockFetch";
import { providerFixture, providerList } from "./providers/fixtures";
import {
  jobDefaultsFixture,
  queueHandlers,
  summonStatusFixture,
} from "./queues/fixtures";
import { defaultHandlers } from "./renderApp";
import {
  historyFixture,
  runFixture,
  runnerApiPath,
  runnerHandlers,
  runnerListFixture,
  runnerMeta,
  runningRunnerFixture,
} from "./runners/fixtures";
import { summonListFixtures } from "./summoning/fixtures";
import { instancesFixture } from "./workers/fixtures";

/**
 * Screens leave nothing behind when they unmount: the runtime guard that
 * replaced `@eslint-react`'s dropped `web-api-no-leaked-*` rules (timers,
 * listeners, sockets, observers, fetches without an abort).
 *
 * Each screen case mounts the real app (`<App/>` in `AppProviders`, under
 * `<StrictMode>`) with live updates on, over a {@link HandleLedger} that
 * records every handle opened through the globals. It then:
 *
 * 1. asserts that the screen STARTED — its TanStack polling intervals, its
 *    channels held on the socket, and for a live screen an event received
 *    and the 250 ms coalescing timeout open — so a case that rendered
 *    nothing cannot pass;
 * 2. Phase A: navigates away (to `/docs`, as a link would): the screen's
 *    channels must be released and its timers closed while the app lives on;
 * 3. Phase B: unmounts the whole tree, drains (the order is measured: let
 *    aborted reads settle, clear the cache, settle again) and asserts that no
 *    handle is left, and that the socket closed normally (1000).
 *
 * The negative controls plant one leak of each kind and assert the check
 * names it, so a ledger that stopped recording would fail here, not pass.
 *
 * Every wait inside a case is on a Bun timer the ledger never sees
 * ({@link nativeSleep}), and every one is awaited inside `act`: an
 * un-awaited `act` leaves React's act scope broken, and every later test in
 * the file then records nothing.
 */

setupDom();

/** Prints every handle per test, with `LEAK_DIAG=1`. */
const DIAG = process.env.LEAK_DIAG === "1";

beforeAll(() => {
  // React adds one `selectionchange` listener per document, with its first
  // root, and never removes it. Make it here, before any ledger records.
  render(<div />);
  cleanup();
});

/** The ledger of the running test. */
let ledger: HandleLedger;

beforeEach(() => {
  // Nothing may be mounted from before: a query client's focus and online
  // listeners would be removed by its own unmount, not by ours, and the
  // shared clock would already be running.
  expect(focusManager.hasListeners()).toBe(false);
  expect(onlineManager.hasListeners()).toBe(false);
  expect(sharedClockState()).toEqual({ subscribers: 0, running: false });
  ledger = new HandleLedger();
  ledger.install();
});

afterEach(() => {
  if (DIAG) {
    // eslint-disable-next-line no-console -- the diagnostic is the output
    console.error(
      ledger.handles
        .map(
          (handle) =>
            `${handle.open ? "OPEN " : "     "}${handle.kind} ${handle.detail} ${handle.origin} ${handle.closedBy ?? ""}`,
        )
        .join("\n"),
    );
  }
  ledger.disposeAll();
  ledger.uninstall();
});

/** Live updates on, with no reconnect jitter; the socket is the ledger's (the global `WebSocket`). */
const LIVE_ON: LiveOptions = { random: () => 0 };

/** A read's interval while live updates are on. */
function relaxed(base: number): number {
  return pollInterval(base, true) as number;
}

/** Handlers over the app's defaults. */
type Handlers = Record<string, MockHandler | MockReply>;

/** Options of {@link mount}. */
interface MountOptions {
  /** Calls the API client's fetch keeps pending until aborted. */
  hang?: (url: string) => boolean;
  /** Rendered beside `<App/>`, inside the providers. */
  extra?: ReactNode;
}

/** Renders the real app at `path` under StrictMode, live on, with `handlers` merged over the defaults. */
function mount(
  path: string,
  handlers: Handlers = {},
  options: MountOptions = {},
) {
  visit(`/jobs${path}`);
  const config = uiConfig();
  const mock = mockFetch({ ...defaultHandlers(), ...handlers });
  const client = createApiClient(config, {
    fetch: ledger.trackFetch(mock.fetch, { hang: options.hang }),
  });
  const queryClient = createQueryClient({ retry: false });
  render(
    <StrictMode>
      <LiveOptionsContext value={LIVE_ON}>
        <AppProviders
          config={config}
          client={client}
          queryClient={queryClient}
        >
          <App />
          {options.extra}
        </AppProviders>
      </LiveOptionsContext>
    </StrictMode>,
  );
  return { calls: mock.calls, queryClient };
}

/** Lets fetches answer and React commit, on timers the ledger never records. */
async function flush(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await act(async () => {
      await nativeSleep(10);
    });
  }
}

/** Retries `check` (flushing between tries) until it stops throwing; rethrows its last error after `timeout` ms. */
async function eventually(check: () => void, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
    }
    await flush(1);
  }
}

/** Opens the socket the app created and says hello, then acks its subscribes. */
async function goLive(): Promise<TrackedSocket> {
  await eventually(() => {
    if (ledger.sockets.length === 0) {
      throw new Error("the app opened no socket");
    }
  });
  // StrictMode starts, stops and restarts the client: the last one is live.
  const socket = ledger.sockets.at(-1)!;
  await act(async () => {
    socket.open();
    socket.receive(hello());
  });
  await flush();
  await act(async () => socket.ackAll());
  await flush();
  return socket;
}

/** Acks whatever the client sent since, so later holds subscribe too. */
async function ackAll(socket: TrackedSocket): Promise<void> {
  await act(async () => socket.ackAll());
  await flush(1);
}

/** Phase A: navigates inside the app, as a link or the back button would. */
async function navigate(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState(null, "", `/jobs${path}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await flush();
}

/**
 * Phase B: unmounts everything, drains and asserts nothing is left. The
 * order is measured: an aborted read re-arms its query's gc timer when it
 * settles, even once removed, so the cache is cleared only after the reads
 * settled, and settled again after.
 */
async function unmountAndAssert(
  queryClient: ReturnType<typeof createQueryClient>,
): Promise<void> {
  cleanup();
  await nativeSleep(20);
  // `MutationCache.clear()` drops its mutations without destroying them, so
  // a mutation's gc timer (armed when its observer unsubscribed at unmount)
  // would stay; `QueryCache.clear()` destroys each query. Destroy them first.
  for (const mutation of queryClient.getMutationCache().getAll()) {
    mutation.destroy();
  }
  queryClient.clear();
  await nativeSleep(20);
  ledger.assertNoneOpen();
}

/** The open TanStack intervals of `ms`. */
function polling(ms: number): Handle[] {
  return ledger.opened(
    "interval",
    (handle) =>
      handle.open &&
      handle.origin === "tanstack" &&
      handle.detail === `${ms}ms`,
  );
}

/** The API reads of `path` (under the API base, query aside), open or not. */
function fetched(path: string): Handle[] {
  return ledger.opened("fetch", (handle) => {
    const url = handle.detail.slice(handle.detail.indexOf(" ") + 1);
    return new URL(url, "http://localhost").pathname === `/jobs-api${path}`;
  });
}

/** The shared clock's interval (`useNow`), open. */
function clock(): Handle[] {
  return ledger.opened(
    "interval",
    (handle) =>
      handle.open &&
      handle.detail === `${NOW_TICK_MS}ms` &&
      handle.origin.startsWith("app/hooks/useNow.ts"),
  );
}

/** `useLiveInvalidation`'s coalescing timeouts, open or not. */
function coalescing(): Handle[] {
  return ledger.opened(
    "timeout",
    (handle) =>
      handle.detail === `${LIVE_INVALIDATION_DELAY_MS}ms` &&
      handle.origin.startsWith("app/live/live.ts"),
  );
}

/** Timeouts `file` (under `app/`) opened of `ms`, open or not. */
function timeoutsOf(file: string, ms: number): Handle[] {
  return ledger.opened(
    "timeout",
    (handle) =>
      handle.detail === `${ms}ms` && handle.origin.startsWith(`app/${file}`),
  );
}

/** An `event` frame on `subscriptions`. */
function eventFrame(
  seq: number,
  subscriptions: string[],
  event: Omit<EventWire, "v" | "at">,
): JobsApiServerMessage {
  return {
    type: "event",
    seq,
    epoch: "e1",
    subscriptions,
    event: { v: 1, at: Date.now(), ...event } as EventWire,
  };
}

/** A queue `completed` event for job `id` of `queue`. */
function completed(queue = "emails", id = "1") {
  return {
    kind: "queue",
    type: "completed",
    target: queue,
    id,
    payload: { id, returnValue: null },
  } as Omit<EventWire, "v" | "at">;
}

/** A worker `state` event in `queue`. */
function workerState(queue = "emails") {
  return {
    kind: "worker",
    type: "state",
    target: queue,
    id: "api.emails.a1",
    payload: {},
  } as unknown as Omit<EventWire, "v" | "at">;
}

/** A runner `started` event of `runner`. */
function runnerStarted(runner = "nightly") {
  return {
    kind: "runner",
    type: "started",
    target: runner,
    id: "run-9",
    payload: { runId: "run-9" },
  } as unknown as Omit<EventWire, "v" | "at">;
}

/** One screen case. */
interface ScreenCase {
  /** What it is. */
  name: string;
  /** The app path (under `/jobs`). */
  path: string;
  /** Handlers over the defaults. A function, so time-relative fixtures are taken when the case runs. */
  handlers?: () => Handlers;
  /** The TanStack intervals (ms) open once it started, live on. */
  intervals: number[];
  /** The channels it holds once live. */
  channels: string[];
  /** An event on its channels: it must arm the coalescing timeout (or, with `onEvent`, show). */
  event?: Omit<EventWire, "v" | "at">;
  /** What the event must do instead of arming the coalescing timeout. */
  onEvent?: () => void;
  /** Whether it runs the shared clock (`useNow`, `RelativeTime`). */
  clock?: boolean;
  /** Whether it observes an element (`useInView`). */
  observes?: boolean;
  /** More start steps, once live (opening a log), and more start assertions. */
  start?: (socket: TrackedSocket) => Promise<void>;
}

/** The queue screen's bootstrap, as `renderQueue` answers it. */
function queueRoutes(): Handlers {
  return {
    "GET /meta": { body: metaFixture() },
    "GET /meta/permissions": { body: permissionsFixture() },
    ...queueHandlers(),
  };
}

/** The `emails` queue with its panel `panel` open. */
function panelCase(
  panel: string,
  intervals: number[],
  more: Partial<ScreenCase> = {},
): ScreenCase {
  return {
    name: `Queue panel ${panel}`,
    path: `/queues/emails?panel=${panel}`,
    intervals: [relaxed(QUEUE_REFRESH.counts), ...intervals],
    channels: [liveChannels.queue("emails")],
    event: completed(),
    clock: true,
    ...more,
    handlers: () => ({ ...queueRoutes(), ...more.handlers?.() }),
  };
}

/** A running run of `nightly`, as its history reports it. */
function runningRun() {
  return runFixture({
    status: "running",
    finishedAt: undefined,
    durationMs: undefined,
    result: undefined,
    logLines: 1,
    logsDropped: 0,
  });
}

const CASES: ScreenCase[] = [
  {
    name: "Overview",
    path: "/",
    intervals: [relaxed(POLL_INTERVAL_MS), 30_000],
    channels: [liveChannels.queues],
    event: completed(),
    observes: true,
  },
  {
    name: "Queues list",
    path: "/queues",
    intervals: [relaxed(QUEUE_REFRESH.list)],
    channels: [liveChannels.queues],
    event: completed(),
  },
  {
    name: "Queue",
    path: "/queues/emails",
    handlers: queueRoutes,
    intervals: [
      relaxed(QUEUE_REFRESH.detail),
      relaxed(QUEUE_REFRESH.counts),
      relaxed(QUEUE_REFRESH.jobs),
    ],
    channels: [liveChannels.queue("emails")],
    event: completed(),
    clock: true,
  },
  panelCase("limits", [], {
    // Limits poll with the queue's detail: what proves the panel is its form.
    start: async () => {
      await page().findByRole(
        "form",
        { name: "Queue limits" },
        { timeout: 5_000 },
      );
    },
  }),
  panelCase("job-defaults", [relaxed(QUEUE_REFRESH.counts)], {
    handlers: () => ({
      "GET /queues/emails/job-defaults": { body: jobDefaultsFixture() },
    }),
    // Its interval is the counts': what proves the panel is its own read.
    start: async () => {
      await eventually(() => {
        expect(fetched("/queues/emails/job-defaults").length).toBeGreaterThan(
          0,
        );
      });
    },
  }),
  panelCase("workers", [QUEUE_REFRESH.workers], {
    channels: [
      liveChannels.queue("emails"),
      liveChannels.queueWorkers("emails"),
    ],
  }),
  panelCase("demand", [QUEUE_REFRESH.demand]),
  panelCase("summon", [QUEUE_REFRESH.summon], {
    handlers: () => ({
      "GET /queues/emails/summon": { body: summonStatusFixture(Date.now()) },
    }),
  }),
  panelCase("throughput", [QUEUE_REFRESH.throughput]),
  panelCase("repeatables", [relaxed(QUEUE_REFRESH.repeatables)]),
  {
    name: "Workers list",
    path: "/workers",
    handlers: () => ({
      "GET /workers": { body: { items: instancesFixture() } },
    }),
    intervals: [relaxed(WORKER_REFRESH.list)],
    channels: [liveChannels.workers],
    event: workerState(),
    clock: true,
  },
  {
    name: "Worker",
    path: "/workers/emails/api.emails",
    handlers: () => ({
      "GET /workers": { body: { items: instancesFixture() } },
    }),
    intervals: [relaxed(WORKER_REFRESH.list)],
    channels: [liveChannels.queueWorkers("emails")],
    event: workerState(),
    clock: true,
  },
  {
    name: "Runners list",
    path: "/runners",
    handlers: () => ({ "GET /runners": { body: runnerListFixture() } }),
    intervals: [relaxed(RUNNER_REFRESH.list)],
    channels: [liveChannels.runners],
    event: runnerStarted(),
  },
  {
    name: "Runner, a running run with its log open",
    path: "/runners/nightly",
    handlers: () => ({
      "GET /meta": { body: runnerMeta() },
      "GET /meta/permissions": { body: permissionsFixture() },
      ...runnerHandlers(runningRunnerFixture()),
      [`GET ${runnerApiPath("nightly", "/history")}`]: {
        body: historyFixture({ items: [runningRun()] }),
      },
      [`GET ${runnerApiPath("nightly", "/runs/run-3/logs")}`]: {
        body: {
          items: [
            { seq: 1, at: Date.now(), stream: "stdout", message: "line 1" },
          ],
          page: { offset: 0, limit: 100, total: 1, hasMore: false },
          dropped: 0,
          capped: false,
          live: true,
          lastSeq: 1,
        },
      },
    }),
    intervals: [relaxed(RUNNER_REFRESH.busy), relaxed(RUNNER_REFRESH.history)],
    channels: [liveChannels.runner("nightly")],
    event: runnerStarted(),
    clock: true,
    start: async (socket) => {
      const row = await page().findByTestId(
        "history-row-run-3",
        {},
        { timeout: 5_000 },
      );
      await act(async () => {
        fireEvent.click(within(row).getByRole("button", { name: "Log" }));
      });
      await page().findByTestId("run-logs-run-3", {}, { timeout: 5_000 });
      await ackAll(socket);
      // The log polls underneath its hints, relaxed while live.
      await eventually(() =>
        expect(polling(relaxed(RUN_LOG_POLL_MS)).length).toBeGreaterThan(0),
      );
    },
  },
  {
    name: "Summoning",
    path: "/summon",
    handlers: () => {
      const { controller, list } = summonListFixtures();
      return { "GET /summon": list([controller()]) };
    },
    intervals: [POLL_INTERVAL_MS],
    channels: [],
    clock: true,
  },
  {
    name: "Providers",
    path: "/providers",
    handlers: () => ({
      "GET /meta/permissions": {
        body: permissionsFixture({ "providers.read": true }),
      },
      "GET /providers": { body: providerList([providerFixture()]) },
    }),
    intervals: [relaxed(POLL_INTERVAL_MS * 2)],
    channels: [],
  },
  {
    name: "Events",
    path: "/events",
    handlers: () => ({
      "GET /queues": { body: queueListFixture() },
      "GET /runners": { body: runnerListFixture() },
    }),
    intervals: [],
    channels: [liveChannels.all],
    event: completed(),
    onEvent: () => {
      if (page().queryAllByTestId("event-row").length === 0) {
        throw new Error("the event was not shown");
      }
    },
  },
  {
    name: "Job, with a read in flight at unmount",
    path: `/queues/emails/jobs/${encodeURIComponent(AWKWARD_ID)}`,
    handlers: () => ({
      "GET /meta": { body: jobMeta() },
      [`GET ${jobApiPath()}`]: { body: jobFixture("active") },
    }),
    intervals: [relaxed(JOB_POLL_MS), LOG_POLL_MS],
    channels: [liveChannels.job("emails", AWKWARD_ID)],
    event: {
      ...completed("emails", AWKWARD_ID),
      type: "active",
      payload: { id: AWKWARD_ID },
    },
    clock: true,
  },
];

/** What is open now, in short: for a start assertion's message. */
function openSummary(socket: TrackedSocket): string {
  const open = ledger
    .outstanding()
    .filter((handle) => handle.kind !== "fetch")
    .map((handle) => `${handle.kind} ${handle.detail} (${handle.origin})`);
  return `open: ${[...new Set(open)].join("; ")}\nheld: ${[...socket.held].join(", ")}`;
}

/** Throws, naming what is missing, unless `screen` started: its polling, its channels, the clock and the observer where used. */
function assertStarted(screen: ScreenCase, socket: TrackedSocket): void {
  const missing = [
    ...screen.intervals
      .filter((ms) => polling(ms).length === 0)
      .map((ms) => `a ${ms}ms TanStack interval`),
    ...screen.channels
      .filter((channel) => !socket.held.has(channel))
      .map((channel) => `the channel ${channel}`),
    ...(screen.clock && clock().length === 0 ? ["the shared clock"] : []),
    ...(screen.observes &&
    ledger.opened("observer", (h) => h.detail === "IntersectionObserver")
      .length === 0
      ? ["an IntersectionObserver"]
      : []),
  ];
  if (missing.length > 0) {
    throw new Error(
      `${screen.name} did not start: missing ${missing.join(", ")}\n${openSummary(socket)}`,
    );
  }
}

/** Per test: a case waits up to 5 s per step, so the 5 s default would cut it off mid-way and the rest of it would run into the next test. */
const CASE_TIMEOUT_MS = 30_000;

/** `it`, with {@link CASE_TIMEOUT_MS}. */
function leakCase(name: string, fn: () => Promise<void>): void {
  it(name, fn, CASE_TIMEOUT_MS);
}

describe("screens leave nothing behind when they unmount", () => {
  for (const screen of CASES) {
    leakCase(screen.name, async () => {
      const jobRead = `/jobs-api${jobApiPath()}`;
      let hangJob = false;
      const { queryClient } = mount(screen.path, screen.handlers?.(), {
        hang: (url) =>
          hangJob && new URL(url, "http://localhost").pathname === jobRead,
      });
      const socket = await goLive();
      await screen.start?.(socket);

      // START: polling at the live intervals, the channels held, the clock and observer where used.
      await eventually(() => assertStarted(screen, socket));
      if (screen.event) {
        await act(async () =>
          socket.receive(eventFrame(1, [screen.channels[0]], screen.event!)),
        );
        if (screen.onEvent) {
          await eventually(screen.onEvent);
        } else {
          // Received, and gathered for 250 ms before one invalidation.
          expect(coalescing().some((handle) => handle.open)).toBe(true);
        }
      }
      // The job case: the next read of the job hangs, in flight at unmount.
      let inFlight: Handle[] = [];
      if (screen.path.includes("/jobs/")) {
        hangJob = true;
        await act(async () => {
          void queryClient.invalidateQueries();
        });
        await flush();
        inFlight = fetched(jobApiPath()).filter((handle) => handle.open);
        expect(inFlight.length).toBeGreaterThan(0);
      }
      const started = ledger
        .outstanding()
        .filter(
          (handle) =>
            (handle.kind === "interval" && handle.origin === "tanstack") ||
            handle.kind === "observer",
        );

      // Phase A: away, before the coalescing timer fires.
      await navigate("/docs");
      await eventually(() => assertReleased(socket, screen.channels));
      expect(coalescing().filter((handle) => handle.open)).toEqual([]);
      expect(started.filter((handle) => handle.open)).toEqual([]);
      if (inFlight.length > 0) {
        expect(inFlight.map((handle) => handle.closedBy)).toEqual(
          inFlight.map(() => "aborted"),
        );
      }

      // Phase B.
      await unmountAndAssert(queryClient);
      expect(socket.closedWith).toBe(1000);
    });
  }
});

describe("transient UI leaves nothing behind when unmounted mid-way", () => {
  leakCase("a toast still showing", async () => {
    const { queryClient } = mount("/queues/emails", {
      ...queueRoutes(),
      "POST /queues/emails/pause": { body: { paused: true } },
    });
    await goLive();
    const pause = await page().findByRole(
      "button",
      { name: "Pause" },
      { timeout: 5_000 },
    );
    await act(async () => {
      fireEvent.click(pause);
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("Paused emails"),
    );
    const timers = timeoutsOf(
      "components/ToastProvider.tsx",
      TOAST_DURATION_MS.success,
    );
    expect(timers.some((handle) => handle.open)).toBe(true);
    await unmountAndAssert(queryClient);
    expect(timers.map((handle) => handle.closedBy)).not.toContain("fired");
  });

  leakCase("a CopyButton just clicked", async () => {
    const { queryClient } = mount(
      `/queues/emails/jobs/${encodeURIComponent(AWKWARD_ID)}`,
      {
        "GET /meta": { body: jobMeta() },
        [`GET ${jobApiPath()}`]: { body: jobFixture("completed") },
      },
    );
    await goLive();
    const button = await page().findByRole(
      "button",
      { name: "Copy job id" },
      { timeout: 5_000 },
    );
    await act(async () => {
      fireEvent.click(button);
    });
    await eventually(() =>
      expect(button.getAttribute("data-status")).not.toBe("idle"),
    );
    const timers = timeoutsOf("components/CopyButton.tsx", COPY_FEEDBACK_MS);
    expect(timers.some((handle) => handle.open)).toBe(true);
    await unmountAndAssert(queryClient);
    expect(timers.map((handle) => handle.closedBy)).not.toContain("fired");
  });

  leakCase("AddFlowDialog open, its permission check pending", async () => {
    const { queryClient } = mount("/queues/emails", {
      ...queueRoutes(),
      "GET /meta": { body: metaFixture({ addableNames: null }) },
      "GET /meta/permissions": {
        body: permissionsFixture({ "jobs.add": true }),
      },
    });
    await goLive();
    await act(async () => {
      fireEvent.click(
        await page().findByRole(
          "button",
          { name: "Add flow" },
          { timeout: 5_000 },
        ),
      );
    });
    const dialog = await page().findByRole("dialog", {
      name: "Add a flow to emails",
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Add child to Top job" }),
      );
    });
    const child = within(dialog).getByRole("group", { name: "Child 1" });
    const select = () =>
      within(child).getByLabelText(/^Queue(\s*\*)?$/) as HTMLSelectElement;
    await eventually(() =>
      expect([...select().options].map((option) => option.value)).toContain(
        "reports",
      ),
    );
    // A child on another queue: the dialog waits 250 ms, then asks about it.
    fireEvent.change(select(), { target: { value: "reports" } });
    const pending = timeoutsOf("screens/job/AddFlowDialog.tsx", 250).at(-1);
    expect(pending?.open).toBe(true);
    await unmountAndAssert(queryClient);
    // Cleared by the unmount, before it could fire.
    expect(pending?.closedBy).toBe("cleared");
  });
});

/* ------------------------------------------------------------------ *
 * Negative controls: each plants one leak of one kind, and the check
 * must name it. StrictMode runs each effect twice, so at least one.
 * ------------------------------------------------------------------ */

/** A component that opens one handle of `kind` and never closes it. */
function Leaky({ kind }: { kind: string }) {
  useEffect(() => {
    switch (kind) {
      case "interval":
        setInterval(() => {}, 1_000);
        break;
      case "timeout":
        setTimeout(() => {}, 60_000);
        break;
      case "animation-frame": {
        // A block body on purpose: `() => requestAnimationFrame(loop)` is a
        // tail call, and JSC's proper tail calls drop this frame.
        const loop = () => {
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
        break;
      }
      case "window-listener":
        window.addEventListener("resize", () => {});
        break;
      case "document-listener":
        document.addEventListener("visibilitychange", () => {});
        break;
      case "websocket":
        void new WebSocket("ws://localhost/leak");
        break;
      case "eventsource":
        void new EventSource("/leak");
        break;
      case "mutation-observer":
        new MutationObserver(() => {}).observe(document.body, {
          childList: true,
        });
        break;
      case "resize-observer":
        new ResizeObserver(() => {}).observe(document.body);
        break;
      case "intersection-observer":
        new IntersectionObserver(() => {}).observe(document.body);
        break;
    }
  }, [kind]);
  return null;
}

/** A component reading through the API client with no signal, so nothing can abort it. */
function LeakyFetch() {
  const api = useApiClient();
  useEffect(() => {
    api.request("GET", "/leak").catch(() => {});
  }, [api]);
  return null;
}

/** Each planted leak, and the kind the check must name. */
const KINDS = [
  ["interval", "interval"],
  ["timeout", "timeout"],
  ["animation-frame", "animation-frame"],
  ["window-listener", "listener"],
  ["document-listener", "listener"],
  ["websocket", "websocket"],
  ["eventsource", "eventsource"],
  ["mutation-observer", "observer"],
  ["resize-observer", "observer"],
  ["intersection-observer", "observer"],
] as const;

/** Runs Phase B and returns what it threw. */
async function caught(
  queryClient: ReturnType<typeof createQueryClient>,
): Promise<unknown> {
  try {
    await unmountAndAssert(queryClient);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("negative controls: a planted leak is caught", () => {
  for (const [plant, kind] of KINDS) {
    leakCase(`flags a ${plant} left open`, async () => {
      const { queryClient } = mount(
        "/docs",
        {},
        { extra: <Leaky kind={plant} /> },
      );
      await flush(3);
      if (plant === "animation-frame") {
        await act(async () => nativeSleep(50));
      }
      const error = await caught(queryClient);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(`- ${kind} `);
      const open = ledger.outstanding();
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(open.every((handle) => handle.kind === kind)).toBe(true);
      ledger.disposeAll();
      expect(ledger.outstanding()).toEqual([]);
    });
  }

  leakCase("flags a fetch left in flight, never aborted", async () => {
    const { queryClient } = mount(
      "/docs",
      {},
      {
        extra: <LeakyFetch />,
        hang: (url) => url.endsWith("/leak"),
      },
    );
    await flush(3);
    const error = await caught(queryClient);
    expect(String(error)).toContain("- fetch GET /jobs-api/leak");
    const open = ledger.outstanding();
    expect(open.length).toBeGreaterThanOrEqual(1);
    expect(open.every((handle) => handle.kind === "fetch")).toBe(true);
    ledger.disposeAll();
  });

  leakCase("flags a live hold never released", async () => {
    const { swap } = mountLive(<LeakyHold />);
    const socket = await goLive();
    expect(socket.held.has("queue/leak")).toBe(true);
    await swap(null);
    // What every screen case asserts in Phase A: here it must fail.
    let error: unknown;
    await eventually(() => assertReleased(socket, ["queue/leak"]), 300).catch(
      (failure: unknown) => {
        error = failure;
      },
    );
    expect(String(error)).toContain("live hold never released: queue/leak");
    cleanup();
    ledger.disposeAll();
  });

  leakCase(
    "control for the control: a hold released on unmount is unsubscribed",
    async () => {
      const { swap, queryClient } = mountLive(<GoodHold />);
      const socket = await goLive();
      expect(socket.held.has("queue/good")).toBe(true);
      await swap(null);
      await eventually(() => assertReleased(socket, ["queue/good"]));
      await unmountAndAssert(queryClient);
    },
  );
});

/** Only the providers `LiveProvider` needs, with `children` under it (as `live/hooks.test.tsx` renders). */
function mountLive(children: ReactNode) {
  const queryClient = createQueryClient({ retry: false });
  const tree = (inner: ReactNode) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <UiConfigContext value={uiConfig()}>
          <MetaContext
            value={{ meta: metaFixture(), permissions: permissionsFixture() }}
          >
            <LiveOptionsContext value={LIVE_ON}>
              <LiveProvider>{inner}</LiveProvider>
            </LiveOptionsContext>
          </MetaContext>
        </UiConfigContext>
      </QueryClientProvider>
    </StrictMode>
  );
  const result = render(tree(children));
  return {
    queryClient,
    /** Re-renders with other children, unmounting the old ones. */
    swap: async (inner: ReactNode) => {
      await act(async () => result.rerender(tree(inner)));
      await flush();
    },
  };
}

/** Holds a channel and never releases it. */
function LeakyHold() {
  const live = use(LiveContext);
  useEffect(() => {
    live?.client?.hold({ channels: ["queue/leak"] });
  }, [live]);
  return null;
}

/** Holds a channel and releases it, as `useLiveSubscription` does. */
function GoodHold() {
  const live = use(LiveContext);
  useEffect(() => {
    const hold = live?.client?.hold({ channels: ["queue/good"] });
    return () => hold?.release();
  }, [live]);
  return null;
}
