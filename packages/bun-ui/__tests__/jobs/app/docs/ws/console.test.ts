import {
  EVENT_TYPES,
  QUEUE_EVENT_TYPES,
  WORKER_EVENT_TYPES,
} from "@kingsleyweb/bun-jobs/api/contract";
import { wsModel } from "@kingsleyweb/bun-api-docs-ui/embed";
import { describe, expect, it } from "bun:test";
import { liveChannels } from "../../../../app/live";
import { eventsConsole } from "../../../../app/screens/docs/ws/console";
import {
  eventsLink,
  isKnownAction,
} from "../../../../app/screens/docs/ws/links";
import { JOBS_ADDRESS } from "../../../../app/screens/docs/ws/address";
import { expectAbsent, expectUndefined } from "../../assert";
import { wsFixture } from "./fixtures";

const both = wsModel.readWsDoc(wsFixture("both"));
const runner = wsModel.readWsDoc(wsFixture("runner"));

/** A channel of the read document, by key. */
function channel(doc: typeof both, key: string) {
  const found = doc.channels.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no channel ${key}`);
  }
  return found;
}

/** A message of the read document, by key. */
function message(doc: typeof both, key: string) {
  const found = doc.messages.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no message ${key}`);
  }
  return found;
}

describe("the console links", () => {
  it("links a filled channel into the console, filtering types only when the channel narrows them", () => {
    const console = eventsConsole("both", true);
    // `all` carries every type the document declares; the console offers
    // EVENT_TYPES, so the link narrows to the document's list.
    const allLink = new URLSearchParams(
      console
        .channelLink(
          "all",
          wsModel.channelEventTypes(both, channel(both, "all")),
        )!
        .split("?")[1],
    );
    expect(allLink.get("channel")).toBe("all");
    expect(allLink.get("types")?.split(",")).toEqual([
      ...wsModel.channelEventTypes(both, channel(both, "all")),
    ]);
    expect(eventsLink("all", EVENT_TYPES, "both")).toBe("/events?channel=all");
    expect(eventsLink("queues", [], "both")).toBe("/events?channel=queues");
    // The worker channels carry every worker type the console offers for
    // them, so neither needs a filter.
    expect(wsModel.channelEventTypes(both, channel(both, "workers"))).toEqual([
      ...WORKER_EVENT_TYPES,
    ]);
    expect(eventsLink("queue/mail", [], "both")).toBe(
      "/events?channel=queue%2Fmail",
    );
    expectAbsent(console.channelLink("connection", []));
  });

  it("gives no link for a channel the console cannot open in the mode", () => {
    expectAbsent(eventsLink("all", [], "jobs"));
    expectAbsent(eventsLink("runner/x", [], "jobs"));
    expect(eventsLink("queue/x", ["completed"], "jobs")).toBe(
      "/events?channel=queue%2Fx&types=completed",
    );
  });

  it("links an event message to its kind's broad channel, filtered to its type", () => {
    const console = eventsConsole("both", true);
    expect(console.messageLink(message(both, "queue.completed"), both)).toBe(
      "/events?channel=queues&types=completed",
    );
    expect(
      eventsConsole("runner", true).messageLink(
        message(runner, "runner.killed"),
        runner,
      ),
    ).toBe("/events?channel=runners&types=killed");
    // A worker event's broad channel is `workers`, not `all` or `queues`.
    expect(console.messageLink(message(both, "worker.state"), both)).toBe(
      "/events?channel=workers&types=state",
    );
    expectAbsent(console.messageLink(message(both, "hello"), both));
  });

  it("marks only the API's own actions as known", () => {
    expect(isKnownAction("events.subscribe")).toBe(true);
    expect(isKnownAction("made.up")).toBe(false);
  });
});

describe("the address contract (JOBS_ADDRESS)", () => {
  it("fills a job address exactly as the live client names job channels", () => {
    for (const id of ["42", "a/b c%", "ümlaut?&=#", "￭lone", "x"]) {
      expect(
        wsModel.fillAddress(
          "queue/{queue}/job/{jobId}",
          { queue: "mail", jobId: id },
          {},
          JOBS_ADDRESS,
        ),
      ).toBe(liveChannels.job("mail", id));
    }
    expect(
      wsModel.fillAddress("queue/{queue}", { queue: "mail" }, {}, JOBS_ADDRESS),
    ).toBe(liveChannels.queue("mail"));
    expect(
      wsModel.fillAddress(
        "runner/{runner}",
        { runner: "nightly.v2" },
        {},
        JOBS_ADDRESS,
      ),
    ).toBe(liveChannels.runner("nightly.v2"));
  });

  it("refuses an incomplete address or an invalid name", () => {
    expectAbsent(
      wsModel.fillAddress(
        "queue/{queue}/job/{jobId}",
        { queue: "mail" },
        {},
        JOBS_ADDRESS,
      ),
    );
    expectAbsent(
      wsModel.fillAddress(
        "queue/{queue}",
        { queue: "has space" },
        {},
        JOBS_ADDRESS,
      ),
    );
    expectAbsent(
      wsModel.fillAddress("queue/{queue}", { queue: ".." }, {}, JOBS_ADDRESS),
    );
    expectAbsent(
      wsModel.fillAddress(
        "queue/{queue}",
        { queue: "x".repeat(201) },
        {},
        JOBS_ADDRESS,
      ),
    );
    expect(
      wsModel.parameterProblem("queue", "has/slash", undefined, JOBS_ADDRESS),
    ).not.toBeNull();
    expectAbsent(
      wsModel.parameterProblem("queue", "", undefined, JOBS_ADDRESS),
    );
    expectAbsent(
      wsModel.parameterProblem("jobId", "any / thing", undefined, JOBS_ADDRESS),
    );
  });

  it("the document's schema decides when it gives one, with the contract's wording", () => {
    const strict = { pattern: "^[a-z]+$", maxLength: 5 };
    // Accepted by the contract's rule, refused by the document's.
    expectAbsent(
      wsModel.parameterProblem("queue", "a.b", undefined, JOBS_ADDRESS),
    );
    expect(wsModel.parameterProblem("queue", "a.b", strict, JOBS_ADDRESS)).toBe(
      "Must match ^[a-z]+$.",
    );
    expect(
      wsModel.parameterProblem("queue", "abcdef", strict, JOBS_ADDRESS),
    ).toBe("At most 5 characters (this is 6).");
    // A job id is held to a schema too, when the document gives it one.
    expect(
      wsModel.parameterProblem("jobId", "a/b", strict, JOBS_ADDRESS),
    ).not.toBeNull();
  });

  it("the real schema refuses what the server refuses, worded as the contract", () => {
    const schema = channel(both, "queue").parameters[0].schema;
    expectAbsent(
      wsModel.parameterProblem("queue", "mail.v2-x_1", schema, JOBS_ADDRESS),
    );
    for (const bad of [".", "..", "a/b", "has space", "ümlaut"]) {
      expect(
        wsModel.parameterProblem("queue", bad, schema, JOBS_ADDRESS),
      ).toContain("Letters, digits");
    }
    expectAbsent(
      wsModel.parameterProblem("queue", "x".repeat(200), schema, JOBS_ADDRESS),
    );
    expect(
      wsModel.parameterProblem("queue", "x".repeat(201), schema, JOBS_ADDRESS),
    ).toBe("At most 200 characters (this is 201).");
  });

  it("an older API without the extension keeps the contract's rule", () => {
    const document = wsFixture("both") as unknown as {
      channels: Record<
        string,
        { parameters?: Record<string, Record<string, unknown>> }
      >;
    };
    delete document.channels.queue.parameters!.queue["x-bun-jobs-schema"];
    const read = wsModel.readWsDoc(document);
    const queue = channel(read, "queue");
    expectUndefined(queue.parameters[0].schema);
    expect(
      wsModel.tryProblems(queue, { queue: "x".repeat(201) }, JOBS_ADDRESS)[0],
    ).toContain("Letters, digits");
    expect(wsModel.tryProblems(queue, { queue: "mail" }, JOBS_ADDRESS)).toEqual(
      [],
    );
  });

  it("lists every empty or refused parameter, in template order", () => {
    const job = channel(both, "job");
    expect(wsModel.tryProblems(job, {}, JOBS_ADDRESS)).toEqual([
      "queue: fill it in.",
      "jobId: fill it in.",
    ]);
    expect(
      wsModel.tryProblems(
        job,
        { queue: "..", jobId: "any / thing" },
        JOBS_ADDRESS,
      ),
    ).toEqual([
      'queue: Letters, digits, "_", "." and "-" only (not "." or "..").',
    ]);
  });

  it("the event types a channel carries, for the link's filter", () => {
    const jobTypes = wsModel.channelEventTypes(both, channel(both, "job"));
    expect(jobTypes).toContain("completed");
    expect(jobTypes).not.toContain("paused");
    expect(QUEUE_EVENT_TYPES).toContain("completed");
  });
});
