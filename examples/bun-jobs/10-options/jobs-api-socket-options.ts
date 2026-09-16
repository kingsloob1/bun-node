/**
 * Option tour: the management API's live-events socket — every
 * `websocket` option, every way a subscription can be refused, and every
 * documented close code, each provoked against a real connection.
 *
 * ```bash
 * bun 10-options/jobs-api-socket-options.ts
 * ```
 *
 * The HTTP half is the previous tour,
 * [`jobs-api-options.ts`](./jobs-api-options.ts).
 *
 * What the checks below are built around:
 *
 * - **One socket, many logical channels.** `all`, `queues`, `queue/{q}`,
 *   `queue/{q}/job/{id}`, `runners` and `runner/{r}` are multiplexed over one
 *   connection and subscribed to by name.
 * - **Each subscription is authorized separately**, and a refusal is a
 *   per-channel entry in the `ack` rather than a closed connection. One
 *   channel you may not see never costs you the others.
 * - **`seq` is meaningful only within an `epoch`.** The epoch is random per
 *   API instance, so a `seq` from another process — or from this one after a
 *   restart — means nothing here, and saying so is what `gap` is for.
 * - **Backpressure is bounded, not buffered forever.** A client that cannot
 *   keep up stops receiving events, gets one `gap` when it drains, and is
 *   closed `4008` if it never does.
 *
 * The tour runs on the memory driver: events are process-local there, which is
 * all one process needs. Across processes, set `publishEvents` in *every*
 * process that produces events.
 */
import { BunHttpAdapter, BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_SUBPROTOCOL,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { connectJobsSocket } from "../11-management-api/helpers/jobs-socket";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: the management API's socket");

/** Everything a section opened, closed at the end in reverse. */
const cleanups: (() => Promise<void> | void)[] = [];

/** What one served API gives a section to work with. */
interface Served {
  /** The context behind it. */
  jobs: BunJobs;
  /** The API. */
  api: ReturnType<typeof createJobsApi>;
  /** The adapter serving it. */
  adapter: BunHttpAdapter;
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  /** The socket's `ws://` URL. */
  url: string;
}

/** An API on a listening adapter, with its socket attached. */
async function served(
  overrides: Partial<Parameters<typeof createJobsApi>[0]> = {},
  suffix = String(cleanups.length),
): Promise<Served> {
  const jobs = new BunJobs({
    namespace: `tour-socket-${suffix}`,
    driver: new MemoryDriver(),
    logger: noopLogger,
    publishEvents: true,
  });
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    authorize: () => true,
    logger: noopLogger,
    ...overrides,
  });
  const adapter = new BunHttpAdapter(0, { logger: noopLogger });
  adapter.use(api.basePath, api.router);
  if (api.websocket && api.websocket.port === undefined) {
    api.websocket.attach(adapter);
  }
  const server = await adapter.listen(0);
  cleanups.push(async () => {
    await api.close();
    await adapter.close();
    await jobs.close();
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    jobs,
    api,
    adapter,
    origin,
    url: `ws://127.0.0.1:${server.port}${api.websocket?.path ?? "/admin/jobs/ws"}`,
  };
}

/** The headers of a WebSocket upgrade, for probing refusals with `fetch`. */
const UPGRADE_HEADERS = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

/** Sends an upgrade the server is expected to refuse, and reads the problem. */
async function refusedUpgrade(
  origin: string,
  headers: Record<string, string> = {},
  path = "/admin/jobs/ws",
) {
  const response = await fetch(`${origin}${path}`, {
    headers: { ...UPGRADE_HEADERS, ...headers },
  });
  const body = (await response.json()) as { code: string; status: number };
  return { status: response.status, body };
}

/* ------------------------------------------------------------------ */
step("The defaults, and turning the socket off entirely");

const defaults = await served();
const defaultMeta = (await (
  await fetch(`${defaults.origin}/admin/jobs/meta`)
).json()) as any;
checkEqual("the socket is on by default", defaultMeta.websocket !== null, true);
checkEqual("at <basePath>/ws", defaultMeta.websocket.path, "/admin/jobs/ws");
checkEqual(
  "heartbeatMs defaults to 25s",
  defaultMeta.websocket.heartbeatMs,
  25_000,
);
checkEqual(
  "maxSubscriptions defaults to 50",
  defaultMeta.websocket.maxSubscriptions,
  50,
);
checkEqual(
  "api.websocket.path",
  defaults.api.websocket!.path,
  "/admin/jobs/ws",
);
checkEqual(
  "and there is an AsyncAPI document",
  defaults.api.asyncapi()!.asyncapi,
  "3.0.0",
);

const silent = await served({ websocket: false }, "off");
checkEqual(
  "websocket: false leaves no socket",
  silent.api.websocket,
  undefined,
);
checkEqual("no AsyncAPI document either", silent.api.asyncapi(), undefined);
checkEqual(
  "/meta says so",
  ((await (await fetch(`${silent.origin}/admin/jobs/meta`)).json()) as any)
    .websocket,
  null,
);
checkEqual(
  "and its JSON endpoint is not routed",
  (await fetch(`${silent.origin}/admin/jobs/asyncapi.json`)).status,
  404,
);

const moved = await served({ websocket: { path: "/events" } }, "path");
checkEqual(
  "websocket.path moves it under basePath",
  moved.api.websocket!.path,
  "/admin/jobs/events",
);
const movedClient = await connectJobsSocket(moved.url);
await movedClient.next("hello");
show("connected at", moved.api.websocket!.path);
movedClient.close();

/* ------------------------------------------------------------------ */
step("hello: what a client is told on open");

const greeting = await served({}, "hello");
const client = await connectJobsSocket(greeting.url);
const hello = await client.next("hello");
checkEqual("protocol version", hello.protocol, 1);
checkEqual("the API's mode", hello.mode, "both");
checkEqual("seq starts at 0", hello.seq, 0);
checkEqual(
  "how events reach this process",
  hello.events,
  greeting.jobs.driver.capabilities.events,
);
check(
  "a session id",
  typeof hello.sessionId === "string" && hello.sessionId !== "",
);
check("and a random epoch", /^[\da-f-]{36}$/.test(hello.epoch), hello.epoch);
checkEqual("the API counts the session", greeting.api.websocket!.sessions, 1);

/* ------------------------------------------------------------------ */
step("The subprotocol is optional, but a list must include ours");

checkEqual(
  "the constant is what a client offers",
  JOBS_API_WS_SUBPROTOCOL,
  "bun-jobs.v1",
);
const negotiated = await connectJobsSocket(greeting.url, {
  protocols: [JOBS_API_WS_SUBPROTOCOL],
});
checkEqual(
  "offering it is accepted, and echoed",
  negotiated.socket.protocol,
  JOBS_API_WS_SUBPROTOCOL,
);
negotiated.close();
const wrongProtocol = await refusedUpgrade(greeting.origin, {
  "Sec-WebSocket-Protocol": "chat, mqtt",
});
checkEqual(
  "a list without it is refused before any socket exists",
  [wrongProtocol.status, wrongProtocol.body.code],
  [400, "UNSUPPORTED_SUBPROTOCOL"],
);

/* ------------------------------------------------------------------ */
step("allowedOrigins: a browser sends cookies on a cross-site upgrade");

const sameOrigin = await refusedUpgrade(greeting.origin, {
  Origin: "https://evil.example",
});
checkEqual(
  "so a cross-origin upgrade is refused by default",
  [sameOrigin.status, sameOrigin.body.code],
  [403, "ORIGIN_REJECTED"],
);
checkEqual("and nothing was opened", greeting.api.websocket!.sessions, 1);

const listed = await served(
  { websocket: { allowedOrigins: ["https://ops.example"] } },
  "origins",
);
const allowed = await connectJobsSocket(listed.url, {
  headers: { Origin: "https://ops.example" },
});
await allowed.next("hello");
checkEqual("a listed origin connects", listed.api.websocket!.sessions, 1);
allowed.close();
checkEqual(
  "one that is not listed still cannot",
  (await refusedUpgrade(listed.origin, { Origin: "https://other.example" }))
    .status,
  403,
);

const anyOrigin = await served({ websocket: { allowedOrigins: "*" } }, "any");
const anywhere = await connectJobsSocket(anyOrigin.url, {
  headers: { Origin: "https://anything.example" },
});
await anywhere.next("hello");
checkEqual('"*" allows every origin', anyOrigin.api.websocket!.sessions, 1);
anywhere.close();

/* ------------------------------------------------------------------ */
step("maxConnections: the cap is checked before the middleware");

const capped = await served({ websocket: { maxConnections: 1 } }, "cap");
const only = await connectJobsSocket(capped.url);
await only.next("hello");
const full = await refusedUpgrade(capped.origin);
checkEqual(
  "a full API refuses with 429",
  [full.status, full.body.code],
  [429, "CONNECTION_LIMIT"],
);
only.close();

/* ------------------------------------------------------------------ */
step("Subscribing: every channel is checked and authorized on its own");

const channels = await served(
  {
    authorize: (_req, context) =>
      context.action === "events.subscribe" && context.queue === "secret"
        ? { allow: false, reason: "not yours" }
        : true,
  },
  "channels",
);
const subscriber = await connectJobsSocket(channels.url);
await subscriber.next("hello");
subscriber.send({
  op: "subscribe",
  id: "s1",
  channels: [
    "all",
    "queues",
    "queue/mail",
    `queue/mail/job/${encodeURIComponent("a/b")}`,
    "runners",
    "runner/nightly",
    "queue/secret",
    "queue/not a name",
    "nonsense",
    // A duplicate: accepted once, in canonical form.
    "queue/mail",
  ],
});
const ack = await subscriber.next("ack", (frame) => frame.id === "s1");
checkEqual("what was accepted, de-duplicated and canonical", ack.channels, [
  "all",
  "queues",
  "queue/mail",
  "queue/mail/job/a%2Fb",
  "runners",
  "runner/nightly",
]);
// Refusals come in two phases: a name that is not a channel at all is
// rejected while the list is parsed, and only the names that survive are put
// to `authorize`. So the malformed ones are listed first, whatever order the
// client sent them in.
checkEqual(
  "and every refusal, with its own reason",
  ack.rejected?.map((rejection) => [
    rejection.channel,
    rejection.code,
    rejection.status,
  ]),
  [
    ["queue/not a name", "INVALID_CHANNEL", 400],
    ["nonsense", "INVALID_CHANNEL", 400],
    ["queue/secret", "FORBIDDEN", 403],
  ],
);
check(
  "a refused channel does not close the connection",
  subscriber.closed === undefined,
);
checkEqual("the ack carries the latest seq", ack.seq, 0);

// Decisions are cached for the session: subscribing again asks nothing new.
const asked: string[] = [];
const counting = await served(
  {
    authorize: (_req, context) => {
      if (context.action === "events.subscribe" && context.channel) {
        asked.push(context.channel);
      }
      return true;
    },
  },
  "cached",
);
const repeat = await connectJobsSocket(counting.url);
await repeat.next("hello");
repeat.send({ op: "subscribe", id: "a", channels: ["queues"] });
await repeat.next("ack", (frame) => frame.id === "a");
repeat.send({ op: "subscribe", id: "b", channels: ["queues"] });
await repeat.next("ack", (frame) => frame.id === "b");
checkEqual("each channel is authorized once per session", asked, ["queues"]);

// A mode decides which channels exist at all.
const jobsOnly = await served({ mode: "jobs" }, "mode");
const narrow = await connectJobsSocket(jobsOnly.url);
await narrow.next("hello");
narrow.send({
  op: "subscribe",
  id: "m",
  channels: ["queues", "runners", "runner/x", "all"],
});
const narrowAck = await narrow.next("ack", (frame) => frame.id === "m");
checkEqual("mode jobs offers the queue channels", narrowAck.channels, [
  "queues",
]);
checkEqual(
  "and refuses the rest as unavailable",
  narrowAck.rejected?.map((rejection) => rejection.code),
  ["CHANNEL_NOT_AVAILABLE", "CHANNEL_NOT_AVAILABLE", "CHANNEL_NOT_AVAILABLE"],
);

// A `queues` allow-list narrows them further.
const restricted = await served({ queues: ["mail"] }, "queues");
const restrictedClient = await connectJobsSocket(restricted.url);
await restrictedClient.next("hello");
restrictedClient.send({
  op: "subscribe",
  id: "q",
  channels: ["queue/mail", "queue/other"],
});
const restrictedAck = await restrictedClient.next(
  "ack",
  (frame) => frame.id === "q",
);
checkEqual(
  "a queue outside the list is not found",
  restrictedAck.rejected?.map((rejection) => [
    rejection.channel,
    rejection.code,
  ]),
  [["queue/other", "QUEUE_NOT_FOUND"]],
);

/* ------------------------------------------------------------------ */
step("maxSubscriptions: the cap refuses the channel, not the connection");

const fewChannels = await served(
  { websocket: { maxSubscriptions: 2 } },
  "subs",
);
const limited = await connectJobsSocket(fewChannels.url);
await limited.next("hello");
limited.send({
  op: "subscribe",
  id: "s",
  channels: ["queues", "queue/mail", "runners"],
});
const limitedAck = await limited.next("ack", (frame) => frame.id === "s");
checkEqual("two were taken", limitedAck.channels.length, 2);
checkEqual(
  "and the third refused",
  limitedAck.rejected?.map((rejection) => rejection.code),
  ["SUBSCRIPTION_LIMIT"],
);
check("the connection is still open", limited.closed === undefined);

/* ------------------------------------------------------------------ */
step("Events: delivered once, listing every channel they matched");

const events = await served({ websocket: { coalesceProgressMs: 0 } }, "events");
const watcher = await connectJobsSocket(events.url);
await watcher.next("hello");
watcher.send({
  op: "subscribe",
  id: "e",
  channels: [
    "all",
    "queues",
    "queue/mail",
    `queue/mail/job/${encodeURIComponent("j1")}`,
  ],
});
await watcher.next("ack");
await events.jobs.queue("mail").add("send", { to: "a" }, { jobId: "j1" });
const added = await watcher.next(
  "event",
  (frame) => frame.event.type === "added",
);
checkEqual("one frame, every matching channel", added.subscriptions, [
  "all",
  "queues",
  "queue/mail",
  "queue/mail/job/j1",
]);
checkEqual(
  "sent exactly once",
  watcher.all("event").filter((frame) => frame.seq === added.seq).length,
  1,
);
checkEqual("the first event is seq 1", added.seq, 1);
checkEqual(
  "under the connection's epoch",
  added.epoch,
  (await watcher.next("hello")).epoch,
);
checkEqual(
  "the envelope is the event, without ns or origin",
  Object.keys(added.event).sort(),
  ["at", "id", "kind", "payload", "target", "type", "v"],
);

// An event-type filter applies to the channels of that subscription.
const filtered = await served({}, "filter");
const picky = await connectJobsSocket(filtered.url);
await picky.next("hello");
picky.send({
  op: "subscribe",
  id: "f",
  channels: ["queue/mail"],
  events: ["removed"],
});
await picky.next("ack");
await filtered.jobs.queue("mail").add("send", {}, { jobId: "x" });
await filtered.jobs.queue("mail").remove("x");
await picky.next("event", (frame) => frame.event.type === "removed");
checkEqual(
  "only the types asked for arrive",
  [...new Set(picky.all("event").map((frame) => frame.event.type))],
  ["removed"],
);

/* ------------------------------------------------------------------ */
step("serialize.event: shaping or dropping an event per session");

const shaped = await served(
  {
    serialize: {
      event: (dto, _event, req) =>
        req.getHeader("x-quiet") && dto.type === "added" ? null : dto,
    },
  },
  "serialize",
);
const quiet = await connectJobsSocket(shaped.url, {
  headers: { "x-quiet": "1" },
});
const loud = await connectJobsSocket(shaped.url);
for (const one of [quiet, loud]) {
  one.send({ op: "subscribe", id: "s", channels: ["queues"] });
  await one.next("ack");
}
await shaped.jobs.queue("mail").add("send", {}, { jobId: "s1" });
await loud.next("event", (frame) => frame.event.type === "added");
// `waiting` follows `added`, so its arrival proves the drop was selective.
await quiet.next("event", (frame) => frame.event.type === "waiting");
check(
  "the hook dropped the event for one session only",
  !quiet.all("event").some((frame) => frame.event.type === "added") &&
    loud.all("event").some((frame) => frame.event.type === "added"),
  {
    quiet: quiet.all("event").map((frame) => frame.event.type),
    loud: loud.all("event").map((frame) => frame.event.type),
  },
);

/* ------------------------------------------------------------------ */
step("coalesceProgressMs: progress is a level, not an edge");

/** Adds a job whose processor reports progress `steps` times. */
async function reportProgress(target: Served, steps: number): Promise<void> {
  const worker = target.jobs.worker("mail", async (job) => {
    for (let step = 1; step <= steps; step++) {
      await job.updateProgress(step);
    }
    return null;
  });
  const running = worker.run();
  await target.jobs.queue("mail").add("report", {}, { jobId: "p1" });
  await waitFor("the job to finish", async () => {
    const counts = await target.jobs.queue("mail").count();
    return counts.completed >= 1;
  });
  await worker.close();
  await running;
}

const everyValue = await served(
  { websocket: { coalesceProgressMs: 0 } },
  "progress-all",
);
const allProgress = await connectJobsSocket(everyValue.url);
await allProgress.next("hello");
allProgress.send({ op: "subscribe", id: "p", channels: ["queue/mail"] });
await allProgress.next("ack");
await reportProgress(everyValue, 5);
await allProgress.next("event", (frame) => frame.event.type === "completed");
checkEqual(
  "coalesceProgressMs: 0 sends every value",
  allProgress.all("event").filter((frame) => frame.event.type === "progress")
    .length,
  5,
);

const coalesced = await served(
  { websocket: { coalesceProgressMs: 10_000 } },
  "progress-few",
);
const fewProgress = await connectJobsSocket(coalesced.url);
await fewProgress.next("hello");
fewProgress.send({ op: "subscribe", id: "p", channels: ["queue/mail"] });
await fewProgress.next("ack");
await reportProgress(coalesced, 5);
await fewProgress.next("event", (frame) => frame.event.type === "completed");
const progressFrames = fewProgress
  .all("event")
  .filter((frame) => frame.event.type === "progress");
const delivered = progressFrames.length;
check(
  "a coalescing window sends fewer, keeping the latest",
  delivered < 5 && delivered >= 1,
  { delivered },
);
// Whatever was held back is flushed before the event that ends the job, so
// progress never arrives after completion.
const order = fewProgress
  .all("event")
  .map((frame) => frame.event.type)
  .filter((type) => type === "progress" || type === "completed");
checkEqual("and never after it", order.at(-1), "completed");

/* ------------------------------------------------------------------ */
step("replay and resume");

const retaining = await served(
  { websocket: { replay: { size: 50 } } },
  "replay",
);
const first = await connectJobsSocket(retaining.url);
const firstHello = await first.next("hello");
first.send({
  op: "subscribe",
  id: "s",
  channels: ["queue/mail"],
  events: ["added"],
});
await first.next("ack");
await retaining.jobs.queue("mail").add("send", {}, { jobId: "r1" });
const seen = await first.next("event", (frame) => frame.event.id === "r1");
first.close();
await waitFor(
  "the session to end",
  () => retaining.api.websocket!.sessions === 0,
);
await retaining.jobs.queue("mail").add("send", {}, { jobId: "r2" });

const resumed = await connectJobsSocket(retaining.url);
await resumed.next("hello");
resumed.send({
  op: "subscribe",
  id: "r",
  channels: ["queue/mail"],
  events: ["added"],
  resume: { epoch: firstHello.epoch, afterSeq: seen.seq },
});
const resumedAck = await resumed.next("ack", (frame) => frame.id === "r");
checkEqual("what was missed is replayed", resumedAck.resumed, true);
checkEqual(
  "oldest first, before the ack",
  resumed.all("event").map((frame) => frame.event.id),
  ["r2"],
);
checkEqual("and no gap is announced", resumed.all("gap").length, 0);

// A `seq` from another instance means nothing here.
resumed.send({
  op: "subscribe",
  id: "moved",
  channels: ["queue/mail"],
  resume: { epoch: "00000000-0000-0000-0000-000000000000", afterSeq: 1 },
});
await resumed.next("ack", (frame) => frame.id === "moved");
const movedGap = await resumed.next(
  "gap",
  (frame) => frame.reason === "epoch-changed",
);
checkEqual("epoch-changed starts from 0", movedGap.fromSeq, 0);

const forgetful = await served({ websocket: { replay: false } }, "no-replay");
const forgotten = await connectJobsSocket(forgetful.url);
const forgottenHello = await forgotten.next("hello");
forgotten.send({ op: "subscribe", id: "s", channels: ["queue/mail"] });
await forgotten.next("ack");
await forgetful.jobs.queue("mail").add("send", {}, { jobId: "n1" });
await forgotten.next("event");
forgotten.send({
  op: "subscribe",
  id: "again",
  channels: ["queue/mail"],
  resume: { epoch: forgottenHello.epoch, afterSeq: 1 },
});
const noReplayAck = await forgotten.next(
  "ack",
  (frame) => frame.id === "again",
);
checkEqual("replay: false can never resume", noReplayAck.resumed, false);
checkEqual(
  "and says so with a gap",
  (await forgotten.next("gap")).reason,
  "resume-expired",
);

/* ------------------------------------------------------------------ */
step("heartbeatMs: liveness, carrying the latest seq");

const beating = await served({ websocket: { heartbeatMs: 50 } }, "heartbeat");
const listener = await connectJobsSocket(beating.url);
await listener.next("hello");
const beat = await listener.next("heartbeat");
check("a heartbeat carries the server's time", beat.at > 0, beat);
checkEqual("and the latest seq stamped", beat.seq, 0);

const still = await served({ websocket: { heartbeatMs: 0 } }, "no-heartbeat");
const quietClient = await connectJobsSocket(still.url);
await quietClient.next("hello");
await Bun.sleep(150);
checkEqual("heartbeatMs: 0 sends none", quietClient.all("heartbeat").length, 0);

/* ------------------------------------------------------------------ */
step("Client limits, and the close codes they use");

checkEqual("the documented close codes", JOBS_API_WS_CLOSE, {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  UNSUPPORTED_DATA: 1003,
  POLICY: 1008,
  TOO_BIG: 1009,
  SLOW_CONSUMER: 4008,
  UNAUTHORIZED: 4401,
});

const strict = await served(
  { websocket: { maxMessageBytes: 128, messagesPerSecond: 1 } },
  "limits",
);
const tooBig = await connectJobsSocket(strict.url);
await tooBig.next("hello");
tooBig.socket.send(JSON.stringify({ op: "ping", id: "x".repeat(200) }));
checkEqual(
  "an oversized frame is refused",
  (await tooBig.next("error")).code,
  "MESSAGE_TOO_LARGE",
);
checkEqual(
  "and closes 1009",
  (await tooBig.waitClosed()).code,
  JOBS_API_WS_CLOSE.TOO_BIG,
);

const binary = await connectJobsSocket(strict.url);
await binary.next("hello");
binary.socket.send(new Uint8Array([123, 125]));
checkEqual(
  "a binary frame closes 1003",
  (await binary.waitClosed()).code,
  JOBS_API_WS_CLOSE.UNSUPPORTED_DATA,
);

const chatty = await connectJobsSocket(strict.url);
await chatty.next("hello");
for (let index = 0; index < 6; index++) {
  chatty.send({ op: "ping", id: `p${index}` });
}
// Awaited, not read: the frames are still in flight the instant after send.
checkEqual(
  "the first breach is an error",
  (await chatty.next("error")).code,
  "RATE_LIMITED",
);
checkEqual(
  "a second within ten seconds closes 1008",
  (await chatty.waitClosed()).code,
  JOBS_API_WS_CLOSE.POLICY,
);

/* ------------------------------------------------------------------ */
step("Malformed frames are answered, not fatal");

const sloppy = await served({}, "malformed");
const clumsy = await connectJobsSocket(sloppy.url);
await clumsy.next("hello");
clumsy.socket.send("{not json");
checkEqual(
  "a frame that is not JSON",
  (await clumsy.next("error")).code,
  "VALIDATION",
);
clumsy.send({ op: "subscribe", id: "no-channels" } as never);
const invalid = await clumsy.next(
  "error",
  (frame) => frame.id === "no-channels",
);
check(
  "a frame that does not match the schema says which field",
  invalid.detail.includes("channels"),
  invalid,
);
clumsy.send({ op: "ping", id: "alive" });
await clumsy.next("pong", (frame) => frame.id === "alive");
check("and the connection carries on", clumsy.closed === undefined);

// What a connection that may not subscribe is told instead: nothing about the
// schema, because that would describe a route it cannot use.
const secretive = await served(
  {
    authorize: (_req, context) =>
      context.action === "events.subscribe"
        ? { allow: false, status: 403 }
        : true,
  },
  "opaque",
);
const stranger = await connectJobsSocket(secretive.url);
await stranger.next("hello");
stranger.socket.send("{not json");
const refusal = await stranger.next("error");
checkEqual("a denied caller gets the denial", refusal.code, "FORBIDDEN");
check(
  "and learns nothing about the protocol",
  !JSON.stringify(stranger.frames).includes("channels"),
  stranger.frames,
);

/* ------------------------------------------------------------------ */
step("unsubscribe, and leaving a channel never held");

const leaving = await served({}, "unsubscribe");
const leaver = await connectJobsSocket(leaving.url);
await leaver.next("hello");
leaver.send({ op: "subscribe", id: "s", channels: ["queues", "queue/mail"] });
await leaver.next("ack", (frame) => frame.id === "s");
leaver.send({
  op: "unsubscribe",
  id: "u",
  channels: ["queue/mail", "queue/never"],
});
const leftAck = await leaver.next("ack", (frame) => frame.id === "u");
checkEqual("the ack names what it left", leftAck.channels, [
  "queue/mail",
  "queue/never",
]);
check("leaving one never held is not an error", leftAck.rejected === undefined);
await leaving.jobs.queue("mail").add("send", {}, { jobId: "after" });
const stillSubscribed = await leaver.next(
  "event",
  (frame) => frame.event.id === "after",
);
checkEqual(
  "the channel it kept still delivers",
  stillSubscribed.subscriptions,
  ["queues"],
);

/* ------------------------------------------------------------------ */
step("websocket.port: a server of its own");

const dedicated = createJobsApi({
  jobs: new BunJobs({
    namespace: "tour-socket-dedicated",
    driver: new MemoryDriver(),
    logger: noopLogger,
    publishEvents: true,
  }),
  basePath: "/admin/jobs",
  authorize: () => true,
  logger: noopLogger,
  // Port 0 asks the OS for one, which `.port` then reports.
  websocket: { port: 0 },
});
const dedicatedPort = dedicated.websocket!.port!;
check(
  "a dedicated port is bound at construction",
  dedicatedPort > 0,
  dedicatedPort,
);
const ownServer = await connectJobsSocket(
  `ws://127.0.0.1:${dedicatedPort}/admin/jobs/ws`,
);
await ownServer.next("hello");
checkEqual("clients connect to it", dedicated.websocket!.sessions, 1);
await checkRejects(
  "attach() has nothing to do when the socket serves itself",
  () => dedicated.websocket!.attach(new BunHttpAdapter(0)),
  { name: "ConfigError", message: /its own server/ },
);
await dedicated.close();
checkEqual(
  "close() tells its clients 1001",
  (await ownServer.waitClosed()).code,
  JOBS_API_WS_CLOSE.GOING_AWAY,
);

/* ------------------------------------------------------------------ */
step("attach() refuses what could never work");

const unattached = createJobsApi({
  jobs: new BunJobs({
    namespace: "tour-socket-attach",
    driver: new MemoryDriver(),
    logger: noopLogger,
  }),
  basePath: "/admin/jobs",
  authorize: () => true,
  logger: noopLogger,
});
// A plain `BunRouter` has no `BunWebSocket`, so a socket attached to it could
// never upgrade — better to say so here than to serve a path that is silent.
await checkRejects(
  "a router with no BunWebSocket could never upgrade",
  () => unattached.websocket!.attach(new BunRouter()),
  { name: "ConfigError", message: /none is attached/ },
);
await unattached.close();
await checkRejects(
  "and attaching after close() is refused",
  () => unattached.websocket!.attach(new BunRouter()),
  { name: "ConfigError", message: /closed/ },
);

/* ------------------------------------------------------------------ */
step("close(): sessions are told 1001, the context is left alone");

const closing = await served({}, "closing");
const lastClient = await connectJobsSocket(closing.url);
await lastClient.next("hello");
lastClient.send({ op: "subscribe", id: "s", channels: ["queues"] });
await lastClient.next("ack");
await closing.api.close();
checkEqual(
  "the session is closed going-away",
  (await lastClient.waitClosed()).code,
  JOBS_API_WS_CLOSE.GOING_AWAY,
);
checkEqual("and the API reports none", closing.api.websocket!.sessions, 0);
checkEqual(
  "a new upgrade is refused",
  (await refusedUpgrade(closing.origin)).status,
  404,
);
await closing.jobs.queue("still-here").add("send", {});
check(
  "while the context goes on working",
  (await closing.jobs.listQueues()).includes("still-here"),
);

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const cleanup of cleanups.splice(0).reverse()) {
  await cleanup();
}

summary();
