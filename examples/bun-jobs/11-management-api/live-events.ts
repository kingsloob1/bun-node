/**
 * The live-events socket: connect, subscribe to several channels, read events
 * as they happen, and resume after a disconnect.
 *
 * ```bash
 * bun 11-management-api/live-events.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 11-management-api/live-events.ts
 * ```
 *
 * One socket at `<basePath>/ws` carries every channel, multiplexed by name:
 * `all`, `queues`, `queue/{q}`, `queue/{q}/job/{id}`, `runners`,
 * `runner/{r}`. This example needs a real server, because a WebSocket needs a
 * socket — the HTTP examples use `adapter.fetch()` instead.
 *
 * The four things worth understanding:
 *
 * - **Every subscription is authorized separately.** One refused channel does
 *   not close the connection or fail the others: it comes back in the `ack`'s
 *   `rejected` list with its own code.
 * - **`seq` is meaningful only within an `epoch`.** The epoch is random per
 *   API instance, so a `seq` from one process means nothing to another.
 * - **An event matching several of your channels arrives once**, listing every
 *   subscription it matched in `subscriptions`.
 * - **Events are invalidation hints, not a log.** They carry only what
 *   producers publish (`publishEvents: true` here), and a `gap` says "you may
 *   have missed something — refetch over HTTP". HTTP stays the source of
 *   truth.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";
import { connectJobsSocket } from "./helpers/jobs-socket";

/** What an invoice job carries. */
interface Invoice {
  /** The invoice to send. */
  invoiceId: string;
}

title("The management API: live events");

/* ------------------------------------------------------------------ */
step("A publishing context, and an API with a socket");

// `publishEvents` is what makes the events reach the notifier the socket
// listens to. It is off by default, because each event costs a write on
// backends that store them — and it must be on in every process that
// produces events, not only the one serving this API.
const jobs = new BunJobs({
  namespace: exampleNamespace("live"),
  driver: exampleDriver(),
  publishEvents: true,
});

// A worker consuming `billing`, so there is something to emit events. (
// `jobs.start()` would run the registry worker, which consumes the registry
// queue rather than this one.)
const worker = jobs.worker<Invoice, { sent: true }>(
  "billing",
  async (job) => {
    await job.updateProgress(50);
    return { sent: true };
  },
  { concurrency: 1, pollInterval: 25 },
);

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  // A real deployment decides from a session or a token; this example is
  // about the socket, so every action is allowed.
  authorize: () => true,
  websocket: {
    // Every socket option has a sensible default; these two only make the
    // example quick to read.
    heartbeatMs: 200,
    coalesceProgressMs: 0,
  },
});

const adapter = new BunHttpAdapter(0);
adapter.use(api.basePath, api.router);
// `attach()` registers the upgrade guard on the adapter's `BunWebSocket`.
// Order against the mount does not matter; order against a catch-all
// WebSocket route does — see the note in the package README.
api.websocket!.attach(adapter);

const server = await adapter.listen(0);
const url = `ws://127.0.0.1:${server.port}${api.websocket!.path}`;
show("serving the socket at", url);

/* ------------------------------------------------------------------ */
step("Connect: the server greets with hello");

const client = await connectJobsSocket(url);
const hello = await client.next("hello");
show("hello", hello);
show("live sessions", api.websocket!.sessions);

/* ------------------------------------------------------------------ */
step("Subscribe to several channels at once");

client.send({
  op: "subscribe",
  id: "s1",
  channels: [
    "queues",
    "queue/billing",
    // A job channel: the id is percent-encoded, because ids may contain "/".
    `queue/billing/job/${encodeURIComponent("inv/1")}`,
    "runners",
    // Two the server will refuse, for different reasons.
    "queue/not a name",
    "nonsense",
  ],
});

const ack = await client.next("ack", (frame) => frame.id === "s1");
show("accepted", ack.channels);
show(
  "refused, one entry each",
  ack.rejected?.map((rejection) => ({
    channel: rejection.channel,
    code: rejection.code,
    status: rejection.status,
  })),
);

/* ------------------------------------------------------------------ */
step("Events arrive as work happens");

const billing = jobs.queue<Invoice>("billing");
await billing.add("send-invoice", { invoiceId: "inv/1" }, { jobId: "inv/1" });

// The `added` event matches three of our channels, and arrives once.
const added = await client.next(
  "event",
  (frame) => frame.event.type === "added",
);
show("one event, every channel it matched", {
  seq: added.seq,
  type: added.event.type,
  subscriptions: added.subscriptions,
});
show("its epoch", added.epoch);

// `run()` resolves only when the worker closes, so it is kept, not awaited.
const running = worker.run();

const completed = await client.next(
  "event",
  (frame) => frame.event.type === "completed",
);
show("completed", { seq: completed.seq, id: completed.event.id });

// A heartbeat carries the latest `seq`, so a quiet client can still tell that
// it is behind.
const heartbeat = await client.next("heartbeat");
show("heartbeat", heartbeat);

show(
  "every event type seen so far",
  client.all("event").map((frame) => `${frame.seq}:${frame.event.type}`),
);

/* ------------------------------------------------------------------ */
step("Resume after a disconnect: the replay ring fills the gap");

const lastSeen = completed.seq;
client.close();
await waitFor("the session to end", () => api.websocket!.sessions === 0);

// Work carries on while nobody is listening.
await billing.add("send-invoice", { invoiceId: "inv/2" }, { jobId: "inv/2" });
await waitFor("the second invoice to finish", async () => {
  const counts = await billing.count();
  return counts.completed >= 2;
});

const resumed = await connectJobsSocket(url);
await resumed.next("hello");
resumed.send({
  op: "subscribe",
  id: "r1",
  channels: ["queues"],
  // "I last processed `lastSeen` under this epoch; send me what I missed."
  resume: { epoch: hello.epoch, afterSeq: lastSeen },
});

const resumedAck = await resumed.next("ack", (frame) => frame.id === "r1");
show("ack.resumed", resumedAck.resumed);
// Replayed events arrive *before* the ack, oldest first.
show(
  "replayed while away",
  resumed
    .all("event")
    .map((frame) => `${frame.seq}:${frame.event.type}:${frame.event.id}`),
);
show("no gap was announced", resumed.all("gap").length === 0);

/* ------------------------------------------------------------------ */
step("Two deliberate gaps: what a client cannot be given back");

// 1. A different epoch — what a reconnect to another instance looks like
//    behind a load balancer without sticky sessions.
resumed.send({
  op: "subscribe",
  id: "r2",
  channels: ["queue/billing"],
  resume: { epoch: "00000000-0000-0000-0000-000000000000", afterSeq: 1 },
});
await resumed.next("ack", (frame) => frame.id === "r2");
const movedGap = await resumed.next(
  "gap",
  (frame) => frame.reason === "epoch-changed",
);
show("epoch-changed", movedGap);

// 2. A `seq` beyond anything this server has stamped. It was never part of
//    this epoch's history, so it is answered exactly like a foreign epoch:
//    `resumed: false` and a gap from 0 — nothing the client holds is known.
//    (`resume-expired` is the other reason, for a position the ring has
//    already forgotten; `10-options/jobs-api-socket-options.ts` provokes it.)
resumed.send({
  op: "subscribe",
  id: "r3",
  channels: ["queue/billing"],
  resume: { epoch: hello.epoch, afterSeq: 9999 },
});
const aheadAck = await resumed.next("ack", (frame) => frame.id === "r3");
show("ack.resumed", aheadAck.resumed);
const aheadGap = await resumed.next(
  "gap",
  // `next` also sees frames already received; skip the first gap.
  (frame) => frame !== movedGap && frame.reason === "epoch-changed",
);
show("a resume ahead of the server", aheadGap);
show(
  "what a client does with a gap",
  "refetch the affected resources over HTTP; the events between fromSeq and toSeq may be missing",
);

/* ------------------------------------------------------------------ */
step("Leaving a channel, and a ping");

resumed.send({ op: "unsubscribe", id: "u1", channels: ["queue/billing"] });
show(
  "unsubscribe ack",
  await resumed.next("ack", (frame) => frame.id === "u1"),
);
resumed.send({ op: "ping", id: "p1" });
show("pong", await resumed.next("pong"));

/* ------------------------------------------------------------------ */
step("Close: open sessions are told 1001 'going away'");

await api.close();
show("close code", (await resumed.waitClosed()).code);

await adapter.close();
await worker.close();
await running;
await jobs.purge();
await jobs.close();
show("everything closed");
