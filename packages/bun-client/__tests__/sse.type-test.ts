/**
 * `sse()`'s types (typed-client plan, `sse.md` §5 "Types"): the event union
 * narrows `data` by `event`; listeners are typed by name; `$gap` exists only
 * where a `gap` event is declared; the options are required when a typed
 * part is; and an event stream is refused by the HTTP verbs, `request` and
 * `op`, as an ordinary route is by `sse()`. Checked by `bun run check`
 * (`bun test --check` reads no `*.type-test.ts`). Each `@ts-expect-error`
 * is a negative control: remove the refusal it covers and the check fails on
 * the unused directive.
 */
import type { ValidationError } from "../lib/index";
import type { EventStream } from "../lib/sse";
import { createClient } from "../lib/index";
import { sse } from "../lib/sse";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

interface Routes {
  "GET /jobs/:id/events": {
    operationId: "jobEvents";
    params: { id: string };
    responses: { 200: undefined };
    stream: "sse";
    events: {
      progress: { percent: number; at: Date };
      done: { result: string };
      gap: undefined;
    };
  };
  "GET /ticks": {
    responses: { 200: undefined };
    stream: "sse";
    events: { tick: number };
  };
  "GET /anything": { responses: { 200: undefined }; stream: "sse" };
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    responses: { 200: { id: string } };
  };
}

const api = createClient<Routes>();
const never = (_: unknown) => {};

/* The stream's type, from the entry's events. */
const jobs = sse(api, "GET /jobs/:id/events", { params: { id: "1" } });
type _jobs = Expect<
  Equal<typeof jobs, EventStream<Routes["GET /jobs/:id/events"]["events"]>>
>;

async function iterate() {
  for await (const event of jobs) {
    type _names = Expect<
      Equal<typeof event.event, "progress" | "done" | "gap">
    >;
    type _id = Expect<Equal<typeof event.id, string | undefined>>;
    if (event.event === "progress") {
      // Narrowed, and after JSON: a Date arrives as a string.
      type _data = Expect<
        Equal<typeof event.data, { percent: number; at: string }>
      >;
    } else if (event.event === "done") {
      type _done = Expect<Equal<typeof event.data, { result: string }>>;
    } else {
      type _gap = Expect<Equal<typeof event.data, undefined>>;
    }
  }
}
void iterate;

/* Listeners, by name. */
jobs.on("done", (data, event) => {
  type _data = Expect<Equal<typeof data, { result: string }>>;
  type _event = Expect<Equal<typeof event.event, "done">>;
  void [data, event];
});
jobs.on("$gap", (data) => {
  type _gap = Expect<Equal<typeof data, undefined>>;
  void data;
});
jobs.on("$invalid", (error) => {
  type _error = Expect<Equal<typeof error, ValidationError>>;
  void error;
});
const off: () => void = jobs.on("progress", () => {});
void off;
// @ts-expect-error -- not an event of the route
jobs.on("nope", () => {});
// @ts-expect-error -- $gap needs a declared gap event
sse(api, "GET /ticks").on("$gap", () => {});
sse(api, "GET /ticks").on("tick", (n) => {
  type _n = Expect<Equal<typeof n, number>>;
  void n;
});

/* A stream with no declared events: any name, data any JSON value. */
async function anything() {
  const next = await sse(api, "GET /anything")[Symbol.asyncIterator]().next();
  if (!next.done) {
    type _name = Expect<Equal<typeof next.value.event, string>>;
  }
}
void anything;

/* The members. */
type _last = Expect<Equal<typeof jobs.lastEventId, string>>;
type _closed = Expect<Equal<typeof jobs.closed, Promise<void>>>;
jobs.close();

/* The options. */
never(() =>
  sse(api, "GET /jobs/:id/events", {
    params: { id: "1" },
    lastEventId: "4",
    reconnect: { initialMs: 1_000, maxMs: 10_000 },
    heartbeatMs: 15_000,
    fatalStatuses: [401, 403],
    data: "text",
    validate: { onFailure: { response: "drop" } },
  }),
);
never(() => sse(api, "GET /ticks", { reconnect: false }));
never(() => sse(api, "GET /ticks"));
// @ts-expect-error -- the params are required
never(() => sse(api, "GET /jobs/:id/events"));
// @ts-expect-error -- a wrong param
never(() => sse(api, "GET /jobs/:id/events", { params: { job: "1" } }));
never(() =>
  sse(api, "GET /ticks", {
    // @ts-expect-error -- "drop" is a stream's failure mode, not a request part's
    validate: { onFailure: { request: "drop" } },
  }),
);

/* An event stream is not an HTTP call, and an HTTP route is not a stream. */
// @ts-expect-error -- not a GET path of the client
never(() => api.get("/jobs/:id/events", { params: { id: "1" } }));
// @ts-expect-error -- not a key request() takes
never(() => api.request("GET /ticks"));
// @ts-expect-error -- not an operation
never(() => api.op.jobEvents({ params: { id: "1" } }));
never(() => api.op.getUser({ params: { id: "1" } }));
never(() => api.get("/users/:id", { params: { id: "1" } }));
// @ts-expect-error -- an ordinary route is not an event stream
never(() => sse(api, "GET /users/:id", { params: { id: "1" } }));
// The URL builder still knows the stream's path (an EventSource may want it).
never(() => api.url("/jobs/:id/events", { params: { id: "1" } }));
