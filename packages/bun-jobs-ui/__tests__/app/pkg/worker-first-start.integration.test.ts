import type { BunQueueWorker } from "@kingsleyweb/bun-jobs";
import type {
  JobsApiClientMessage,
  JobsApiEventMessage,
  JobsApiGapMessage,
  JobsApiServerMessage,
  WorkerEventWire,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { FetchLike } from "../../../app/api/client";
import type {
  LiveSocket,
  LiveSocketConstructor,
} from "../../../app/live/client";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi, MemoryDriver } from "@kingsleyweb/bun-jobs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { LiveClient, liveSocketUrl } from "../../../app/live/client";

/**
 * A new worker's FIRST `run()` announces itself on the live-events socket —
 * a worker `state` event with no `previous` on `workers` and on
 * `queue/<queue>/workers` — and the UI's worker screens re-read on it, so a
 * new worker shows up at once instead of on the 5 s poll.
 *
 * Against a REAL `createJobsApi` over the memory driver, served on port 0
 * with its socket attached, and Bun's own `WebSocket` underneath the app's
 * `LiveClient`. The evidence is causal, not wall-clock: every socket frame and
 * every HTTP read is recorded with when it happened, and a test shows the
 * read that brought the row in was made after the event arrived, with no
 * other read in between. While the socket is live the screens poll only every
 * 60 s (`LIVE_SAFETY_POLL_MS`), so nothing else re-reads in the window.
 *
 * The negative control is a test of its own: the socket shim drops the one
 * first-start frame, and the page then does not re-read at all and never
 * shows the worker — until a later transition (a pause, which carries
 * `previous` and is let through) brings it in.
 *
 * A queue that appears AFTER the page subscribed is covered two ways. Created
 * by the API's own `BunJobs`, its queue is followed at once and the
 * first-start frame reaches `workers` as for any other queue. Created by
 * another context (another process, to the API's notifier), it is found only
 * by the notifier's discovery pass, after the worker's first start was
 * published unheard; the session then sends a `queue-discovered` gap scoped
 * to `workers`, and the page re-reads on that instead.
 *
 * Compiled without the DOM lib (see tsconfig.json): the DOM side is loaded by
 * dynamic imports the compiler does not follow, and the interfaces below
 * restate the little this file uses of them. Each scenario owns its queue
 * (and so its worker key), so the order is free (`bun test --randomize`).
 */

/** Bun's WebSocket, captured before this file registers the DOM. */
const NativeWebSocket = globalThis.WebSocket;

/** What this file uses of `../dom`. */
interface DomModule {
  /** Registers happy-dom and the per-test cleanup. */
  setupDom: () => void;
}

/** What this file uses of `../register-dom`. */
interface RegisterDomModule {
  /** Bun's own networking globals, captured before happy-dom replaced them. */
  native: { Request: typeof Request; Response: typeof Response };
}

/** What this file uses of `../workers/realApiLiveWorkers`. */
interface LiveAppModule {
  /** Renders the whole app at `route` with live updates on, and returns a driver. */
  mountLiveApp: (
    route: string,
    fetch: FetchLike,
    csrfHeader: string,
    socket: LiveSocketConstructor,
  ) => {
    liveState: () => string;
    awaitLive: (state?: string) => Promise<void>;
    hasRow: (id: string) => boolean;
    rowState: (id: string) => string;
    awaitRow: (id: string, label: string, timeoutMs?: number) => Promise<void>;
    awaitText: (text: string) => Promise<void>;
    unmount: () => void;
  };
}

/** Imports a module by a specifier the compiler does not resolve. */
function load<T>(specifier: string): Promise<T> {
  return import(specifier) as Promise<T>;
}

const dom = await load<DomModule>(["..", "dom"].join("/"));
const { native } = await load<RegisterDomModule>(
  ["..", "register-dom"].join("/"),
);
dom.setupDom();

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";
const SERVICE = "ship";
/** The other context's service. */
const OTHER_SERVICE = "elsewhere";
/** The API notifier's default `discoveryInterval`: how often it looks for queues another process created. */
const DISCOVERY_INTERVAL_MS = 2_000;
/** `WORKER_REFRESH.list`: how often the Workers page polls without a socket. */
const WORKER_LIST_POLL_MS = 5_000;
/** One queue per scenario, so no worker key or channel is shared. */
const QUEUES = {
  /** The socket: a first run(), then a pause. */
  socketRunning: "first-running",
  /** The socket: a worker paused before run(). */
  socketPaused: "first-paused",
  /** The Workers page picks a new worker up from the event. */
  page: "first-page",
  /** The Workers page, with the first-start frame dropped. */
  control: "first-control",
  /** A queue's Workers panel picks a new worker up from the event. */
  panel: "first-panel",
  /** The Workers page, a worker on a queue created after it subscribed. */
  freshPage: "fresh-page",
  /** The same, with the first-start frame dropped. */
  freshControl: "fresh-control",
  /** The Workers page, a worker another context starts on a new queue. */
  remotePage: "remote-page",
  /** The same, with the `queue-discovered` gap dropped. */
  remoteControl: "remote-control",
} as const;

/** One frame the server sent, with when it arrived. */
interface Received {
  /** `Date.now()` on arrival. */
  at: number;
  /** The frame. */
  frame: JobsApiServerMessage;
  /** Whether the shim withheld it from the app. */
  dropped: boolean;
}

/** Every frame one socket shim's connections sent and received. */
interface Wire {
  /** Frames the client sent. */
  sent: JobsApiClientMessage[];
  /** Frames the server sent, dropped ones included. */
  received: Received[];
  /** Worker ids whose first-start frame (a `state` with no `previous`) is withheld from the app. */
  suppressFirstStart: Set<string>;
  /** Whether `queue-discovered` gap frames are withheld from the app. */
  suppressDiscoveryGaps: boolean;
}

/** One HTTP request the UI made. */
interface Exchange {
  /** The method. */
  method: string;
  /** The path, without the query. */
  path: string;
  /** `Date.now()` when the request was made. */
  startedAt: number;
  /** The parsed JSON answer, or `undefined`. */
  json: unknown;
}

let jobs: BunJobs;
/**
 * Another context on the API's driver instance and namespace, but not the
 * API's `BunJobs`: to the API's notifier it is another process, whose new
 * queues are found only by a discovery pass.
 */
let other: BunJobs;
/** The one driver instance both contexts share; neither closes a driver it was given. */
let driver: MemoryDriver;
let api: ReturnType<typeof createJobsApi>;
let adapter: BunHttpAdapter;
let port: number;
let fetchShim: FetchLike;
const exchanges: Exchange[] = [];
const workers: BunQueueWorker<unknown, unknown>[] = [];

/**
 * Runs `fn` with Bun's `Response` as the global: the API builds its
 * responses from the global, which happy-dom has replaced.
 */
async function withBunGlobals<T>(fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.Response;
  globalThis.Response = native.Response;
  try {
    return await fn();
  } finally {
    globalThis.Response = saved;
  }
}

/** Resolves once `check` holds, reporting `what` if it never does. */
async function until(
  check: () => boolean | Promise<boolean>,
  what: () => string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits `ms`. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fresh, empty frame recorder. */
function newWire(): Wire {
  return {
    sent: [],
    received: [],
    suppressFirstStart: new Set(),
    suppressDiscoveryGaps: false,
  };
}

/** Whether `frame` is a worker `state` event about worker `id`. */
function isStateOf(
  frame: JobsApiServerMessage,
  id: string,
): frame is JobsApiEventMessage & {
  event: Extract<WorkerEventWire, { type: "state" }>;
} {
  return (
    frame.type === "event" &&
    frame.event.kind === "worker" &&
    frame.event.type === "state" &&
    frame.event.payload.worker === id
  );
}

/** The `state` frames about worker `id` that reached `wire`, oldest first. */
function statesOf(
  wire: Wire,
  id: string,
): (Received & {
  frame: JobsApiEventMessage & {
    event: Extract<WorkerEventWire, { type: "state" }>;
  };
})[] {
  return wire.received.filter(
    (
      one,
    ): one is Received & {
      frame: JobsApiEventMessage & {
        event: Extract<WorkerEventWire, { type: "state" }>;
      };
    } => isStateOf(one.frame, id),
  );
}

/** Every frame about worker `id` (any worker event naming it), oldest first. */
function workerFramesOf(wire: Wire, id: string): Received[] {
  return wire.received.filter(
    (one) =>
      one.frame.type === "event" &&
      one.frame.event.kind === "worker" &&
      one.frame.event.id === id,
  );
}

/** Whether the server acked a subscribe that applied `channel`. */
function subscribed(wire: Wire, channel: string): boolean {
  return wire.received.some(
    ({ frame }) =>
      frame.type === "ack" &&
      frame.op === "subscribe" &&
      frame.channels.includes(channel) &&
      !(frame.rejected ?? []).some((one) => one.channel === channel),
  );
}

/**
 * A `LiveSocket` over Bun's `WebSocket` that records both directions into
 * `wire`, withholds the first-start frames `wire.suppressFirstStart` names,
 * and connects to the API's port whatever host the app computed (the DOM's
 * page is `http://localhost/jobs`, which serves nothing).
 */
function socketFor(wire: Wire): LiveSocketConstructor {
  return class ShimSocket implements LiveSocket {
    /** Called once open. */
    onopen: LiveSocket["onopen"] = null;
    /** Called per frame. */
    onmessage: LiveSocket["onmessage"] = null;
    /** Called once closed. */
    onclose: LiveSocket["onclose"] = null;
    /** Called on an error. */
    onerror: LiveSocket["onerror"] = null;
    /** The real socket. */
    readonly #inner: WebSocket;

    constructor(url: string, protocols: string[]) {
      const asked = new URL(url);
      this.#inner = new NativeWebSocket(
        `ws://127.0.0.1:${port}${asked.pathname}${asked.search}`,
        protocols,
      );
      this.#inner.onopen = (event) => this.onopen?.(event);
      this.#inner.onerror = (event) => this.onerror?.(event);
      this.#inner.onclose = (event) =>
        this.onclose?.({ code: event.code, reason: event.reason });
      this.#inner.onmessage = (event) => {
        const text = String(event.data);
        const frame = JSON.parse(text) as JobsApiServerMessage;
        const dropped =
          (frame.type === "event" &&
            frame.event.kind === "worker" &&
            frame.event.type === "state" &&
            frame.event.payload.previous === undefined &&
            wire.suppressFirstStart.has(frame.event.payload.worker)) ||
          (frame.type === "gap" &&
            frame.reason === "queue-discovered" &&
            wire.suppressDiscoveryGaps);
        wire.received.push({ at: Date.now(), frame, dropped });
        if (!dropped) {
          this.onmessage?.({ data: text });
        }
      };
    }

    /** The real socket's state. */
    get readyState(): number {
      return this.#inner.readyState;
    }

    /** Records and sends a frame. */
    send(data: string): void {
      wire.sent.push(JSON.parse(data) as JobsApiClientMessage);
      this.#inner.send(data);
    }

    /** Closes the real socket. */
    close(code?: number, reason?: string): void {
      this.#inner.close(code, reason);
    }
  };
}

/** Builds (without starting) a worker on `queue` and remembers it for `afterAll`. */
function newWorker(queue: string): BunQueueWorker<unknown, unknown> {
  const worker = jobs.worker<unknown, unknown>(queue, async () => "ok", {
    concurrency: 1,
    reportInterval: 1_000,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
  });
  workers.push(worker);
  return worker;
}

/** Builds (without starting) a worker on `queue` in the OTHER context, and remembers it for `afterAll`. */
function otherWorker(queue: string): BunQueueWorker<unknown, unknown> {
  const worker = other.worker<unknown, unknown>(queue, async () => "ok", {
    concurrency: 1,
    reportInterval: 1_000,
    pollInterval: 10,
    waitToExit: false,
    logger: noopLogger,
  });
  workers.push(worker);
  return worker;
}

/** The `queue-discovered` gap frames that reached `wire`, dropped ones included, oldest first. */
function discoveryGaps(
  wire: Wire,
): (Received & { frame: JobsApiGapMessage })[] {
  return wire.received.filter(
    (one): one is Received & { frame: JobsApiGapMessage } =>
      one.frame.type === "gap" && one.frame.reason === "queue-discovered",
  );
}

/** Every `GET <path>` the UI made since exchange number `from`. */
function readsOf(path: string, from: number): Exchange[] {
  return exchanges
    .slice(from)
    .filter((one) => one.method === "GET" && one.path === `${BASE}${path}`);
}

/** Whether a worker listing answer carries worker `id`. */
function lists(json: unknown, id: string): boolean {
  const items = (json as { items?: { id?: string }[] } | undefined)?.items;
  return items?.some((one) => one.id === id) === true;
}

/** Whether the API lists worker `id` now (a read the UI's record does not see). */
async function registered(id: string): Promise<boolean> {
  const response = await withBunGlobals(() => adapter.fetch(`${BASE}/workers`));
  return lists(await response.json(), id);
}

beforeAll(async () => {
  // A happy-dom WebSocket here would mean another file leaked its DOM.
  expect(String(NativeWebSocket)).toContain("[native code]");
  driver = new MemoryDriver();
  jobs = new BunJobs({
    namespace: "ui-worker-first-start-integration",
    service: SERVICE,
    driver,
    logger: noopLogger,
    publishEvents: true,
  });
  other = new BunJobs({
    namespace: "ui-worker-first-start-integration",
    service: OTHER_SERVICE,
    driver,
    logger: noopLogger,
    publishEvents: true,
  });
  // These screens' queues exist before the pages subscribe — a new worker on
  // an existing queue — and a queue's page needs its queue. Pausing and
  // resuming creates a queue with no job in it, so no job event reaches the
  // queue page's own channel. The `fresh*` queues are deliberately NOT
  // created: their tests cover a queue that appears after the subscription.
  for (const queue of [QUEUES.page, QUEUES.control, QUEUES.panel]) {
    await jobs.queue(queue).pause();
    await jobs.queue(queue).resume();
  }
  api = createJobsApi({
    jobs,
    mode: "jobs",
    basePath: BASE,
    authorize: () => true,
    logger: noopLogger,
    csrf: { header: CSRF },
  });
  adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.use(api.basePath, api.router);
  api.websocket!.attach(adapter);
  port = (await adapter.listen(0)).port!;
  // The app's AbortSignal is happy-dom's, which Bun's Request refuses.
  fetchShim = async (input, { signal: _signal, ...init }) =>
    withBunGlobals(async () => {
      const url = new URL(input, `http://127.0.0.1:${port}`);
      const startedAt = Date.now();
      const response = await adapter.fetch(new native.Request(url.href, init));
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      exchanges.push({
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        startedAt,
        json,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });
    });
});

afterAll(async () => {
  for (const worker of workers) {
    await worker.close({ force: true }).catch(() => undefined);
  }
  await api.close();
  await adapter.close();
  await jobs.close();
  await other.close();
  await driver.close();
});

/** Starts a `LiveClient` over the shim, holding `channels`, and waits until each is subscribed. */
async function holdChannels(wire: Wire, channels: string[]) {
  const client = new LiveClient({
    url: () =>
      liveSocketUrl(
        { path: api.websocket!.path },
        BASE,
        `http://127.0.0.1:${port}/jobs`,
      ),
    WebSocket: socketFor(wire),
    backoffInitialMs: 50,
    backoffMaxMs: 200,
  });
  client.start();
  const delivered: WorkerEventWire[] = [];
  const hold = client.hold({
    channels,
    onEvent: (event) => {
      if (event.kind === "worker") {
        delivered.push(event);
      }
    },
  });
  await until(
    () => channels.every((channel) => subscribed(wire, channel)),
    () => `never subscribed to ${channels.join(", ")}`,
  );
  return {
    delivered,
    stop: () => {
      hold.release();
      client.stop();
    },
  };
}

describe("a new worker's first start on the live-events socket", () => {
  it("announces run() as running with no previous on both worker channels, and a pause with previous", async () => {
    const queue = QUEUES.socketRunning;
    const channels = ["workers", `queue/${queue}/workers`];
    const wire = newWire();
    const live = await holdChannels(wire, channels);
    try {
      const worker = newWorker(queue);
      // Nothing is published before run().
      await pause(150);
      expect(workerFramesOf(wire, worker.id)).toEqual([]);

      void worker.run();
      await until(
        () => statesOf(wire, worker.id).length >= 1,
        () => "no state event after run()",
      );
      const [first] = statesOf(wire, worker.id);
      // One frame, sent for both channels.
      expect([...first!.frame.subscriptions].sort()).toEqual(
        [...channels].sort(),
      );
      expect(first!.frame.event).toMatchObject({
        v: 1,
        kind: "worker",
        type: "state",
        target: queue,
        id: worker.id,
        payload: {
          worker: worker.id,
          key: `${SERVICE}.${queue}`,
          state: "running",
        },
      });
      expect(Object.hasOwn(first!.frame.event.payload, "previous")).toBe(false);
      expect(first!.frame.event.payload.at).toBeNumber();
      // And the app's client handed it on.
      await until(
        () => live.delivered.some((event) => event.id === worker.id),
        () => "the client never delivered the first start",
      );

      await worker.pause();
      await until(
        () => statesOf(wire, worker.id).length >= 2,
        () => "no state event after pause()",
      );
      const second = statesOf(wire, worker.id)[1]!;
      expect([...second.frame.subscriptions].sort()).toEqual(
        [...channels].sort(),
      );
      expect(second.frame.event.payload).toMatchObject({
        worker: worker.id,
        state: "paused",
        previous: "running",
      });
      expect(statesOf(wire, worker.id)).toHaveLength(2);
    } finally {
      live.stop();
    }
  }, 30_000);

  it("announces a worker paused before run() as paused, with no previous", async () => {
    const queue = QUEUES.socketPaused;
    const channels = ["workers", `queue/${queue}/workers`];
    const wire = newWire();
    const live = await holdChannels(wire, channels);
    try {
      const worker = newWorker(queue);
      await worker.pause();
      await pause(150);
      expect(workerFramesOf(wire, worker.id)).toEqual([]);

      void worker.run();
      await until(
        () => statesOf(wire, worker.id).length >= 1,
        () => "no state event after run()",
      );
      const [first] = statesOf(wire, worker.id);
      expect([...first!.frame.subscriptions].sort()).toEqual(
        [...channels].sort(),
      );
      expect(first!.frame.event.payload).toMatchObject({
        worker: worker.id,
        key: `${SERVICE}.${queue}`,
        state: "paused",
      });
      expect(Object.hasOwn(first!.frame.event.payload, "previous")).toBe(false);

      worker.resume();
      await until(
        () => statesOf(wire, worker.id).length >= 2,
        () => "no state event after resume()",
      );
      expect(statesOf(wire, worker.id)[1]!.frame.event.payload).toMatchObject({
        state: "running",
        previous: "paused",
      });
    } finally {
      live.stop();
    }
  }, 30_000);
});

/**
 * Mounts the app at `route` over the shim and waits until it is live, has
 * subscribed to `channel`, and has settled: its first read of `listPath`
 * answered and no invalidation still pending. Returns the driver and the
 * exchange index the scenario counts from.
 */
async function mountSettled(
  route: string,
  wire: Wire,
  channel: string,
  listPath: string,
) {
  const { mountLiveApp } = await load<LiveAppModule>(
    ["..", "workers", "realApiLiveWorkers"].join("/"),
  );
  const start = exchanges.length;
  const ui = mountLiveApp(route, fetchShim, CSRF, socketFor(wire));
  await ui.awaitLive("live");
  await until(
    () => subscribed(wire, channel),
    () => `the app never subscribed to ${channel}`,
  );
  await until(
    () => readsOf(listPath, start).length > 0,
    () => `the app never read ${listPath}`,
  );
  // Past one invalidation delay (250 ms), so the count starts from quiet.
  await pause(400);
  return { ui, from: exchanges.length };
}

describe("the worker screens pick a first start up from the socket", () => {
  it("the Workers page re-reads on the event and shows the new worker, with no poll involved", async () => {
    const queue = QUEUES.page;
    const wire = newWire();
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );
    // Live, so the list polls at the 60 s safety net, not every 5 s.
    expect(ui.liveState()).toBe("live");

    const worker = newWorker(queue);
    const ranAt = Date.now();
    void worker.run();
    await ui.awaitRow(worker.id, "Running", 4_000);
    const shownAt = Date.now();

    const [first] = statesOf(wire, worker.id);
    expect(first!.dropped).toBe(false);
    expect(first!.frame.event.payload.state).toBe("running");
    expect(Object.hasOwn(first!.frame.event.payload, "previous")).toBe(false);

    // Every read since the page settled came after the event arrived — none
    // was a poll that happened to land — and one of them carried the worker.
    const reads = readsOf("/workers", from);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.startedAt).toBeGreaterThanOrEqual(first!.at);
    }
    expect(reads.some((read) => lists(read.json, worker.id))).toBe(true);
    // Far inside the 5 s poll the page would otherwise wait for.
    expect(shownAt - ranAt).toBeLessThan(WORKER_LIST_POLL_MS);
    ui.unmount();
  }, 30_000);

  it("control: with the first-start frame withheld, the page does not re-read and never shows the worker", async () => {
    const queue = QUEUES.control;
    const wire = newWire();
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );

    const worker = newWorker(queue);
    wire.suppressFirstStart.add(worker.id);
    void worker.run();
    // The server did send it — the shim dropped it — and the worker is listed.
    await until(
      () => statesOf(wire, worker.id).some((one) => one.dropped),
      () => "the server never sent the first start",
    );
    await until(
      () => registered(worker.id),
      () => "the worker never registered",
    );
    // Many invalidation delays, and several times what the positive case needed.
    await pause(1_500);
    expect(readsOf("/workers", from)).toEqual([]);
    expect(ui.hasRow(worker.id)).toBe(false);

    // A transition carries `previous`, is let through, and brings it in.
    const mark = exchanges.length;
    await worker.pause();
    await ui.awaitRow(worker.id, "Paused", 4_000);
    const transition = statesOf(wire, worker.id).find(
      (one) => one.frame.event.payload.previous !== undefined,
    )!;
    expect(transition.dropped).toBe(false);
    expect(transition.frame.event.payload).toMatchObject({
      state: "paused",
      previous: "running",
    });
    const reads = readsOf("/workers", mark);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.startedAt).toBeGreaterThanOrEqual(transition.at);
    }
    ui.unmount();
  }, 30_000);

  it("a queue's Workers panel re-reads on the event on queue/<queue>/workers", async () => {
    const queue = QUEUES.panel;
    const wire = newWire();
    const panelPath = `/queues/${queue}/workers`;
    const { ui, from } = await mountSettled(
      `/jobs/queues/${queue}?panel=workers`,
      wire,
      `queue/${queue}/workers`,
      panelPath,
    );
    await ui.awaitText("No live workers");

    const worker = newWorker(queue);
    void worker.run();
    await ui.awaitRow(worker.id, "Running", 4_000);

    const [first] = statesOf(wire, worker.id);
    expect(first!.frame.subscriptions).toContain(`queue/${queue}/workers`);
    // The page holds no `workers` subscription: the panel's channel carried it.
    expect(first!.frame.subscriptions).not.toContain("workers");
    expect(Object.hasOwn(first!.frame.event.payload, "previous")).toBe(false);

    const reads = readsOf(panelPath, from);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.startedAt).toBeGreaterThanOrEqual(first!.at);
    }
    expect(reads.some((read) => lists(read.json, worker.id))).toBe(true);
    ui.unmount();
  }, 30_000);

  // A queue the API's own `BunJobs` creates after the page subscribed is
  // followed at once, so its worker's first start reaches `workers` like any
  // other; and `GET /workers` confirms a consumed queue missing from its
  // cached queue names (`limits.queueCacheMs`) with one fresh read, so the
  // re-read lists the worker. Both at the default settings.
  it("the Workers page hears a worker on a queue created AFTER it subscribed", async () => {
    const queue = QUEUES.freshPage;
    const wire = newWire();
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );
    // Brand new: the API could not reach it when the page subscribed.
    expect(await jobs.listQueues()).not.toContain(queue);

    const worker = newWorker(queue);
    const ranAt = Date.now();
    void worker.run();
    await ui.awaitRow(worker.id, "Running", 4_000);
    const shownAt = Date.now();

    const [first] = statesOf(wire, worker.id);
    expect(first!.dropped).toBe(false);
    expect(first!.frame.subscriptions).toEqual(["workers"]);
    expect(first!.frame.event).toMatchObject({
      kind: "worker",
      type: "state",
      target: queue,
      id: worker.id,
      payload: {
        worker: worker.id,
        key: `${SERVICE}.${queue}`,
        state: "running",
      },
    });
    expect(Object.hasOwn(first!.frame.event.payload, "previous")).toBe(false);

    const reads = readsOf("/workers", from);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.startedAt).toBeGreaterThanOrEqual(first!.at);
    }
    expect(reads.some((read) => lists(read.json, worker.id))).toBe(true);
    expect(shownAt - ranAt).toBeLessThan(WORKER_LIST_POLL_MS);
    ui.unmount();
  }, 30_000);

  // The control: the same new queue, the frame withheld. The worker IS
  // listed by then (the positive test shows a re-read would find it), so the
  // missing row is down to the missing frame alone.
  it("control: a new queue's first-start frame withheld, the page shows no row", async () => {
    const queue = QUEUES.freshControl;
    const wire = newWire();
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );
    expect(await jobs.listQueues()).not.toContain(queue);

    const worker = newWorker(queue);
    wire.suppressFirstStart.add(worker.id);
    void worker.run();
    // The server did send it on `workers` — the shim dropped it.
    await until(
      () => statesOf(wire, worker.id).some((one) => one.dropped),
      () => "the server never sent the first start",
    );
    await until(
      () => registered(worker.id),
      () => "the worker never registered",
    );
    await pause(1_500);
    expect(readsOf("/workers", from)).toEqual([]);
    expect(ui.hasRow(worker.id)).toBe(false);
    ui.unmount();
  }, 30_000);

  it("the Workers page hears a worker another process starts on a new queue, by a queue-discovered gap", async () => {
    const queue = QUEUES.remotePage;
    const wire = newWire();
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );
    expect(await jobs.listQueues()).not.toContain(queue);

    const worker = otherWorker(queue);
    const ranAt = Date.now();
    void worker.run();
    await ui.awaitRow(worker.id, "Running", DISCOVERY_INTERVAL_MS + 3_000);
    const shownAt = Date.now();

    const gap = discoveryGaps(wire)[0];
    expect(gap).toBeDefined();
    expect(gap!.dropped).toBe(false);
    expect(gap!.frame).toMatchObject({
      type: "gap",
      reason: "queue-discovered",
      channels: ["workers"],
      fromSeq: 0,
    });
    // The worker's own first start was published before discovery found its
    // queue, so nobody heard it: the gap is what the page acts on.
    expect(statesOf(wire, worker.id)).toEqual([]);

    const reads = readsOf("/workers", from);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.startedAt).toBeGreaterThanOrEqual(gap!.at);
    }
    expect(reads.some((read) => lists(read.json, worker.id))).toBe(true);
    // One discovery pass, then the re-read: far inside the 60 s live poll.
    expect(shownAt - ranAt).toBeLessThan(DISCOVERY_INTERVAL_MS + 1_500);
    ui.unmount();
  }, 30_000);

  it("control: the queue-discovered gap withheld, the page shows no row", async () => {
    const queue = QUEUES.remoteControl;
    const wire = newWire();
    wire.suppressDiscoveryGaps = true;
    const { ui, from } = await mountSettled(
      "/jobs/workers",
      wire,
      "workers",
      "/workers",
    );
    expect(await jobs.listQueues()).not.toContain(queue);

    const worker = otherWorker(queue);
    const ranAt = Date.now();
    void worker.run();
    // The server did send it — the shim dropped it — and the worker is listed.
    await until(
      () => discoveryGaps(wire).some((one) => one.dropped),
      () => "the server never sent a queue-discovered gap",
    );
    await until(
      () => registered(worker.id),
      () => "the worker never registered",
    );
    // Past a whole discovery interval plus a second, and a second past the gap.
    await pause(
      Math.max(1_000, ranAt + DISCOVERY_INTERVAL_MS + 1_000 - Date.now()),
    );
    expect(readsOf("/workers", from)).toEqual([]);
    expect(ui.hasRow(worker.id)).toBe(false);
    ui.unmount();
  }, 30_000);
});
