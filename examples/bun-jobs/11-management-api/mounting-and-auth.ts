/**
 * The management API: mount it, guard it with `authorize`, and walk the route
 * groups a dashboard is built from.
 *
 * ```bash
 * bun 11-management-api/mounting-and-auth.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 11-management-api/mounting-and-auth.ts
 * ```
 *
 * `createJobsApi(config)` returns a `BunRouter` plus the metadata around it.
 * Mount it with `use(api.basePath, api.router)` — passing `api.basePath` is
 * what keeps the mount and the paths inside the OpenAPI document from
 * disagreeing.
 *
 * Worth knowing before reading on:
 *
 * - **`authorize` is mandatory and fails closed.** It is asked exactly once
 *   per request, *before* the handler runs, with the action being attempted
 *   and what it targets. Anything it returns that is not a recognised allow
 *   shape — a forgotten `return`, a string — is a denial.
 * - **`readOnly` and `actions` are static limits**, applied before
 *   `authorize`: a route they remove is not registered at all, so it answers
 *   the API's JSON 404 rather than 403. No hook can re-enable it.
 * - **`jobs.add` and `jobs.update` are opt-in**, because they write payloads
 *   your processors will trust. This example lists them in `actions` to show
 *   them; leave them out unless a UI genuinely needs them.
 * - Requests here go through `adapter.fetch()`, which runs the real pipeline
 *   with no socket bound. `live-events.ts` uses a real server, because a
 *   WebSocket needs one.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs, createJobsApi } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What an email job carries. */
interface Email {
  /** Who it goes to. */
  to: string;
}

title("The management API: mounting and authorization");

/* ------------------------------------------------------------------ */
step("A context with some work in it");

const jobs = new BunJobs({
  namespace: exampleNamespace("admin"),
  driver: exampleDriver(),
});

// A defined name is what `jobs.add` will accept by default: `addableNames`
// falls back to the names in `jobs.definitions()`, read at request time.
jobs.define<Email, { sent: true }>("send-email", async () => ({ sent: true }), {
  attempts: 3,
});

const mail = jobs.queue<Email>("mail");
await mail.add("send-email", { to: "ada@example.com" }, { jobId: "e1" });
await mail.add("send-email", { to: "grace@example.com" }, { jobId: "e2" });
await mail.add("send-email", { to: "later@example.com" }, { delay: 60_000 });

// A repeat series, so the repeatables routes have something to list.
await mail.add(
  "send-email",
  { to: "digest@example.com" },
  { repeat: { every: 3_600_000, key: "hourly-digest" } },
);

show("queues", await jobs.listQueues());

/* ------------------------------------------------------------------ */
step("Who may do what: the authorize hook");

/** The roles this example understands, by bearer token. */
const TOKENS: Record<string, "reader" | "admin"> = {
  "reader-token": "reader",
  "admin-token": "admin",
};

/** Every action `authorize` was asked about, so the walk can report them. */
const asked: string[] = [];

const api = createJobsApi({
  jobs,
  // The prefix everything lives under: the routes, the socket's path, and the
  // `servers` entry in the OpenAPI document.
  basePath: "/admin/jobs",
  // Opt in to the two write actions, so the walk below can show them.
  actions: [
    "meta.read",
    "docs.read",
    "queues.list",
    "queues.read",
    "queues.pause",
    "queues.resume",
    "metrics.read",
    "workers.list",
    "jobs.list",
    "jobs.read",
    "jobs.add",
    "jobs.retry",
    "jobs.remove",
    "jobs.promote",
    "repeatables.list",
    "definitions.list",
    "events.connect",
    "events.subscribe",
  ],
  authorize: (req, context) => {
    asked.push(context.action);
    const role =
      TOKENS[(req.getHeader("authorization") ?? "").replace(/^Bearer /, "")];

    if (!role) {
      // 401 rather than 403: the caller is not signed in at all.
      return { allow: false, status: 401, reason: "Sign in to continue" };
    }
    // Reads for anyone signed in; changes for admins only. `mutation` is
    // derived from the action, so this cannot drift from the route table.
    return context.mutation && role !== "admin"
      ? { allow: false, status: 403, reason: "Admins only" }
      : true;
  },
});

const adapter = new BunHttpAdapter();
adapter.use(api.basePath, api.router);

show("basePath", api.basePath);
show("mode", api.mode);
show("routes registered", api.routes.length);
show("socket path", api.websocket?.path ?? "(no socket)");

/** Calls the API with a token, answering with the status and parsed body. */
async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const response = await adapter.fetch(`${api.basePath}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as any) : undefined,
  };
}

/* ------------------------------------------------------------------ */
step("Without a token: authorize answers before any handler runs");

const anonymous = await call("GET", "/meta");
show("GET /meta (no token)", anonymous);
show("it is an RFC 9457 problem", {
  type: anonymous.body.type,
  code: anonymous.body.code,
});

/* ------------------------------------------------------------------ */
step("Meta: what this API exposes, and what the caller may do");

const meta = (await call("GET", "/meta", "reader-token")).body;
show("driver", meta.driver);
show("features the backend supports", meta.features);
show("websocket", meta.websocket);

const permissions = (await call("GET", "/meta/permissions", "reader-token"))
  .body;
show(
  "a reader may not",
  Object.entries(permissions.actions)
    .filter(([, allowed]) => !allowed)
    .map(([action]) => action),
);

/* ------------------------------------------------------------------ */
step("Queues: listing, reading, counts and pausing");

show("GET /queues", (await call("GET", "/queues", "reader-token")).body);
show(
  "GET /queues/mail",
  (await call("GET", "/queues/mail", "reader-token")).body,
);
show(
  "GET /queues/mail/counts",
  (await call("GET", "/queues/mail/counts", "reader-token")).body,
);

// A mutation the reader's role refuses, then the same one as an admin.
show(
  "POST /queues/mail/pause as a reader",
  await call("POST", "/queues/mail/pause", "reader-token"),
);
show(
  "POST /queues/mail/pause as an admin",
  await call("POST", "/queues/mail/pause", "admin-token"),
);
show("the queue is paused", await mail.isPaused());
await call("POST", "/queues/mail/resume", "admin-token");

/* ------------------------------------------------------------------ */
step("Jobs: a page, one job, adding, promoting and removing");

const page = (
  await call("GET", "/queues/mail/jobs?limit=2&total=true", "reader-token")
).body;
show("GET /queues/mail/jobs?limit=2&total=true", {
  page: page.page,
  ids: page.items.map((job: any) => job.id),
});
// Lists omit the heavy fields; `include` asks for them.
const withData = (
  await call("GET", "/queues/mail/jobs?limit=1&include=data", "reader-token")
).body;
show("include=data", withData.items[0].data);

show(
  "GET /queues/mail/jobs/e1",
  (await call("GET", "/queues/mail/jobs/e1", "reader-token")).body,
);

// `jobs.add` only accepts names the context defines (`addableNames`).
const added = await call("POST", "/queues/mail/jobs", "admin-token", {
  name: "send-email",
  data: { to: "new@example.com" },
  opts: { jobId: "e3", priority: 1 },
});
show("POST /queues/mail/jobs", {
  status: added.status,
  added: added.body.added,
});

const refused = await call("POST", "/queues/mail/jobs", "admin-token", {
  name: "not-defined",
  data: {},
});
show("a name the context does not define", {
  status: refused.status,
  code: refused.body.code,
});

show(
  "POST /queues/mail/jobs/e3/promote",
  await call("POST", "/queues/mail/jobs/e3/promote", "admin-token"),
);
show(
  "DELETE /queues/mail/jobs/e3",
  (await call("DELETE", "/queues/mail/jobs/e3", "admin-token")).status,
);

/* ------------------------------------------------------------------ */
step("Repeatables and definitions");

show(
  "GET /queues/mail/repeatables",
  (
    await call("GET", "/queues/mail/repeatables", "reader-token")
  ).body.items.map((series: any) => ({ key: series.key, every: series.every })),
);
show(
  "GET /definitions",
  (await call("GET", "/definitions", "reader-token")).body,
);

/* ------------------------------------------------------------------ */
step("Workers and throughput, once something has run");

// A worker consuming `mail`. Note that `jobs.start()` would *not* do: it runs
// the registry worker, which consumes the registry queue (`jobs`) and
// dispatches by defined name — a different queue from the one managed here.
const worker = jobs.worker<Email, { sent: true }>(
  "mail",
  async () => ({ sent: true }),
  { concurrency: 2, pollInterval: 25 },
);
// `run()` resolves only when the worker closes, so it is kept, not awaited.
const running = worker.run();

await waitFor("the queued emails to finish", async () => {
  const counts = await mail.count();
  return counts.completed >= 2;
});

const workers = (await call("GET", "/workers", "reader-token")).body;
show(
  "GET /workers",
  workers.items.map((worker: any) => ({
    queue: worker.queue,
    concurrency: worker.concurrency,
    active: worker.active,
  })),
);
show("GET /overview", (await call("GET", "/overview", "reader-token")).body);

/* ------------------------------------------------------------------ */
step("A route the configuration removed is not registered at all");

// `queues.drain` was never in `actions`, so there is no route to authorize:
// the API's own JSON 404 answers, and `authorize` is not asked.
const before = asked.length;
const drain = await call("POST", "/queues/mail/drain", "admin-token");
show("POST /queues/mail/drain", {
  status: drain.status,
  code: drain.body.code,
});
show("authorize was asked", asked.length - before);

/* ------------------------------------------------------------------ */
step("Close: the API releases what it opened, and nothing else");

await api.close();
show("api closed");

// The context is still ours, and still works.
await mail.add("send-email", { to: "after@example.com" });
show("the BunJobs context is untouched", await jobs.listQueues());

await worker.close();
await running;
await jobs.purge();
await jobs.close();
show("context closed");
