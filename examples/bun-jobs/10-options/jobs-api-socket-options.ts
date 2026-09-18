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
import type {
  EventWire,
  JobsApiEventMessage,
} from "@kingsleyweb/bun-jobs/api/contract";
import type { Server, ServerWebSocket } from "bun";
import { BunHttpAdapter, BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_SUBPROTOCOL,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { JOBS_API_WS_MAX_CHANNELS_PER_FRAME } from "@kingsleyweb/bun-jobs/api/contract";
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
  const body = (await response.json()) as {
    code: string;
    status: number;
    title: string;
  };
  return { status: response.status, body, headers: response.headers };
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
await negotiated.waitClosed();
// Left to itself, a WebSocket server answers with the FIRST protocol offered;
// the API names its own whenever the client offered any, wherever it sits in
// the list.
const secondChoice = await connectJobsSocket(greeting.url, {
  protocols: ["other", JOBS_API_WS_SUBPROTOCOL],
});
checkEqual(
  'offered second, after "other", it is still the one negotiated',
  secondChoice.socket.protocol,
  JOBS_API_WS_SUBPROTOCOL,
);
secondChoice.close();
await secondChoice.waitClosed();
const noProtocol = await connectJobsSocket(greeting.url);
checkEqual("offering none negotiates none", noProtocol.socket.protocol, "");
noProtocol.close();
await noProtocol.waitClosed();
const wrongProtocol = await refusedUpgrade(greeting.origin, {
  "Sec-WebSocket-Protocol": "chat, mqtt",
});
checkEqual(
  "a list without it is refused before any socket exists",
  [wrongProtocol.status, wrongProtocol.body.code, wrongProtocol.body.title],
  [400, "UNSUPPORTED_SUBPROTOCOL", "Unsupported WebSocket subprotocol"],
);
checkEqual(
  "as an RFC 9457 problem",
  wrongProtocol.headers.get("content-type")?.split(";")[0],
  "application/problem+json",
);
await waitFor(
  "the probing sessions to end",
  () => greeting.api.websocket!.sessions === 1,
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
  [full.status, full.body.code, full.body.title],
  [429, "CONNECTION_LIMIT", "Too many live-event connections"],
);
checkEqual("and says when to try again", full.headers.get("retry-after"), "1");
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
    // Percent-escapes in lower case: the same channel as `x%2Fy`.
    "queue/secret/job/x%2fy",
    "queue/not a name",
    "nonsense",
    // Duplicates: accepted once, in canonical form.
    "queue/mail",
    "queue/mail/job/a%2fb",
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
// client sent them in. Each refusal names the channel exactly as the client
// spelled it — not canonicalised — so a client can match it to what it sent.
checkEqual(
  "and every refusal, with its own reason, echoing the client's spelling",
  ack.rejected?.map((rejection) => [
    rejection.channel,
    rejection.code,
    rejection.status,
  ]),
  [
    ["queue/not a name", "INVALID_CHANNEL", 400],
    ["nonsense", "INVALID_CHANNEL", 400],
    ["queue/secret", "FORBIDDEN", 403],
    ["queue/secret/job/x%2fy", "FORBIDDEN", 403],
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
checkEqual("each channel held is authorized once", asked, ["queues"]);
// The decision is kept only while the channel is held.
repeat.send({ op: "unsubscribe", id: "c", channels: ["queues"] });
await repeat.next("ack", (frame) => frame.id === "c");
repeat.send({ op: "subscribe", id: "d", channels: ["queues"] });
await repeat.next("ack", (frame) => frame.id === "d");
checkEqual("leaving a channel forgets it: asked again", asked, [
  "queues",
  "queues",
]);

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

/** Channels `authorize` was asked about on the capped API. */
const cappedAsks: string[] = [];
const fewChannels = await served(
  {
    websocket: { maxSubscriptions: 2 },
    authorize: (_req, context) => {
      if (context.action === "events.subscribe" && context.channel) {
        cappedAsks.push(context.channel);
      }
      return true;
    },
  },
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
// The cap is applied before `authorize`, so one frame costs at most as many
// decisions as there are free slots — never one per channel named.
checkEqual("authorize was asked only about what fitted", cappedAsks, [
  "queues",
  "queue/mail",
]);

/* ------------------------------------------------------------------ */
step("A frame names at most 256 channels");

// The bound is `JOBS_API_WS_MAX_CHANNELS_PER_FRAME` in the browser-safe
// contract, and the AsyncAPI document's `x-bun-jobs-limits` publishes it.
const MAX_CHANNELS_PER_FRAME = JOBS_API_WS_MAX_CHANNELS_PER_FRAME;
checkEqual(
  "the AsyncAPI document publishes the same bound",
  (
    defaults.api.asyncapi()!.channels as Record<
      string,
      { "x-bun-jobs-limits"?: { maxChannelsPerFrame: number } }
    >
  ).connection!["x-bun-jobs-limits"]!.maxChannelsPerFrame,
  MAX_CHANNELS_PER_FRAME,
);
checkEqual("maxChannelsPerFrame is 256", MAX_CHANNELS_PER_FRAME, 256);
const wide = await served(
  { websocket: { maxSubscriptions: 3, maxMessageBytes: 65_536 } },
  "per-frame",
);
const wideClient = await connectJobsSocket(wide.url);
await wideClient.next("hello");
/** `count` distinct queue channels. */
const manyChannels = (count: number) =>
  Array.from({ length: count }, (_, index) => `queue/q${index}`);
wideClient.send({
  op: "subscribe",
  id: "too-many",
  channels: manyChannels(MAX_CHANNELS_PER_FRAME + 1),
});
const tooMany = await wideClient.next(
  "error",
  (frame) => frame.id === "too-many",
);
checkEqual(
  "257 is a VALIDATION error, echoing the id",
  tooMany.code,
  "VALIDATION",
);
check(
  "naming the field (the wording is not a contract)",
  tooMany.detail.includes("channels"),
  tooMany,
);
wideClient.send({
  op: "subscribe",
  id: "just-enough",
  channels: manyChannels(MAX_CHANNELS_PER_FRAME),
});
const justEnough = await wideClient.next(
  "ack",
  (frame) => frame.id === "just-enough",
);
checkEqual("256 is a valid frame", justEnough.channels.length, 3);
checkEqual(
  "and the rest are refused by the subscription cap",
  justEnough.rejected?.length,
  MAX_CHANNELS_PER_FRAME - 3,
);
check("the connection is still open", wideClient.closed === undefined);

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
step("Broad channels: each queue is authorized on its first event");

// `all`, `queues` and `runners` carry every target's events, so a host that
// denies one queue would leak it there. Each target is therefore authorized
// again, per broad channel, on its first event:
// `{ action: "events.subscribe", transport: "ws", channel: "queues", queue }`.
const slowDecision = Promise.withResolvers<boolean>();
const floodDecision = Promise.withResolvers<boolean>();
/** Per-target decisions asked for, as `<channel> <queue>`. */
const broadAsks: string[] = [];
/** The first per-target context `authorize` received, whole. */
let firstTargetContext: unknown;
const broad = await served(
  {
    authorize: async (_req, context) => {
      if (context.action !== "events.subscribe" || !context.queue) {
        return true;
      }
      broadAsks.push(`${context.channel} ${context.queue}`);
      firstTargetContext ??= { ...context };
      if (context.queue === "secret") {
        return { allow: false, reason: "not yours" };
      }
      // Two decisions the tour releases by hand, to show what waits on them.
      if (context.queue === "slow") {
        return await slowDecision.promise;
      }
      if (context.queue === "flood") {
        return await floodDecision.promise;
      }
      return true;
    },
    websocket: { coalesceProgressMs: 0 },
  },
  "broad",
);
const everyQueue = await connectJobsSocket(broad.url);
await everyQueue.next("hello");
everyQueue.send({ op: "subscribe", id: "b", channels: ["queues"] });
await everyQueue.next("ack", (frame) => frame.id === "b");
await broad.jobs.queue("fast").add("send", {}, { jobId: "f1" });
await everyQueue.next(
  "event",
  (frame) => frame.event.id === "f1" && frame.event.type === "waiting",
);
checkEqual("fast's first event asked about fast", broadAsks, ["queues fast"]);
checkEqual(
  "the decision names the broad channel and the queue",
  firstTargetContext,
  {
    channel: "queues",
    queue: "fast",
    action: "events.subscribe",
    transport: "ws",
    mutation: false,
  },
);

// While `slow`'s decision is pending, its events wait — and so does every
// event stamped after them, so delivery stays in `seq` order.
await broad.jobs.queue("slow").add("send", {}, { jobId: "s1" });
await broad.jobs.queue("fast").add("send", {}, { jobId: "f2" });
await broad.jobs.queue("secret").add("send", {}, { jobId: "x1" });
await waitFor("slow's decision to be asked for", () => {
  return broadAsks.includes("queues slow");
});
everyQueue.send({ op: "ping", id: "held" });
await everyQueue.next("pong", (frame) => frame.id === "held");
check(
  "a pending decision holds its target's events, and the ones after them",
  !everyQueue
    .all("event")
    .some((frame) => ["s1", "f2"].includes(frame.event.id ?? "")),
  everyQueue.all("event").map((frame) => frame.event.id),
);
slowDecision.resolve(true);
await everyQueue.next(
  "event",
  (frame) => frame.event.id === "f2" && frame.event.type === "waiting",
);
await waitFor("secret's decision to be asked for", () => {
  return broadAsks.includes("queues secret");
});
everyQueue.send({ op: "ping", id: "released" });
await everyQueue.next("pong", (frame) => frame.id === "released");
const broadSeqs = everyQueue.all("event").map((frame) => frame.seq);
checkEqual(
  "once allowed, they arrive in seq order",
  broadSeqs,
  broadSeqs.toSorted((a, b) => a - b),
);
checkEqual(
  "slow's events first, then fast's",
  everyQueue
    .all("event")
    .map((frame) => `${frame.event.id}:${frame.event.type}`)
    .slice(-4),
  ["s1:added", "s1:waiting", "f2:added", "f2:waiting"],
);
check(
  "a denied queue never appears on the broad channel",
  !everyQueue.all("event").some((frame) => frame.event.target === "secret"),
);
checkEqual("each queue was asked about once", broadAsks, [
  "queues fast",
  "queues slow",
  "queues secret",
]);
everyQueue.close();
await everyQueue.waitClosed();

// A decision that never comes must not grow a session without bound: past a
// thousand held events the connection lags, and gets a `slow-consumer` gap —
// the same signal as a client that cannot keep up.
const flooded = await connectJobsSocket(broad.url);
await flooded.next("hello");
flooded.send({ op: "subscribe", id: "f", channels: ["queues"] });
await flooded.next("ack", (frame) => frame.id === "f");
const flood = broad.jobs.queue("flood");
// Two events per add (`added`, `waiting`): 520 adds hold 1040.
for (let index = 0; index < 520; index++) {
  await flood.add("send", {});
}
floodDecision.resolve(true);
const floodGap = await flooded.next("gap");
checkEqual(
  "more than 1000 held is a slow-consumer gap",
  floodGap.reason,
  "slow-consumer",
);
check("covering a range of seqs", floodGap.toSeq >= floodGap.fromSeq, floodGap);
await broad.jobs.queue("fast").add("send", {}, { jobId: "after-flood" });
await flooded.next("event", (frame) => frame.event.id === "after-flood");
check("and the connection carries on", flooded.closed === undefined);

/* ------------------------------------------------------------------ */
step("Job ids encodeURIComponent cannot encode");

// A lone UTF-16 surrogate is a legal JavaScript string but not valid UTF-8,
// so `encodeURIComponent` throws on it — and a job with such an id used to
// take the process down with it. Job channels write it `%uXXXX` instead.
const lone = "inv-\uD800-1";
await checkRejects(
  "encodeURIComponent refuses a lone surrogate",
  () => encodeURIComponent(lone),
  { name: "URIError" },
);
const surrogates = await served({}, "surrogate");
const surrogateClient = await connectJobsSocket(surrogates.url);
await surrogateClient.next("hello");
// Every other character is escaped exactly as `encodeURIComponent` escapes
// it, and a `%` always becomes `%25`, so the two forms cannot be confused.
const loneChannel = "queue/mail/job/inv-%uD800-1";
surrogateClient.send({
  op: "subscribe",
  id: "s",
  channels: [
    loneChannel,
    // The hex digits may come in either case; the canonical form is upper.
    "queue/mail/job/inv-%ud800-1",
    // `%u` is only for a surrogate: anything else has a standard escape.
    "queue/mail/job/inv-%u0041",
  ],
});
const loneAck = await surrogateClient.next("ack", (frame) => frame.id === "s");
checkEqual(
  "its channel is accepted, once, in canonical form",
  loneAck.channels,
  [loneChannel],
);
checkEqual(
  "while %u for a character that is not a surrogate is malformed",
  loneAck.rejected?.map((rejection) => [rejection.channel, rejection.code]),
  [["queue/mail/job/inv-%u0041", "INVALID_CHANNEL"]],
);
await surrogates.jobs.queue("mail").add("send", {}, { jobId: lone });
const loneEvent = await surrogateClient.next(
  "event",
  (frame) => frame.event.type === "added",
);
checkEqual("and its events arrive there", loneEvent.subscriptions, [
  loneChannel,
]);
checkEqual("carrying the id intact", loneEvent.event.id, lone);

// The fatal path was coalesced progress: held back, then flushed from a
// timer, where a throw has no caller to catch it and ends the process. Here
// the second value is held, and the processor waits until the timer has
// delivered it before it lets the job finish.
const coalescing = await served(
  { websocket: { coalesceProgressMs: 50 } },
  "surrogate-progress",
);
const progressWatcher = await connectJobsSocket(coalescing.url);
await progressWatcher.next("hello");
progressWatcher.send({ op: "subscribe", id: "p", channels: [loneChannel] });
await progressWatcher.next("ack", (frame) => frame.id === "p");
/** The progress values the watcher has received for the lone-surrogate job. */
const progressValues = () =>
  progressWatcher
    .all("event")
    .filter((frame) => frame.event.type === "progress")
    .map((frame) => (frame.event.payload as { progress: unknown }).progress);
const reporter = coalescing.jobs.worker("mail", async (job) => {
  await job.updateProgress(1);
  await job.updateProgress(2);
  await waitFor("the coalescing timer to flush progress 2", () => {
    return progressValues().includes(2);
  });
  return null;
});
const reporting = reporter.run();
await coalescing.jobs.queue("mail").add("report", {}, { jobId: lone });
await progressWatcher.next(
  "event",
  (frame) => frame.event.type === "completed",
);
await reporter.close();
await reporting;
checkEqual(
  "progress held for such a job is flushed by the timer, and the process lives",
  progressValues(),
  [1, 2],
);

/* ------------------------------------------------------------------ */
step("Subscriptions are not reference-counted");

const replacing = await served({}, "last-wins");
const fickle = await connectJobsSocket(replacing.url);
await fickle.next("hello");
fickle.send({
  op: "subscribe",
  id: "first",
  channels: ["queue/mail"],
  events: ["added"],
});
await fickle.next("ack", (frame) => frame.id === "first");
// The same channel again, with another filter: it replaces, it does not merge.
fickle.send({
  op: "subscribe",
  id: "second",
  channels: ["queue/mail"],
  events: ["removed"],
});
await fickle.next("ack", (frame) => frame.id === "second");
await replacing.jobs.queue("mail").add("send", {}, { jobId: "lw1" });
await replacing.jobs.queue("mail").remove("lw1");
// `removed` is stamped after `added`, and events arrive in `seq` order, so
// by now an `added` would have arrived too.
await fickle.next("event", (frame) => frame.event.type === "removed");
checkEqual(
  "the last subscribe wins: only its filter applies",
  fickle.all("event").map((frame) => frame.event.type),
  ["removed"],
);

// Subscribed three times over, left once.
for (const id of ["a", "b", "c"]) {
  fickle.send({ op: "subscribe", id, channels: ["queue/mail"] });
  await fickle.next("ack", (frame) => frame.id === id);
}
fickle.send({ op: "subscribe", id: "beacon", channels: ["queue/beacon"] });
await fickle.next("ack", (frame) => frame.id === "beacon");
fickle.send({ op: "unsubscribe", id: "leave", channels: ["queue/mail"] });
await fickle.next("ack", (frame) => frame.id === "leave");
const beforeLeaving = fickle.all("event").length;
await replacing.jobs.queue("mail").add("send", {}, { jobId: "lw2" });
// A later event on a channel still held: once it is here, anything for
// `queue/mail` stamped before it would be too.
await replacing.jobs.queue("beacon").add("send", {}, { jobId: "b1" });
await fickle.next("event", (frame) => frame.event.id === "b1");
checkEqual(
  "one unsubscribe removes it, however often it was subscribed",
  fickle
    .all("event")
    .slice(beforeLeaving)
    .filter((frame) => frame.event.target === "mail").length,
  0,
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

// A `seq` beyond anything this server stamped was never part of its history,
// so it is answered exactly as a foreign epoch is.
resumed.send({
  op: "subscribe",
  id: "ahead",
  channels: ["queue/mail"],
  resume: { epoch: firstHello.epoch, afterSeq: 1_000_000 },
});
const aheadAck = await resumed.next("ack", (frame) => frame.id === "ahead");
checkEqual(
  "a resume ahead of the server is not resumed",
  aheadAck.resumed,
  false,
);
const aheadGap = await resumed.next(
  "gap",
  (frame) => frame !== movedGap && frame.reason === "epoch-changed",
);
checkEqual(
  "it gets an epoch-changed gap from 0",
  [aheadGap.reason, aheadGap.fromSeq],
  ["epoch-changed", 0],
);

// A resume never re-sends a `seq` this connection already has. Here the
// client holds `added` for r3 (its filter let nothing else through), then
// resumes from 0 with every type: `waiting` is replayed, `added` is not.
const once = await connectJobsSocket(retaining.url);
const onceHello = await once.next("hello");
once.send({
  op: "subscribe",
  id: "live",
  channels: ["queue/mail"],
  events: ["added"],
});
await once.next("ack", (frame) => frame.id === "live");
await retaining.jobs.queue("mail").add("send", {}, { jobId: "r3" });
const liveAdded = await once.next("event", (frame) => frame.event.id === "r3");
once.send({
  op: "subscribe",
  id: "again",
  channels: ["queue/mail"],
  resume: { epoch: onceHello.epoch, afterSeq: liveAdded.seq - 1 },
});
const againAck = await once.next("ack", (frame) => frame.id === "again");
checkEqual("it resumes", againAck.resumed, true);
const r3Frames = once
  .all("event")
  .filter((frame) => frame.event.id === "r3")
  .map((frame) => `${frame.seq}:${frame.event.type}`);
checkEqual("replaying only what it had not been sent", r3Frames, [
  `${liveAdded.seq}:added`,
  `${liveAdded.seq + 1}:waiting`,
]);
const seqs = once.all("event").map((frame) => frame.seq);
checkEqual("no seq arrives twice", new Set(seqs).size, seqs.length);

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
step("A resume while lagging is not resumed: the gap covers it");

// Backpressure cannot be provoked on demand over loopback, so this API is
// served by a raw `Bun.serve` whose socket handler sees each connection
// through a view: while `stalled`, the view reports what a congested socket
// reports — `send()` answers `-1` (queued under backpressure) and the buffer
// is over any threshold — though every frame is still really written.
const slowJobs = new BunJobs({
  namespace: "tour-socket-lagging",
  driver: new MemoryDriver(),
  logger: noopLogger,
  publishEvents: true,
});
const slowApi = createJobsApi({
  jobs: slowJobs,
  basePath: "/admin/jobs",
  authorize: () => true,
  logger: noopLogger,
  websocket: { heartbeatMs: 0 },
});

/** A server socket as the API's handler is given it. */
type ApiSocket = Parameters<
  NonNullable<(typeof slowApi.websocket & {})["handler"]["open"]>
>[0];

/** One connection's view, and whether it is pretending to be congested. */
interface View {
  /** What the API's handler sees. */
  socket: ApiSocket;
  /** Set to report backpressure. */
  stalled: boolean;
  /** Times an event frame found the buffer over the limit while stalled. */
  skipped: number;
}

/** Each real socket's view, created on open and reused for every call. */
const views = new WeakMap<object, View>();
/** Views in the order their connections opened. */
const opened: View[] = [];

/** The view of a real server socket. */
function viewOf(ws: ServerWebSocket<unknown>): View {
  let view = views.get(ws);
  if (!view) {
    const created: View = {
      stalled: false,
      skipped: 0,
      socket: {
        get data() {
          return ws.data;
        },
        get readyState() {
          return ws.readyState;
        },
        send: (text: string) => {
          const written = ws.send(text);
          return created.stalled ? -1 : written;
        },
        getBufferedAmount: () => {
          if (!created.stalled) {
            return ws.getBufferedAmount();
          }
          // Only an event frame's send asks while stalled: it is skipped.
          created.skipped++;
          return Number.MAX_SAFE_INTEGER;
        },
        close: (code?: number, reason?: string) => ws.close(code, reason),
      } as unknown as ApiSocket,
    };
    view = created;
    views.set(ws, view);
    opened.push(view);
  }
  return view;
}

const slowHandler = slowApi.websocket!.handler;
const slowServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req, server) => {
    const answer = await slowApi.websocket!.upgrade(
      req,
      server as unknown as Server<ApiSocket["data"]>,
    );
    // `null`: not an upgrade for this socket; `undefined`: upgraded.
    return answer === null ? new Response(null, { status: 404 }) : answer;
  },
  websocket: {
    open: (ws) => slowHandler.open?.(viewOf(ws).socket),
    message: (ws, message) => slowHandler.message?.(viewOf(ws).socket, message),
    close: (ws, code, reason) =>
      slowHandler.close?.(viewOf(ws).socket, code, reason),
    drain: (ws) => slowHandler.drain?.(viewOf(ws).socket),
  },
});
cleanups.push(async () => {
  await slowApi.close();
  await slowServer.stop(true);
  await slowJobs.close();
});
const slowUrl = `ws://127.0.0.1:${slowServer.port}${slowApi.websocket!.path}`;

const behind = await connectJobsSocket(slowUrl);
const behindHello = await behind.next("hello");
const behindView = opened.at(-1)!;
behind.send({ op: "subscribe", id: "a", channels: ["queue/a"] });
await behind.next("ack", (frame) => frame.id === "a");

// A second, healthy connection learns which seqs queue/b's events get. It
// offers our subprotocol second: the raw `upgrade()` path names it too.
const probe = await connectJobsSocket(slowUrl, {
  protocols: ["other", JOBS_API_WS_SUBPROTOCOL],
});
await probe.next("hello");
checkEqual(
  'raw Bun.serve: ["other", "bun-jobs.v1"] negotiates bun-jobs.v1',
  probe.socket.protocol,
  JOBS_API_WS_SUBPROTOCOL,
);
probe.send({ op: "subscribe", id: "b", channels: ["queue/b"] });
await probe.next("ack", (frame) => frame.id === "b");
await slowJobs.queue("b").add("send", {}, { jobId: "b1" });
await slowJobs.queue("b").add("send", {}, { jobId: "b2" });
await waitFor(
  "the probe to see queue b's four events",
  () => probe.all("event").length === 4,
);
const bSeqs = probe.all("event").map((frame) => frame.seq);

// Now the first connection falls behind on queue/a.
behindView.stalled = true;
await slowJobs.queue("a").add("send", {}, { jobId: "a1" });
// The first of a1's events finds the buffer full and is skipped: from then
// on the session is lagging, and skips without asking again.
await waitFor("a1's first event to be skipped", () => behindView.skipped >= 1);

// While it lags, it subscribes to queue/b, resuming from the start: every
// one of b's events is still in the replay ring.
behind.send({
  op: "subscribe",
  id: "resume",
  channels: ["queue/b"],
  resume: { epoch: behindHello.epoch, afterSeq: behindHello.seq },
});
const laggingAck = await behind.next("ack", (frame) => frame.id === "resume");
checkEqual(
  "resumed: false — the replay could not be sent",
  laggingAck.resumed,
  false,
);
checkEqual("and none of it was", behind.all("event").length, 0);

// The socket drains: one gap, covering the replay as well as the live events.
behindView.stalled = false;
slowHandler.drain?.(behindView.socket);
const lagGap = await behind.next("gap");
checkEqual("a slow-consumer gap", lagGap.reason, "slow-consumer");
check(
  "covering every seq of queue b the resume could not send",
  bSeqs.every((seq) => seq >= lagGap.fromSeq && seq <= lagGap.toSeq),
  { gap: lagGap, bSeqs },
);
await slowJobs.queue("a").add("send", {}, { jobId: "a2" });
await behind.next("event", (frame) => frame.event.id === "a2");
check("then it is live again", behind.closed === undefined);
behind.close();
probe.close();

/* ------------------------------------------------------------------ */
step("heartbeatMs: liveness, carrying the latest seq");

const beating = await served({ websocket: { heartbeatMs: 50 } }, "heartbeat");
const listener = await connectJobsSocket(beating.url);
await listener.next("hello");
const beat = await listener.next("heartbeat");
check("a heartbeat carries the server's time", beat.at > 0, beat);
checkEqual("and the latest seq stamped", beat.seq, 0);

// `seq` is global — it counts every channel's events, not this connection's —
// so a heartbeat's jump is not a loss. Only a `gap` says events were missed.
const narrowBeat = await connectJobsSocket(beating.url);
await narrowBeat.next("hello");
narrowBeat.send({ op: "subscribe", id: "s", channels: ["queue/quiet"] });
await narrowBeat.next("ack", (frame) => frame.id === "s");
await beating.jobs.queue("busy").add("send", {});
const jumped = await narrowBeat.next("heartbeat", (frame) => frame.seq >= 2);
check(
  "the heartbeat seq moved past events this client never subscribed to",
  jumped.seq >= 2,
  jumped,
);
checkEqual(
  "without an event or a gap: nothing was missed",
  [narrowBeat.all("event").length, narrowBeat.all("gap").length],
  [0, 0],
);

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
const breach = await chatty.next("error");
checkEqual("the first breach is an error", breach.code, "RATE_LIMITED");
// Two tokens of burst at one per second: p0 and p1 pass, p2 is refused — and
// the error names it, so a client awaiting p2's answer is not left waiting.
checkEqual("echoing the refused request's id", breach.id, "p2");
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
// The dedicated server negotiates the subprotocol the same way.
const ownNegotiated = await connectJobsSocket(
  `ws://127.0.0.1:${dedicatedPort}/admin/jobs/ws`,
  { protocols: ["other", JOBS_API_WS_SUBPROTOCOL] },
);
checkEqual(
  'its own port negotiates bun-jobs.v1 from ["other", "bun-jobs.v1"] too',
  ownNegotiated.socket.protocol,
  JOBS_API_WS_SUBPROTOCOL,
);
ownNegotiated.close();
await ownNegotiated.waitClosed();
const ownRefused = await refusedUpgrade(`http://127.0.0.1:${dedicatedPort}`, {
  "Sec-WebSocket-Protocol": "chat",
});
checkEqual(
  "and refuses a list without it",
  [ownRefused.status, ownRefused.body.code],
  [400, "UNSUPPORTED_SUBPROTOCOL"],
);
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
step("An event frame is typed exactly as it is sent");

// An event frame's `event` is an `EventWire`, typed here from the contract
// entry point a browser client imports. It narrows by `kind` and `type` like a `DriverEvent`,
// but a payload's `error` is the `ErrorDto` actually sent — `stack` only with
// `serialize.exposeStacks` — not the in-process `SerializedError`, and `ns` /
// `origin` are not on the wire at all.
/** The failure message an event frame carries, when it is a failure. */
function failureOf(frame: JobsApiEventMessage): string | undefined {
  const event: EventWire = frame.event;
  return event.kind === "queue" && event.type === "failed"
    ? event.payload.error.message
    : undefined;
}
checkEqual(
  "a failed event's error, read through the frame's type",
  failureOf({
    type: "event",
    seq: 1,
    epoch: "e",
    subscriptions: ["queue/mail"],
    event: {
      v: 1,
      kind: "queue",
      type: "failed",
      target: "mail",
      at: 0,
      payload: { id: "m1", error: { name: "Error", message: "boom" } },
    },
  }),
  "boom",
);

/* ------------------------------------------------------------------ */
step("The AsyncAPI document: limits, close codes and refusals");

/** The parts of the AsyncAPI document this step reads. */
interface SocketDocument {
  /** The channels, by id. */
  channels: Record<
    string,
    { messages: Record<string, unknown> } & Record<string, unknown>
  >;
  /** The servers, by id. */
  servers: Record<string, Record<string, unknown>>;
}

const document = defaults.api.asyncapi() as unknown as SocketDocument;
const connection = document.channels.connection!;
checkEqual(
  "x-bun-jobs-limits: every bound a connection is held to",
  connection["x-bun-jobs-limits"],
  {
    maxMessageBytes: 16_384,
    messagesPerSecond: 20,
    rateLimitBurst: 40,
    rateLimitBreachWindowMs: 10_000,
    maxSubscriptions: 50,
    maxChannelsPerFrame: MAX_CHANNELS_PER_FRAME,
    maxConnections: 1000,
    heartbeatMs: 25_000,
    maxBufferedBytes: 1_048_576,
    slowConsumerTimeoutMs: 30_000,
    coalesceProgressMs: 250,
    replay: { size: 1000, maxAgeMs: 300_000 },
  },
);
checkEqual(
  "x-bun-jobs-close-codes: each code the server sends, by name",
  (
    connection["x-bun-jobs-close-codes"] as { code: number; name: string }[]
  ).map((entry) => [entry.code, entry.name]),
  Object.entries(JOBS_API_WS_CLOSE)
    .filter(([name]) => name !== "NORMAL")
    .map(([name, code]) => [code, name]),
);
checkEqual(
  "x-bun-jobs-upgrade-refusals: how an upgrade is refused before any socket",
  (
    connection["x-bun-jobs-upgrade-refusals"] as {
      status: number;
      code: string;
      contentType: string;
    }[]
  ).map((entry) => [entry.status, entry.code, entry.contentType]),
  [
    [400, "UNSUPPORTED_SUBPROTOCOL", "application/problem+json"],
    [403, "ORIGIN_REJECTED", "application/problem+json"],
    [429, "CONNECTION_LIMIT", "application/problem+json"],
    [401, "UNAUTHORIZED", "application/problem+json"],
    [403, "FORBIDDEN", "application/problem+json"],
    [404, "ROUTE_NOT_FOUND", "application/problem+json"],
  ],
);

// The job channel lists only what can reach one job: the queue-level events
// never do.
const jobMessages = Object.keys(document.channels.job!.messages);
const queueMessages = Object.keys(document.channels.queue!.messages);
checkEqual(
  "the job channel has its own message list, without the queue-level events",
  queueMessages.filter((name) => !jobMessages.includes(name)).sort(),
  ["queue.drained", "queue.paused", "queue.repeatScheduled", "queue.resumed"],
);
check(
  "and with the multi-job events",
  ["queue.stalled", "queue.retried", "queue.cleaned"].every((name) =>
    jobMessages.includes(name),
  ),
  jobMessages,
);

// AsyncAPI 3 cannot say "these two schemes together": a requirement naming
// one scheme is listed natively, and the verbatim list, with OpenAPI's
// meaning, is kept alongside.
const documented = createJobsApi({
  jobs: new BunJobs({
    namespace: "tour-socket-security",
    driver: new MemoryDriver(),
    logger: noopLogger,
  }),
  basePath: "/admin/jobs",
  authorize: () => true,
  logger: noopLogger,
  docs: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
      bearer: { type: "http", scheme: "bearer" },
    },
    security: [{ apiKey: [] }, { apiKey: [], bearer: [] }],
  },
});
const securedDocument = documented.asyncapi() as unknown as SocketDocument;
const securedServer = securedDocument.servers.api!;
checkEqual(
  "servers.api.security lists only the single-scheme requirements",
  securedServer.security,
  [{ $ref: "#/components/securitySchemes/apiKey" }],
);
checkEqual(
  "x-bun-jobs-security keeps every requirement verbatim",
  securedServer["x-bun-jobs-security"],
  [{ apiKey: [] }, { apiKey: [], bearer: [] }],
);
await documented.close();

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const cleanup of cleanups.splice(0).reverse()) {
  await cleanup();
}

summary();
