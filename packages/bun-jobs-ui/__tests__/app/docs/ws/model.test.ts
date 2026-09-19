import {
  QUEUE_EVENT_TYPES,
  RUNNER_EVENT_TYPES,
} from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import { liveChannels } from "../../../../app/live";
import {
  channelEventTypes,
  channelPermissions,
  channelTryLink,
  eventPayloadSchema,
  eventsLink,
  exampleEventPayload,
  fillAddress,
  filterGroups,
  isKnownAction,
  itemPath,
  messageTryLink,
  navGroups,
  parameterProblem,
  parameterSchemas,
  readWsDoc,
  selectItem,
  tryProblems,
} from "../../../../app/screens/docs/ws/model";
import { parseChannel } from "../../../../app/screens/events/eventLog";
import { wsFixture } from "./fixtures";

const both = readWsDoc(wsFixture("both"));
const runner = readWsDoc(wsFixture("runner"));
const secured = readWsDoc(wsFixture("jobs-secured"));

/** A channel of a read document, by key. */
function channel(doc: typeof both, key: string) {
  const found = doc.channels.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no channel ${key}`);
  }
  return found;
}

/** A message of a read document, by key. */
function message(doc: typeof both, key: string) {
  const found = doc.messages.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no message ${key}`);
  }
  return found;
}

describe("readWsDoc on a real document (mode both)", () => {
  it("reads the header, the served server and the subprotocol", () => {
    expect(both.title).toBe(
      "bun-jobs management API (ui-docs-ws-fixture-both)",
    );
    expect(both.version).toBe("0.0.0-fixture");
    expect(both.description).toContain("Live events for bun-jobs");
    expect(both.server).toMatchObject({
      host: "localhost",
      hostIsTemplate: false,
      pathname: "/jobs-api/ws",
      protocol: "ws",
      url: "ws://localhost/jobs-api/ws",
    });
    expect(both.subprotocol).toEqual({
      value: "bun-jobs.v1",
      fromDocument: true,
      source: "extension",
    });
    expect(both.requirements).toEqual([]);
    expect(both.securitySchemes).toEqual([]);
    expect(both.conjunctive).toBe(false);
  });

  it("puts the connection first, then every family, with templates and parameters", () => {
    expect(both.channels.map((entry) => [entry.key, entry.address])).toEqual([
      ["connection", "/jobs-api/ws"],
      ["all", "all"],
      ["queues", "queues"],
      ["queue", "queue/{queue}"],
      ["job", "queue/{queue}/job/{jobId}"],
      ["runners", "runners"],
      ["runner", "runner/{runner}"],
    ]);
    const job = channel(both, "job");
    expect(job.parameters.map((parameter) => parameter.name)).toEqual([
      "queue",
      "jobId",
    ]);
    expect(job.parameters[1]!.description).toContain("encodeURIComponent");
    expect(channel(both, "connection")).toMatchObject({
      isConnection: true,
      bindingMethod: "GET",
    });
    expect(channel(both, "connection").messages).toEqual([
      "subscribe",
      "unsubscribe",
      "ping",
      "hello",
      "ack",
      "gap",
      "heartbeat",
      "pong",
      "error",
    ]);
  });

  it("reads operations with their direction, reply and permission", () => {
    const subscribe = both.operations.find(
      (entry) => entry.key === "subscribe",
    )!;
    expect(subscribe).toMatchObject({
      action: "send",
      channel: "connection",
      messages: ["subscribe"],
      reply: { channel: "connection", messages: ["ack", "error"] },
      permission: "events.subscribe",
    });
    const ping = both.operations.find((entry) => entry.key === "ping")!;
    expect(ping.reply?.messages).toEqual(["pong"]);
    expect(ping.permission).toBe("events.connect");
    const receiveJob = both.operations.find(
      (entry) => entry.key === "receiveJobEvents",
    )!;
    expect(receiveJob).toMatchObject({
      action: "receive",
      channel: "job",
      reply: null,
      permission: "events.subscribe",
    });
    expect(channelPermissions(both, "job")).toEqual(["events.subscribe"]);
    expect(channelPermissions(both, "connection")).toEqual([
      "events.subscribe",
      "events.connect",
    ]);
    expect(isKnownAction("events.subscribe")).toBe(true);
    expect(isKnownAction("made.up")).toBe(false);
  });

  it("lists control messages first, then one per event type", () => {
    const control = both.messages.filter((entry) => entry.event === null);
    expect(control.map((entry) => entry.key)).toEqual([
      "subscribe",
      "unsubscribe",
      "ping",
      "hello",
      "ack",
      "gap",
      "heartbeat",
      "pong",
      "error",
    ]);
    const events = both.messages.filter((entry) => entry.event !== null);
    expect(events).toHaveLength(
      QUEUE_EVENT_TYPES.length + RUNNER_EVENT_TYPES.length,
    );
    expect(both.messages.indexOf(events[0]!)).toBe(control.length);
    expect(message(both, "queue.completed")).toMatchObject({
      name: "queue.completed",
      title: "Queue completed",
      contentType: "application/json",
      event: { kind: "queue", type: "completed" },
      examples: [{ name: "queue.completed", summary: "A job completed." }],
    });
    expect(message(both, "runner.succeeded").event).toEqual({
      kind: "runner",
      type: "succeeded",
    });
  });

  it("reads x-bun-jobs-limits, -close-codes and -upgrade-refusals", () => {
    expect(both.limits?.values.map(([name]) => name)).toEqual([
      "maxMessageBytes",
      "messagesPerSecond",
      "rateLimitBurst",
      "rateLimitBreachWindowMs",
      "maxSubscriptions",
      "maxChannelsPerFrame",
      "maxConnections",
      "heartbeatMs",
      "maxBufferedBytes",
      "slowConsumerTimeoutMs",
      "coalesceProgressMs",
    ]);
    expect(both.limits?.replay).toEqual({ size: 1000, maxAgeMs: 300000 });
    expect(both.closeCodes.map((entry) => [entry.code, entry.name])).toEqual([
      [1001, "GOING_AWAY"],
      [1003, "UNSUPPORTED_DATA"],
      [1008, "POLICY"],
      [1009, "TOO_BIG"],
      [4008, "SLOW_CONSUMER"],
      [4401, "UNAUTHORIZED"],
    ]);
    expect(both.refusals.map((entry) => [entry.status, entry.code])).toEqual([
      [400, "UNSUPPORTED_SUBPROTOCOL"],
      [403, "ORIGIN_REJECTED"],
      [429, "CONNECTION_LIMIT"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [404, "ROUTE_NOT_FOUND"],
    ]);
    const limit = both.refusals.find(
      (entry) => entry.code === "CONNECTION_LIMIT",
    )!;
    expect(limit.headers).toEqual({ "Retry-After": "1" });
    expect(limit.contentType).toBe("application/problem+json");
  });

  it("finds an event message's payload inside its envelope", () => {
    const root = wsFixture("both");
    expect(
      eventPayloadSchema(message(both, "queue.completed").payload, root),
    ).toEqual({ $ref: "#/components/schemas/QueueCompletedPayload" });
    expect(
      eventPayloadSchema(message(both, "subscribe").payload, root),
    ).toBeUndefined();
  });
});

describe("readWsDoc on other configurations", () => {
  it("mode runner: the queue channels and messages are pruned", () => {
    expect(runner.channels.map((entry) => entry.key)).toEqual([
      "connection",
      "runners",
      "runner",
    ]);
    expect(
      runner.messages.filter((entry) => entry.event?.kind === "queue"),
    ).toEqual([]);
    expect(
      runner.messages.filter((entry) => entry.event?.kind === "runner"),
    ).toHaveLength(RUNNER_EVENT_TYPES.length);
    expect(
      runner.operations
        .map((entry) => entry.key)
        .filter((key) => key.startsWith("receive")),
    ).toEqual([
      "receiveControl",
      "receiveRunnersEvents",
      "receiveRunnerEvents",
    ]);
  });

  it("mode jobs with security: every requirement, the AND one included, and each scheme's browser note", () => {
    expect(secured.channels.map((entry) => entry.key)).toEqual([
      "connection",
      "queues",
      "queue",
      "job",
    ]);
    expect(secured.requirements).toEqual([
      [{ scheme: "session", scopes: [] }],
      [
        { scheme: "bearer", scopes: [] },
        { scheme: "apiKey", scopes: [] },
      ],
    ]);
    expect(secured.conjunctive).toBe(true);
    const schemes = Object.fromEntries(
      secured.securitySchemes.map((scheme) => [scheme.name, scheme]),
    );
    expect(schemes.bearer).toMatchObject({
      type: "http",
      detail: "bearer, JWT",
    });
    expect(schemes.bearer!.note).toContain(
      "cannot send an Authorization header",
    );
    expect(schemes.apiKey).toMatchObject({
      type: "httpApiKey",
      detail: "header X-Api-Key",
    });
    expect(schemes.apiKey!.note).toContain("X-Api-Key");
    expect(schemes.session).toMatchObject({
      type: "httpApiKey",
      detail: "cookie sid",
      note: undefined,
    });
    expect(secured.limits?.replay).toBe(false);
  });

  it("the in-process document: the host is a template with a default", () => {
    const document = wsFixture("both");
    const servers = document.servers as Record<string, Record<string, unknown>>;
    servers.api!.host = "{host}";
    servers.api!.variables = { host: { default: "localhost:4000" } };
    const read = readWsDoc(document);
    expect(read.server).toMatchObject({
      host: "{host}",
      hostIsTemplate: true,
      hostDefault: "localhost:4000",
      url: "ws://localhost:4000/jobs-api/ws",
    });
  });

  it("without x-bun-jobs-security, reads the native list", () => {
    const document = wsFixture("jobs-secured");
    const servers = document.servers as Record<string, Record<string, unknown>>;
    delete servers.api!["x-bun-jobs-security"];
    const read = readWsDoc(document);
    expect(read.requirements).toEqual([[{ scheme: "session", scopes: [] }]]);
    expect(read.conjunctive).toBe(false);
  });

  it("an empty or malformed document reads as empty, not a throw", () => {
    const read = readWsDoc({ channels: 3, operations: [null], info: "x" });
    expect(read.title).toBe("WebSocket API");
    expect(read.channels).toEqual([]);
    expect(read.operations).toEqual([]);
    expect(read.messages).toEqual([]);
    expect(read.limits).toBeNull();
    expect(read.server).toBeNull();
    expect(read.subprotocol).toEqual({
      value: "bun-jobs.v1",
      fromDocument: false,
      source: "contract",
    });
  });
});

describe("the sidebar", () => {
  it("groups the connection's panels, channels, operations, control and event messages", () => {
    const groups = navGroups(both);
    expect(groups.map((group) => group.title)).toEqual([
      "Connection",
      "Channels",
      "Operations",
      "Control messages",
      "Event messages",
    ]);
    expect(groups[0]!.items.map((item) => item.slug)).toEqual([
      "limits",
      "close-codes",
      "upgrade-refusals",
    ]);
    expect(groups[1]!.items[4]).toMatchObject({
      slug: "channel-job",
      label: "Job",
      hint: "queue/{queue}/job/{jobId}",
    });
    expect(groups[4]!.items.map((item) => item.slug)).toContain(
      "message-queue.completed",
    );
  });

  it("searches every word across labels, hints and keywords", () => {
    const groups = navGroups(both);
    const slugs = (query: string) =>
      filterGroups(groups, query).flatMap((group) =>
        group.items.map((item) => item.slug),
      );
    expect(slugs("")).toHaveLength(
      groups.reduce((sum, group) => sum + group.items.length, 0),
    );
    expect(slugs("1008")).toEqual(["close-codes"]);
    expect(slugs("CONNECTION_LIMIT")).toEqual(["upgrade-refusals"]);
    expect(slugs("queue.completed")).toEqual(["message-queue.completed"]);
    expect(slugs("channel jobId")).toEqual(["channel-job"]);
    expect(slugs("jobId nonsense")).toEqual([]);
    expect(slugs("jobId")).toEqual(["channel-job"]);
    expect(slugs("nothing-like-this")).toEqual([]);
  });

  it("selects items by their stable slugs", () => {
    expect(selectItem(both, "channel-queue")).toMatchObject({
      kind: "channel",
      channel: { key: "queue" },
    });
    expect(selectItem(both, "operation-ping")).toMatchObject({
      kind: "operation",
      operation: { key: "ping" },
    });
    expect(selectItem(both, "message-runner.killed")).toMatchObject({
      kind: "message",
      message: { key: "runner.killed" },
    });
    expect(selectItem(both, "limits")).toEqual({ kind: "limits" });
    expect(selectItem(both, "close-codes")).toEqual({ kind: "close-codes" });
    expect(selectItem(both, "upgrade-refusals")).toEqual({
      kind: "upgrade-refusals",
    });
    expect(selectItem(both, "channel-nope")).toBeNull();
    expect(selectItem(runner, "channel-queue")).toBeNull();
    expect(itemPath("message-queue.completed")).toBe(
      "/docs/ws/message-queue.completed",
    );
    expect(itemPath("limits", "rate limit")).toBe(
      "/docs/ws/limits?q=rate+limit",
    );
  });
});

describe("try it", () => {
  it("fills a job address exactly as the live client names job channels", () => {
    for (const id of ["42", "a/b c%", "ümlaut?&=#", "\uD800lone", "x\uDFFF"]) {
      expect(
        fillAddress("queue/{queue}/job/{jobId}", { queue: "mail", jobId: id }),
      ).toBe(liveChannels.job("mail", id));
    }
    expect(fillAddress("queue/{queue}", { queue: "mail" })).toBe(
      liveChannels.queue("mail"),
    );
    expect(fillAddress("runner/{runner}", { runner: "nightly.v2" })).toBe(
      liveChannels.runner("nightly.v2"),
    );
    expect(fillAddress("queues", {})).toBe("queues");
  });

  it("refuses an incomplete address or an invalid name", () => {
    expect(
      fillAddress("queue/{queue}/job/{jobId}", { queue: "mail" }),
    ).toBeNull();
    expect(fillAddress("queue/{queue}", { queue: "has space" })).toBeNull();
    expect(fillAddress("queue/{queue}", { queue: ".." })).toBeNull();
    expect(fillAddress("queue/{queue}", { queue: "x".repeat(201) })).toBeNull();
    expect(parameterProblem("queue", "has/slash")).not.toBeNull();
    expect(parameterProblem("queue", "")).toBeNull();
    expect(parameterProblem("jobId", "any / thing")).toBeNull();
  });

  it("links a channel into the console, filtering types only when the channel narrows them", () => {
    const values = { queue: "mail", jobId: "a/b", runner: "nightly" };
    const link = (key: string) =>
      channelTryLink(both, channel(both, key), values, "both");
    expect(link("all")).toBe("/events?channel=all");
    expect(link("queues")).toBe("/events?channel=queues");
    expect(link("queue")).toBe("/events?channel=queue%2Fmail");
    expect(link("runner")).toBe("/events?channel=runner%2Fnightly");
    expect(link("connection")).toBeNull();

    const jobLink = new URLSearchParams(link("job")!.split("?")[1]);
    expect(jobLink.get("channel")).toBe(liveChannels.job("mail", "a/b"));
    const types = jobLink.get("types")!.split(",");
    expect(types).toEqual(
      QUEUE_EVENT_TYPES.filter((type) =>
        channelEventTypes(both, channel(both, "job")).includes(type),
      ),
    );
    expect(types).toContain("completed");
    expect(types).not.toContain("paused");
    // The console reads it back to the same job.
    expect(parseChannel(jobLink.get("channel"), "both")).toEqual({
      scope: "job",
      queue: "mail",
      id: "a/b",
    });

    expect(
      channelTryLink(both, channel(both, "job"), { queue: "mail" }, "both"),
    ).toBeNull();
  });

  it("gives no link for a channel the console cannot open in the mode", () => {
    expect(eventsLink("all", [], "jobs")).toBeNull();
    expect(eventsLink("runner/x", [], "jobs")).toBeNull();
    expect(eventsLink("queue/x", ["completed"], "jobs")).toBe(
      "/events?channel=queue%2Fx&types=completed",
    );
  });

  it("links an event message to its kind's broad channel, filtered to its type", () => {
    expect(messageTryLink(both, message(both, "queue.completed"), "both")).toBe(
      "/events?channel=queues&types=completed",
    );
    expect(
      messageTryLink(runner, message(runner, "runner.killed"), "runner"),
    ).toBe("/events?channel=runners&types=killed");
    expect(messageTryLink(both, message(both, "hello"), "both")).toBeNull();
  });
});

/** The raw document's `servers` / `channels` / `components.messages`, loosely typed for edits. */
function raw(document: ReturnType<typeof wsFixture>) {
  return document as unknown as {
    servers: Record<string, Record<string, unknown>>;
    channels: Record<string, Record<string, unknown>>;
    components: { messages: Record<string, Record<string, unknown>> };
  };
}

describe("the subprotocol (x-bun-jobs-subprotocol, then prose, then the contract)", () => {
  it("prefers servers.api's extension over the connection channel's", () => {
    const document = wsFixture("both");
    raw(document).servers.api!["x-bun-jobs-subprotocol"] = "from-server.v9";
    raw(document).channels.connection!["x-bun-jobs-subprotocol"] =
      "from-channel.v9";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-server.v9",
      fromDocument: true,
      source: "extension",
    });
  });

  it("reads the connection channel's extension when the server has none", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api!["x-bun-jobs-subprotocol"];
    raw(document).channels.connection!["x-bun-jobs-subprotocol"] =
      "from-channel.v9";
    raw(document).channels.connection!.description =
      "Uses the subprotocol `from-prose.v9`.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-channel.v9",
      fromDocument: true,
      source: "extension",
    });
  });

  it("falls back to the connection channel's prose for an older API", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api!["x-bun-jobs-subprotocol"];
    delete raw(document).channels.connection!["x-bun-jobs-subprotocol"];
    raw(document).channels.connection!.description =
      "The socket. Offer the subprotocol `from-prose.v9`, or none.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-prose.v9",
      fromDocument: true,
      source: "prose",
    });
  });

  it("falls back to the contract's constant when the document says nothing", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api!["x-bun-jobs-subprotocol"];
    delete raw(document).channels.connection!["x-bun-jobs-subprotocol"];
    raw(document).channels.connection!.description = "The socket.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "bun-jobs.v1",
      fromDocument: false,
      source: "contract",
    });
  });

  it("ignores a non-string extension", () => {
    const document = wsFixture("both");
    raw(document).servers.api!["x-bun-jobs-subprotocol"] = 1;
    raw(document).channels.connection!["x-bun-jobs-subprotocol"] = null;
    expect(readWsDoc(document).subprotocol.source).not.toBe("extension");
  });
});

describe("parameter schemas (x-bun-jobs-schema)", () => {
  it("reads the queue and runner schemas, and none for a job id", () => {
    const [queue, jobId] = channel(both, "job").parameters;
    expect(queue!.schema).toEqual({
      type: "string",
      pattern: "^(?!\\.\\.?$)[\\w.-]+$",
      maxLength: 200,
    });
    expect(jobId!.schema).toBeUndefined();
    expect(channel(both, "runner").parameters[0]!.schema).toMatchObject({
      maxLength: 200,
    });
    expect(parameterSchemas(channel(both, "job").parameters)).toEqual({
      queue: queue!.schema,
      jobId: undefined,
    });
  });

  it("the document's schema decides, when it gives one", () => {
    const strict = { pattern: "^[a-z]+$", maxLength: 5 };
    // Accepted by the contract's rule, refused by the document's.
    expect(parameterProblem("queue", "a.b")).toBeNull();
    expect(parameterProblem("queue", "a.b", strict)).toBe(
      "Must match ^[a-z]+$.",
    );
    expect(parameterProblem("queue", "abcdef", strict)).toBe(
      "At most 5 characters (this is 6).",
    );
    expect(parameterProblem("queue", "abc", strict)).toBeNull();
    expect(parameterProblem("queue", "", strict)).toBeNull();
    // A job id is held to a schema too, when the document gives it one.
    expect(parameterProblem("jobId", "a/b", strict)).not.toBeNull();
    expect(parameterProblem("x", "a", { minLength: 2 })).toBe(
      "At least 2 characters.",
    );
    // A pattern that does not compile is skipped, not a refusal of everything.
    expect(parameterProblem("queue", "a b", { pattern: "(" })).toBeNull();
  });

  it("the real schema refuses what the server refuses", () => {
    const schema = channel(both, "queue").parameters[0]!.schema;
    expect(parameterProblem("queue", "mail.v2-x_1", schema)).toBeNull();
    for (const bad of [".", "..", "a/b", "has space", "ümlaut"]) {
      expect(parameterProblem("queue", bad, schema)).toContain(
        "Letters, digits",
      );
    }
    expect(parameterProblem("queue", "x".repeat(200), schema)).toBeNull();
    expect(parameterProblem("queue", "x".repeat(201), schema)).toBe(
      "At most 200 characters (this is 201).",
    );
  });

  it("fills an address under the document's schemas", () => {
    expect(
      fillAddress(
        "queue/{queue}",
        { queue: "abcdef" },
        { queue: { maxLength: 3 } },
      ),
    ).toBeNull();
    expect(
      fillAddress(
        "queue/{queue}",
        { queue: "a.b" },
        { queue: { pattern: "^[a-z.]+$" } },
      ),
    ).toBe("queue/a.b");
  });

  it("try-it follows a document that tightens the rule, and says why", () => {
    const document = wsFixture("both");
    const parameters = raw(document).channels.queue!.parameters as Record<
      string,
      Record<string, unknown>
    >;
    parameters.queue!["x-bun-jobs-schema"] = {
      type: "string",
      pattern: "^[a-z]+$",
      maxLength: 3,
    };
    const read = readWsDoc(document);
    const queue = channel(read, "queue");
    expect(channelTryLink(read, queue, { queue: "mail" }, "both")).toBeNull();
    expect(tryProblems(queue, { queue: "mail" })).toEqual([
      "queue: At most 3 characters (this is 4).",
    ]);
    expect(channelTryLink(read, queue, { queue: "ml" }, "both")).toBe(
      "/events?channel=queue%2Fml",
    );
    expect(tryProblems(queue, { queue: "ml" })).toEqual([]);
  });

  it("an older API without the extension keeps the contract's rule", () => {
    const document = wsFixture("both");
    const parameters = raw(document).channels.queue!.parameters as Record<
      string,
      Record<string, unknown>
    >;
    delete parameters.queue!["x-bun-jobs-schema"];
    const queue = channel(readWsDoc(document), "queue");
    expect(queue.parameters[0]!.schema).toBeUndefined();
    expect(tryProblems(queue, { queue: "x".repeat(201) })[0]).toContain(
      "Letters, digits",
    );
    expect(tryProblems(queue, { queue: "mail" })).toEqual([]);
  });

  it("lists every empty or refused parameter, in template order", () => {
    const job = channel(both, "job");
    expect(tryProblems(job, {})).toEqual([
      "queue: fill it in.",
      "jobId: fill it in.",
    ]);
    expect(tryProblems(job, { queue: "..", jobId: "any / thing" })).toEqual([
      'queue: Letters, digits, "_", "." and "-" only (not "." or "..").',
    ]);
  });
});

describe("message examples", () => {
  it("reads one example per message from the real document", () => {
    const control = both.messages.filter((entry) => entry.event === null);
    const events = both.messages.filter((entry) => entry.event !== null);
    expect(control).toHaveLength(9);
    expect(events).toHaveLength(29);
    for (const entry of both.messages) {
      expect(entry.examples).toHaveLength(1);
      expect(entry.examples[0]!.name).toBe(entry.key);
      expect(entry.examples[0]!.summary).toBeTruthy();
    }
    const completed = message(both, "queue.completed").examples[0]!;
    expect(completed.payload).toMatchObject({
      type: "event",
      event: { kind: "queue", type: "completed" },
    });
  });

  it("finds an event example's event.payload", () => {
    const completed = message(both, "queue.completed").examples[0]!;
    expect(exampleEventPayload(completed.payload)).toMatchObject({
      id: "welcome:ada@example.com",
      returnValue: {},
    });
    expect(
      exampleEventPayload(message(both, "subscribe").examples[0]!.payload),
    ).toBeUndefined();
    expect(exampleEventPayload(null)).toBeUndefined();
    expect(exampleEventPayload({ event: 3 })).toBeUndefined();
  });

  it("drops malformed examples rather than throwing", () => {
    const document = wsFixture("both");
    raw(document).components.messages.hello!.examples = [
      null,
      "x",
      { name: 3, payload: { type: "hello" } },
    ];
    expect(message(readWsDoc(document), "hello").examples).toEqual([
      { name: undefined, summary: undefined, payload: { type: "hello" } },
    ]);
  });
});
