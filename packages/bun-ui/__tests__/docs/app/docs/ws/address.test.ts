import { describe, expect, it } from "bun:test";
import type { WsAddressOptions } from "../../../../app/screens/docs/ws/model";
import {
  channelEventTypes,
  channelSubscribable,
  fillAddress,
  parameterProblem,
  parameterSchemas,
  readWsDoc,
  tryProblems,
} from "../../../../app/screens/docs/ws/model";
import { expectAbsent, expectUndefined } from "../../assert";
import { wsFixture } from "./fixtures";

const both = readWsDoc(wsFixture("both"));

/** A channel of the read document, by key. */
function channel(key: string) {
  const found = both.channels.find((candidate) => candidate.key === key);
  if (!found) {
    throw new Error(`no channel ${key}`);
  }
  return found;
}

/** A bun-jobs-flavoured address contract, as bun-jobs-ui passes it. */
const JOBS_LIKE: WsAddressOptions = {
  nameRule: (name, value) =>
    name === "jobId" || /^[\w.-]+$/.test(value) ? null : "bad name",
  patternText: {
    "^(?!\\.\\.?$)[\\w.-]+$": 'Letters, digits, "_", "." and "-" only.',
  },
  escapeValue: (name, value) =>
    name === "jobId" ? encodeURIComponent(value) : value,
};

describe("the try-it machinery (seam of the console the host injects)", () => {
  it("fills an address template, escaping by the host's rule", () => {
    expect(fillAddress("queue/{queue}", { queue: "mail" })).toBe("queue/mail");
    expect(
      fillAddress(
        "queue/{queue}/job/{jobId}",
        { queue: "mail", jobId: "a/b c%" },
        parameterSchemas(channel("job").parameters),
        JOBS_LIKE,
      ),
    ).toBe(`queue/mail/job/${encodeURIComponent("a/b c%")}`);
    // Without the host's rule, values fill as they are.
    expect(
      fillAddress("queue/{queue}/job/{jobId}", { queue: "mail", jobId: "a/b" }),
    ).toBe("queue/mail/job/a/b");
    // A missing value never fills.
    expectAbsent(fillAddress("queue/{queue}/job/{jobId}", { queue: "mail" }));
  });

  it("the document's schema decides when it gives one, the host's rule otherwise", () => {
    const [queue] = channel("job").parameters;
    // The document's schema (the real one) refuses what breaks its pattern.
    expect(parameterProblem("queue", "has space", queue.schema)).toBe(
      "Must match ^(?!\\.\\.?$)[\\w.-]+$.",
    );
    // …with the host's friendlier wording for a pattern it knows.
    expect(
      parameterProblem("queue", "has space", queue.schema, JOBS_LIKE),
    ).toBe('Letters, digits, "_", "." and "-" only.');
    expectAbsent(parameterProblem("queue", "mail.v2-x_1", queue.schema));
    // Lengths count code points.
    expect(parameterProblem("queue", "abc", { maxLength: 2 })).toBe(
      "At most 2 characters (this is 3).",
    );
    expect(parameterProblem("queue", "a", { minLength: 2 })).toBe(
      "At least 2 characters.",
    );
    // A pattern that does not compile is skipped, not a refusal of everything.
    expectAbsent(parameterProblem("queue", "a b", { pattern: "(" }));
    // No schema: the host's rule, or anything goes.
    expectAbsent(parameterProblem("queue", "has space"));
    expect(parameterProblem("queue", "has space", undefined, JOBS_LIKE)).toBe(
      "bad name",
    );
    expectAbsent(
      parameterProblem("jobId", "any / thing", undefined, JOBS_LIKE),
    );
    // Empty is never refused (the form marks it missing instead).
    expectAbsent(parameterProblem("queue", "", { maxLength: 1 }));
  });

  it("lists every empty or refused parameter, in template order", () => {
    const job = channel("job");
    expect(tryProblems(job, {})).toEqual([
      "queue: fill it in.",
      "jobId: fill it in.",
    ]);
    expect(tryProblems(job, { queue: "mail", jobId: "42" })).toEqual([]);
    expect(
      tryProblems(job, { queue: "has space", jobId: "42" }, JOBS_LIKE),
    ).toEqual(['queue: Letters, digits, "_", "." and "-" only.']);
  });

  it("only a logical channel is subscribable: not the connection, under any key, nor a socket path", () => {
    expect(
      both.channels
        .filter((entry) => !channelSubscribable(entry))
        .map((entry) => entry.key),
    ).toEqual(["connection"]);
  });

  it("reads the event types a channel carries, de-duplicated", () => {
    expect(channelEventTypes(both, channel("job"))).toContain("completed");
    expect(channelEventTypes(both, channel("job"))).not.toContain("paused");
    expect(channelEventTypes(both, channel("connection"))).toEqual([]);
  });

  it("parameterSchemas maps the parameters' schemas by name", () => {
    const schemas = parameterSchemas(channel("job").parameters);
    expect(schemas.queue).toMatchObject({ maxLength: 200 });
    expectUndefined(schemas.jobId);
  });
});
