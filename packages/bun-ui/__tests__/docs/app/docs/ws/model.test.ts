import { describe, expect, it } from "bun:test";
import {
  channelPermissions,
  channelsCarrying,
  eventPayloadSchema,
  exampleEventPayload,
  filterGroups,
  itemPath,
  navGroups,
  operationsOn,
  operationsUsing,
  readWsDoc,
  selectItem,
  subprotocolSource,
} from "../../../../app/screens/docs/ws/model";
import { expectAbsent, expectUndefined } from "../../assert";
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

/** The raw document's `servers` / `channels` / `components.messages`, loosely typed for edits. */
function raw(document: ReturnType<typeof wsFixture>) {
  return document as unknown as {
    servers: Record<string, Record<string, unknown>>;
    channels: Record<string, Record<string, unknown>>;
    components: { messages: Record<string, Record<string, unknown>> };
  };
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
      source: "server-extension",
    });
    expect(both.subprotocolKey).toBe("x-bun-jobs-subprotocol");
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
      ["workers", "workers"],
      ["queueWorkers", "queue/{queue}/workers"],
      ["runners", "runners"],
      ["runner", "runner/{runner}"],
    ]);
    const job = channel(both, "job");
    expect(job.parameters.map((parameter) => parameter.name)).toEqual([
      "queue",
      "jobId",
    ]);
    expect(job.parameters[1].description).toContain("encodeURIComponent");
    // The worker family: one namespace-wide channel and one per queue,
    // both carrying exactly the worker event messages.
    expect(channel(both, "workers").parameters).toEqual([]);
    expect(
      channel(both, "queueWorkers").parameters.map(
        (parameter) => parameter.name,
      ),
    ).toEqual(["queue"]);
    for (const key of ["workers", "queueWorkers"]) {
      expect(channel(both, key).messages).toEqual([
        "worker.control",
        "worker.state",
        "worker.config",
      ]);
    }
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
    // The fixture's events: 22 queue, 9 runner and 3 worker types.
    expect(events).toHaveLength(34);
    expect(both.messages.indexOf(events[0])).toBe(control.length);
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
    // A worker event is an event message, not a control one: `worker.control`
    // is named after the worker event type, and shares that name with the
    // runner's — the envelope's `kind` is what tells them apart.
    const workerTypes = ["control", "state", "config"];
    expect(
      workerTypes.map((type) => message(both, `worker.${type}`).event),
    ).toEqual(workerTypes.map((type) => ({ kind: "worker", type })));
    expect(control.map((entry) => entry.key)).not.toContain("worker.control");
  });

  it("reads x-bun-jobs-limits, -close-codes and -upgrade-refusals", () => {
    expect(both.extensionKeys).toEqual({
      security: undefined,
      limits: "x-bun-jobs-limits",
      closeCodes: "x-bun-jobs-close-codes",
      upgradeRefusals: "x-bun-jobs-upgrade-refusals",
    });
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
    expectUndefined(
      eventPayloadSchema(message(both, "subscribe").payload, root),
    );
  });

  it("reads the queue and runner parameter schemas, and none for a job id", () => {
    const [queue, jobId] = channel(both, "job").parameters;
    expect(queue.schema).toEqual({
      type: "string",
      pattern: "^(?!\\.\\.?$)[\\w.-]+$",
      maxLength: 200,
    });
    expectUndefined(jobId.schema);
    expect(channel(both, "runner").parameters[0].schema).toMatchObject({
      maxLength: 200,
    });
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
    // Workers belong to queues, so they go with them.
    expect(
      runner.messages.filter((entry) => entry.event?.kind === "worker"),
    ).toEqual([]);
    expect(
      runner.messages.filter((entry) => entry.event?.kind === "runner"),
    ).toHaveLength(9);
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
      "workers",
      "queueWorkers",
    ]);
    expect(secured.requirements).toEqual([
      [{ scheme: "session", scopes: [] }],
      [
        { scheme: "bearer", scopes: [] },
        { scheme: "apiKey", scopes: [] },
      ],
    ]);
    expect(secured.conjunctive).toBe(true);
    expect(secured.extensionKeys.security).toBe("x-bun-jobs-security");
    const schemes = Object.fromEntries(
      secured.securitySchemes.map((scheme) => [scheme.name, scheme]),
    );
    expect(schemes.bearer).toMatchObject({
      type: "http",
      detail: "bearer, JWT",
    });
    expect(schemes.bearer.note).toContain(
      "cannot send an Authorization header",
    );
    expect(schemes.apiKey).toMatchObject({
      type: "httpApiKey",
      detail: "header X-Api-Key",
    });
    expect(schemes.apiKey.note).toContain("X-Api-Key");
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
    servers.api.host = "{host}";
    servers.api.variables = { host: { default: "localhost:4000" } };
    const read = readWsDoc(document);
    expect(read.server).toMatchObject({
      host: "{host}",
      hostIsTemplate: true,
      hostDefault: "localhost:4000",
      url: "ws://localhost:4000/jobs-api/ws",
    });
  });

  it("without the security extension, reads the native list", () => {
    const document = wsFixture("jobs-secured");
    const servers = document.servers as Record<string, Record<string, unknown>>;
    delete servers.api["x-bun-jobs-security"];
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
    expectAbsent(read.limits);
    expectAbsent(read.server);
    expect(read.subprotocol).toEqual({
      value: undefined,
      fromDocument: false,
      source: "default",
    });
  });
});

describe("the extension prefixes", () => {
  it("reads the x-bun-common vocabulary", () => {
    const document = wsFixture("both");
    const connection = raw(document).channels.connection;
    connection["x-bun-common-limits"] = {
      maxMessageBytes: 65536,
      replay: false,
    };
    delete connection["x-bun-jobs-limits"];
    connection["x-bun-common-close-codes"] = [
      { code: 1000, name: "NORMAL", description: "Done." },
    ];
    delete connection["x-bun-jobs-close-codes"];
    const read = readWsDoc(document);
    expect(read.limits?.values).toEqual([["maxMessageBytes", 65536]]);
    expect(read.limits?.replay).toBe(false);
    expect(read.closeCodes).toEqual([
      { code: 1000, name: "NORMAL", description: "Done." },
    ]);
    expect(read.extensionKeys.limits).toBe("x-bun-common-limits");
    expect(read.extensionKeys.closeCodes).toBe("x-bun-common-close-codes");
  });

  it("the first prefix carrying an extension wins", () => {
    const document = wsFixture("both");
    const connection = raw(document).channels.connection;
    connection["x-bun-common-limits"] = { maxMessageBytes: 1 };
    connection["x-bun-jobs-limits"] = { maxMessageBytes: 2 };
    expect(readWsDoc(document).limits?.values).toEqual([
      ["maxMessageBytes", 1],
    ]);
    // The order is the caller's.
    expect(
      readWsDoc(document, { extensions: ["x-bun-jobs", "x-bun-common"] }).limits
        ?.values,
    ).toEqual([["maxMessageBytes", 2]]);
  });

  it("an extension under an unknown prefix is ignored, and nothing breaks", () => {
    const document = wsFixture("both");
    const connection = raw(document).channels.connection;
    delete connection["x-bun-jobs-limits"];
    delete connection["x-bun-jobs-close-codes"];
    delete connection["x-bun-jobs-upgrade-refusals"];
    connection["x-acme-limits"] = { maxWidgets: 3 };
    connection["x-acme-close-codes"] = [{ code: 4999, name: "ACME" }];
    const read = readWsDoc(document);
    expectAbsent(read.limits);
    expect(read.closeCodes).toEqual([]);
    expect(read.refusals).toEqual([]);
    expect(read.extensionKeys).toEqual({
      security: undefined,
      limits: undefined,
      closeCodes: undefined,
      upgradeRefusals: undefined,
    });
    // The sidebar simply has no Connection group.
    expect(navGroups(read).map((group) => group.title)).not.toContain(
      "Connection",
    );
    // …unless the caller's prefix list names it.
    const acme = readWsDoc(document, { extensions: ["x-acme"] });
    expect(acme.limits?.values).toEqual([["maxWidgets", 3]]);
    expect(acme.closeCodes.map((entry) => entry.name)).toEqual(["ACME"]);
  });

  it("reads an operation's permission and a parameter's schema from the configured prefix", () => {
    const document = wsFixture("both");
    const operations = (
      document as unknown as {
        operations: Record<string, Record<string, unknown>>;
      }
    ).operations;
    delete operations.subscribe["x-bun-jobs-action"];
    operations.subscribe["x-acme-action"] = "acme.subscribe";
    const parameters = raw(document).channels.queue.parameters as Record<
      string,
      Record<string, unknown>
    >;
    delete parameters.queue["x-bun-jobs-schema"];
    parameters.queue["x-acme-schema"] = { type: "string", maxLength: 7 };

    const plain = readWsDoc(document);
    expectUndefined(
      plain.operations.find((entry) => entry.key === "subscribe")!.permission,
    );
    expectUndefined(channel(plain, "queue").parameters[0].schema);

    const acme = readWsDoc(document, { extensions: ["x-acme"] });
    expect(
      acme.operations.find((entry) => entry.key === "subscribe")!.permission,
    ).toBe("acme.subscribe");
    expect(channel(acme, "queue").parameters[0].schema).toEqual({
      type: "string",
      maxLength: 7,
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
    expect(groups[0].items.map((item) => item.slug)).toEqual([
      "limits",
      "close-codes",
      "upgrade-refusals",
    ]);
    // The hint names the extension the panel was read from.
    expect(groups[0].items.map((item) => item.hint)).toEqual([
      "x-bun-jobs-limits",
      "x-bun-jobs-close-codes",
      "x-bun-jobs-upgrade-refusals",
    ]);
    expect(groups[1].items[4]).toMatchObject({
      slug: "channel-job",
      label: "Job",
      hint: "queue/{queue}/job/{jobId}",
    });
    expect(groups[4].items.map((item) => item.slug)).toContain(
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
    expectAbsent(selectItem(both, "channel-nope"));
    expectAbsent(selectItem(runner, "channel-queue"));
    expect(itemPath("message-queue.completed")).toBe(
      "/ws/message-queue.completed",
    );
    expect(itemPath("limits", "rate limit")).toBe("/ws/limits?q=rate+limit");
  });
});

describe("the cross-references", () => {
  it("lists the operations on a channel and the channels carrying a message", () => {
    expect(operationsOn(both, "connection").map((entry) => entry.key)).toEqual([
      "subscribe",
      "unsubscribe",
      "ping",
      "receiveControl",
    ]);
    expect(
      channelsCarrying(both, "queue.completed").map((entry) => entry.key),
    ).toEqual(["all", "queues", "queue", "job"]);
    expect(
      operationsUsing(both, "queue.completed").map((entry) => entry.key),
    ).toEqual([
      "receiveAllEvents",
      "receiveQueuesEvents",
      "receiveQueueEvents",
      "receiveJobEvents",
    ]);
    expect(operationsUsing(both, "ack").map((entry) => entry.key)).toEqual([
      "subscribe",
      "unsubscribe",
    ]);
  });
});

describe("the subprotocol (<prefix>-subprotocol, then prose, then the default)", () => {
  it("prefers servers.api's extension over the connection channel's", () => {
    const document = wsFixture("both");
    raw(document).servers.api["x-bun-jobs-subprotocol"] = "from-server.v9";
    raw(document).channels.connection["x-bun-jobs-subprotocol"] =
      "from-channel.v9";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-server.v9",
      fromDocument: true,
      source: "server-extension",
    });
  });

  it("reads the connection channel's extension when the server has none", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api["x-bun-jobs-subprotocol"];
    raw(document).channels.connection["x-bun-jobs-subprotocol"] =
      "from-channel.v9";
    raw(document).channels.connection.description =
      "Uses the subprotocol `from-prose.v9`.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-channel.v9",
      fromDocument: true,
      source: "connection-extension",
    });
  });

  it("falls back to the connection channel's prose", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api["x-bun-jobs-subprotocol"];
    delete raw(document).channels.connection["x-bun-jobs-subprotocol"];
    raw(document).channels.connection.description =
      "The socket. Offer the subprotocol `from-prose.v9`, or none.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: "from-prose.v9",
      fromDocument: true,
      source: "connection-prose",
    });
  });

  it("uses the configured default when the document says nothing", () => {
    const document = wsFixture("both");
    delete raw(document).servers.api["x-bun-jobs-subprotocol"];
    delete raw(document).channels.connection["x-bun-jobs-subprotocol"];
    raw(document).channels.connection.description = "The socket.";
    expect(readWsDoc(document).subprotocol).toEqual({
      value: undefined,
      fromDocument: false,
      source: "default",
    });
    expect(
      readWsDoc(document, { defaultSubprotocol: "bun-jobs.v1" }).subprotocol,
    ).toEqual({
      value: "bun-jobs.v1",
      fromDocument: false,
      source: "default",
    });
  });

  it("ignores a non-string extension", () => {
    const document = wsFixture("both");
    raw(document).servers.api["x-bun-jobs-subprotocol"] = 1;
    raw(document).channels.connection["x-bun-jobs-subprotocol"] = null;
    expect(readWsDoc(document).subprotocol.source).toBe("connection-prose");
  });

  it("names each source in words, as the server panel shows it", () => {
    const words = (mutate: (document: ReturnType<typeof raw>) => void) => {
      const document = wsFixture("both");
      mutate(raw(document));
      return subprotocolSource(readWsDoc(document));
    };
    expect(words(() => {})).toBe("from servers.api (x-bun-jobs-subprotocol)");
    expect(
      words((document) => {
        delete document.servers.api["x-bun-jobs-subprotocol"];
      }),
    ).toBe("from the connection channel (x-bun-jobs-subprotocol)");
    expect(
      words((document) => {
        delete document.servers.api["x-bun-jobs-subprotocol"];
        delete document.channels.connection["x-bun-jobs-subprotocol"];
      }),
    ).toBe("from the connection channel's description");
    expect(
      words((document) => {
        delete document.servers.api["x-bun-jobs-subprotocol"];
        delete document.channels.connection["x-bun-jobs-subprotocol"];
        document.channels.connection.description = "The socket.";
      }),
    ).toBe("not stated in the document");
    // A server under another key is named by its own key.
    expect(
      words((document) => {
        document.servers = { edge: document.servers.api };
      }),
    ).toBe("from servers.edge (x-bun-jobs-subprotocol)");
  });
});

describe("message examples", () => {
  it("reads one example per message from the real document", () => {
    const control = both.messages.filter((entry) => entry.event === null);
    const events = both.messages.filter((entry) => entry.event !== null);
    expect(control).toHaveLength(9);
    expect(events).toHaveLength(34);
    for (const entry of both.messages) {
      expect(entry.examples).toHaveLength(1);
      expect(entry.examples[0].name).toBe(entry.key);
      expect(entry.examples[0].summary).toBeTruthy();
    }
    const completed = message(both, "queue.completed").examples[0];
    expect(completed.payload).toMatchObject({
      type: "event",
      event: { kind: "queue", type: "completed" },
    });
  });

  it("finds an event example's event.payload", () => {
    const completed = message(both, "queue.completed").examples[0];
    expect(exampleEventPayload(completed.payload)).toMatchObject({
      id: "welcome:ada@example.com",
      returnValue: {},
    });
    expectUndefined(
      exampleEventPayload(message(both, "subscribe").examples[0].payload),
    );
    expectUndefined(exampleEventPayload(null));
    expectUndefined(exampleEventPayload({ event: 3 }));
  });

  it("drops malformed examples rather than throwing", () => {
    const document = wsFixture("both");
    raw(document).components.messages.hello.examples = [
      null,
      "x",
      { name: 3, payload: { type: "hello" } },
    ];
    expect(message(readWsDoc(document), "hello").examples).toEqual([
      { name: undefined, summary: undefined, payload: { type: "hello" } },
    ]);
  });
});
