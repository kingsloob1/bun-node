import { describe, expect, it } from "bun:test";
import { createApiClient } from "../../app/api/client";
import { ApiError, isApiError } from "../../app/api/errors";
import { getJob } from "../../app/api/jobs";
import { getQueue } from "../../app/api/queues";
import { getRunner } from "../../app/api/runners";
import { assertShape } from "../../app/api/shape";
import { displayText, INVALID_TEXT } from "../../app/format";
import { shouldRetry } from "../../app/queryClient";
import { jobFixture } from "./job/fixtures";
import { mockFetch } from "./mockFetch";

/** A client whose every `GET` of `path` answers `body` (200, JSON). */
function clientAnswering(path: string, body: unknown) {
  const mock = mockFetch({ [`GET ${path}`]: { body } });
  return createApiClient(
    { apiBase: "/jobs-api", csrfHeader: null },
    { fetch: mock.fetch },
  );
}

/** Awaits a rejection and returns it as an ApiError. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Bodies that are not a detail of anything. */
const MALFORMED: ReadonlyArray<[string, unknown]> = [
  ["{}", {}],
  ["[]", []],
  ["a string", "text"],
  ["null", null],
];

/** Each guarded read: its path, a good body, and how to call it. */
const READS = [
  {
    name: "getJob",
    path: "/queues/emails/jobs/j1",
    good: jobFixture("waiting", { id: "j1" }),
    read: (api: ReturnType<typeof clientAnswering>) =>
      getJob(api, "emails", "j1"),
  },
  {
    name: "getRunner",
    path: "/runners/nightly",
    good: { id: "nightly", name: "Nightly report" },
    read: (api: ReturnType<typeof clientAnswering>) =>
      getRunner(api, "nightly"),
  },
  {
    name: "getQueue",
    path: "/queues/emails",
    good: {
      name: "emails",
      paused: false,
      total: 3,
      counts: {},
    },
    read: (api: ReturnType<typeof clientAnswering>) => getQueue(api, "emails"),
  },
];

describe("response shape guards", () => {
  for (const { name, path, good, read } of READS) {
    for (const [label, body] of MALFORMED) {
      it(`${name} rejects ${label} as an unexpected response`, async () => {
        const error = await rejection(read(clientAnswering(path, body)));
        expect(error.kind).toBe("parse");
        expect(error.code).toBe("UNEXPECTED_RESPONSE");
        expect(error.title).toBe("The API answered an unexpected response");
        expect(error.instance).toBe(path);
      });
    }
    it(`${name} resolves a good body as-is`, async () => {
      expect(await read(clientAnswering(path, good))).toEqual(good as never);
    });
  }

  it("getJob rejects a job whose name is an object, or whose state is unknown", async () => {
    const path = "/queues/emails/jobs/j1";
    for (const overrides of [{ name: { first: "x" } }, { state: "lost" }]) {
      const body = { ...jobFixture("waiting", { id: "j1" }), ...overrides };
      const error = await rejection(
        getJob(clientAnswering(path, body), "emails", "j1"),
      );
      expect(error.code).toBe("UNEXPECTED_RESPONSE");
    }
  });

  it("assertShape says what arrived instead", () => {
    const detail = (value: unknown) => {
      try {
        assertShape(value, () => true, "a job", "/x");
      } catch (error) {
        return isApiError(error) ? error.detail : "not an ApiError";
      }
      return "passed";
    };
    expect(detail([])).toBe("Expected a job, got an array.");
    expect(detail("text")).toBe("Expected a job, got a string.");
    expect(detail(null)).toBe("Expected a job, got null.");
    expect(detail({})).toBe("passed");
  });
});

describe("displayText", () => {
  it("keeps text, stringifies scalars, and replaces anything React cannot render", () => {
    expect(displayText("send-welcome")).toBe("send-welcome");
    expect(displayText(42)).toBe("42");
    expect(displayText(false)).toBe("false");
    expect(displayText({ first: "x" })).toBe(INVALID_TEXT);
    expect(displayText(["a"])).toBe(INVALID_TEXT);
    expect(displayText(null)).toBe(INVALID_TEXT);
    expect(displayText(undefined)).toBe(INVALID_TEXT);
  });
});

describe("shouldRetry", () => {
  const error = (kind: ApiError["kind"], status: number, code: string) =>
    new ApiError({ kind, status, code, title: code });

  it("never retries a malformed response: asking again gets the same body", () => {
    expect(shouldRetry(0, error("parse", 200, "UNEXPECTED_RESPONSE"))).toBe(
      false,
    );
    expect(shouldRetry(0, error("parse", 200, "INVALID_RESPONSE"))).toBe(false);
  });

  it("never retries a 4xx, and retries network failures and 5xx twice", () => {
    expect(shouldRetry(0, error("problem", 404, "JOB_NOT_FOUND"))).toBe(false);
    expect(shouldRetry(0, error("network", 0, "NETWORK_ERROR"))).toBe(true);
    expect(shouldRetry(1, error("problem", 503, "DRIVER_ERROR"))).toBe(true);
    expect(shouldRetry(2, error("problem", 503, "DRIVER_ERROR"))).toBe(false);
  });
});
