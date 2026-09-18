/**
 * A typed client for the management API, built on the browser-safe contract.
 *
 * ```bash
 * bun 11-management-api/typed-client.ts
 * EXAMPLE_DRIVER=sqlite bun 11-management-api/typed-client.ts
 * ```
 *
 * The client, [`helpers/contract-client.ts`](./helpers/contract-client.ts),
 * imports nothing but `@kingsleyweb/bun-jobs/api/contract`. This script
 * serves an API, drives it through that client, and builds the client for a
 * browser to show that the contract drags none of the server along.
 *
 * Worth knowing:
 *
 * - **`GET /meta` is the client's configuration.** It names the CSRF header
 *   every mutation must carry, whether a bodiless `POST` must still be JSON,
 *   every page and bulk cap, the job names the API will add, and where the
 *   socket lives — a dedicated port included. A client that reads it once
 *   never meets a 400 it could have avoided.
 * - **The server takes its constants from the contract**, so a client built
 *   against it cannot disagree with the server it talks to.
 * - **`/meta/permissions?channel=`** answers whether a subscription would be
 *   accepted, before a socket is opened.
 * - **A job channel's id is escaped with the contract's `encodeJobId`**, not
 *   `encodeURIComponent`, which throws on a lone UTF-16 surrogate;
 *   `decodeJobId` reads a channel back.
 * - **Adding a queue's first job creates it**: the client needs no queue to
 *   exist before it adds to one.
 */
import type { JobsApiServerMessage } from "@kingsleyweb/bun-jobs/api/contract";
import type { FrameOf } from "./helpers/contract-client";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, createDriver, createJobsApi } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import {
  connectJobsClient,
  jobChannel,
  jobOfChannel,
  JobsApiProblem,
} from "./helpers/contract-client";

title("The management API: a client typed by its contract");

/* ------------------------------------------------------------------ */
step("A server: a CSRF header, defined job names, a socket");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("typed-client");
const jobs = new BunJobs({
  namespace,
  driver,
  publishEvents: true,
  logger: noopLogger,
});
jobs.define("send-invoice", async () => {});
const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  logger: noopLogger,
  actions: [
    "meta.read",
    "queues.list",
    "jobs.add",
    "events.connect",
    "events.subscribe",
  ],
  csrf: { header: "X-Admin-CSRF" },
  // A browser cannot set headers on a WebSocket upgrade: it sends cookies.
  // Here the upgrade is let in, and every subscription is still decided
  // channel by channel; a real host would check the session cookie instead.
  authorize: (req, context) =>
    (context.transport === "ws" ||
      req.getHeader("authorization") === "Bearer ops") &&
    (context.queue !== "payroll" || {
      allow: false,
      reason: "payroll is private",
    }),
  limits: { maxQueues: 2, queueCacheMs: 0 },
  websocket: { heartbeatMs: 0 },
});
// Seeded from code; the API could equally create it with its first job.
await jobs.queue("billing").add("send-invoice", { invoice: 0 });
const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.use(api.basePath, api.router);
api.websocket!.attach(adapter);
const server = await adapter.listen(0);
const baseUrl = `http://127.0.0.1:${server.port}${api.basePath}`;
show("api.info, on the server, without a request", api.info);

/* ------------------------------------------------------------------ */
step("The client reads /meta once");

const client = await connectJobsClient({
  baseUrl,
  headers: { authorization: "Bearer ops" },
});
checkEqual("the CSRF header, lower case", client.meta.csrf, {
  header: "x-admin-csrf",
  requireJson: true,
});
checkEqual("the names it may add", client.meta.addableNames, ["send-invoice"]);
checkEqual("the page size for queue lists", client.meta.limits.maxQueues, 2);
checkEqual(
  "and the socket, as api.info reports it",
  client.meta.websocket?.path,
  api.info.websocket?.path,
);

/* ------------------------------------------------------------------ */
step("Mutations follow what /meta said");

const added = await client.addJob("billing", {
  name: "send-invoice",
  data: { invoice: 1 },
});
checkEqual("a job added with the CSRF header", added.added, true);
await checkRejects(
  "a name /meta did not list is refused before any request",
  () => client.addJob("billing", { name: "anything", data: {} }),
  { message: /not an addable job name/ },
);
// The same request without the header, as a client that ignored /meta sends.
const bare = await fetch(`${baseUrl}/queues/billing/jobs`, {
  method: "POST",
  headers: { authorization: "Bearer ops", "content-type": "application/json" },
  body: JSON.stringify({ name: "send-invoice", data: {} }),
});
checkEqual(
  "without the header the API refuses it",
  [bare.status, ((await bare.json()) as { code: string }).code],
  [403, "CSRF_REJECTED"],
);

/* ------------------------------------------------------------------ */
step("Queues, a page at a time");

for (const queue of ["alerts", "Reports", "reminders"]) {
  await jobs.queue(queue).add("send-invoice", {});
}
const first = await client.queues();
checkEqual(
  "limits.maxQueues per page, and a total",
  [first.items.length, first.page.total, first.truncated],
  [2, 4, true],
);
checkEqual(
  "every queue, by walking the pages",
  (await client.allQueues()).map((queue) => queue.name),
  ["Reports", "alerts", "billing", "reminders"],
);
checkEqual(
  "search ignores case",
  (await client.allQueues("re")).map((queue) => queue.name),
  ["Reports", "reminders"],
);

/* ------------------------------------------------------------------ */
step("The first job a client adds creates its queue");

const firstInQueue = await client.addJob("onboarding", {
  name: "send-invoice",
  data: { invoice: 100 },
});
checkEqual(
  "a queue the backend had never seen: the job is added",
  firstInQueue.added,
  true,
);
check(
  "and the queue is listed at once",
  (await client.allQueues()).some((queue) => queue.name === "onboarding"),
);

/* ------------------------------------------------------------------ */
step("Ask before subscribing, then subscribe");

const mail = await client.permissions({ channel: "queue/billing" });
const payroll = await client.permissions({ channel: "queue/payroll" });
checkEqual(
  "queue/billing would be accepted; queue/payroll would not, and why",
  [mail.channel?.allowed, payroll.channel?.allowed, payroll.channel?.detail],
  [true, false, "payroll is private"],
);

const live = client.openSocket();
await live.next("hello");
checkEqual(
  "the socket negotiated the contract's subprotocol",
  live.socket.protocol,
  "bun-jobs.v1",
);
live.send({ op: "subscribe", id: "s", channels: ["queue/billing"] });
await live.next("ack", (frame) => frame.id === "s");
const next = await client.addJob("billing", {
  name: "send-invoice",
  data: { invoice: 2 },
});
/** Whether a frame is the `added` event for the job just added. */
const isAdded = (frame: JobsApiServerMessage) =>
  frame.type === "event" &&
  frame.event.kind === "queue" &&
  frame.event.type === "added" &&
  frame.event.id === next.job.id;
await waitFor("the added event", () => live.frames.some(isAdded));
const event = live.frames.find(isAdded) as FrameOf<"event">;
checkEqual("its event arrived, typed by the contract", event.subscriptions, [
  "queue/billing",
]);

/* ------------------------------------------------------------------ */
step("A job's channel, whatever the id holds");

// `encodeURIComponent` throws on a lone UTF-16 surrogate, which a job id read
// back from a store may still hold. `jobChannel` uses the contract's
// `encodeJobId`, which writes it `%uXXXX`; `jobOfChannel` reads it back with
// `decodeJobId`.
const oddId = "inv-\uD800-7";
const oddChannel = jobChannel("billing", oddId);
checkEqual(
  "the channel carries the surrogate as %uXXXX",
  oddChannel,
  "queue/billing/job/inv-%uD800-7",
);
check(
  "and reads back to the same queue and id",
  jobOfChannel(oddChannel)?.queue === "billing" &&
    jobOfChannel(oddChannel)?.jobId === oddId,
);
const oddPreview = await client.permissions({ channel: oddChannel });
checkEqual(
  "the API would accept it, under the same canonical key",
  [oddPreview.channel?.allowed, oddPreview.channel?.key === oddChannel],
  [true, true],
);
live.send({ op: "subscribe", id: "odd", channels: [oddChannel] });
const oddAck = await live.next("ack", (frame) => frame.id === "odd");
check(
  "the subscription is accepted as sent",
  oddAck.channels.length === 1 && oddAck.channels[0] === oddChannel,
);
// The channel is only a name here: no job with this id is added. Server
// backends cannot store a lone surrogate faithfully, and bun-jobs is moving to
// refuse ids that are not well-formed Unicode, so the encoding matters for
// names a client builds, not for ids it should create.
live.socket.close();

/* ------------------------------------------------------------------ */
step("The client bundles for a browser");

const built = await Bun.build({
  entrypoints: [
    new URL("./helpers/contract-client.ts", import.meta.url).pathname,
  ],
  target: "browser",
});
check("Bun.build with target: browser succeeds", built.success, built.logs);
const bundle = await built.outputs[0]!.text();
check(
  "and nothing of the server came with it",
  !/bun-common|node:|bun:|drivers\//.test(bundle),
);
show("bundle size (bytes)", bundle.length);

await checkRejects(
  "a problem response arrives as a JobsApiProblem",
  () => connectJobsClient({ baseUrl }),
  { name: JobsApiProblem.name },
);

/* ------------------------------------------------------------------ */
step("Cleaning up: only this run's namespace");

await api.close();
await adapter.close();
await jobs.purge();
await jobs.close();
await driver.close();

summary();
