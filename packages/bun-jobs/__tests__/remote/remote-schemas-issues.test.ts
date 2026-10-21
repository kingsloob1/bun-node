import { describe, expect, it } from "bun:test";
import {
  parseRemoteMessage,
  parseRemoteRequest,
  parseRemoteResponse,
} from "../../lib/remote/schemas";

/**
 * The exact issues the protocol's parsers report: their paths (dotted, an
 * array index as its number) and messages, which the executor puts in a
 * `VALIDATION` problem frame for the peer that sent the message. Pinned so a
 * change to how issues are flattened shows here first.
 */

const FENCE = "h7f3-4211-1789:1790000000400";
/** A valid job of an invoke. */
const JOB = {
  id: "J1",
  name: "resize",
  data: {},
  attempt: 1,
  idempotencyKey: "k",
  fence: FENCE,
  delivery: 1,
};
/** A valid invoke envelope. */
const INVOKE = {
  v: 1,
  op: "invoke",
  id: "inv",
  now: 1,
  deadlineAt: 2,
  namespace: "shop",
  queue: "media",
  worker: { id: "w", key: "k" },
  jobs: [JOB],
};
/** A valid welcome message. */
const WELCOME = {
  op: "welcome",
  v: 1,
  protocol: 1,
  role: "executor",
  nonce: "Ym9iX2V4ZWN1dG9yX25vbg",
  names: ["resize"],
  maxBatch: 1,
  maxDurationMs: 1,
  capacity: { inFlight: 0, max: 1 },
  now: 1,
};

describe("the remote parsers' issues", () => {
  it("accepts the fixtures, so every refusal below is the patch's", () => {
    expect(parseRemoteRequest(INVOKE).ok).toBe(true);
    expect(parseRemoteMessage(WELCOME).ok).toBe(true);
  });

  it("a nested path is dotted", () => {
    expect(parseRemoteRequest({ ...INVOKE, worker: { id: "w" } })).toEqual({
      ok: false,
      issues: [{ path: "worker.key", message: "Required" }],
    });
  });

  it("an array index is a path segment", () => {
    expect(
      parseRemoteRequest({ ...INVOKE, jobs: [{ ...JOB, attempt: 0 }] }),
    ).toEqual({
      ok: false,
      issues: [
        { path: "jobs.0.attempt", message: "Expected a value of at least 1" },
      ],
    });
    expect(
      parseRemoteRequest({
        ...INVOKE,
        jobs: [JOB, { ...JOB, id: "J2", fence: "nofence" }],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "jobs.1.fence",
          message: String.raw`Expected a value matching ^\S+:\d{1,16}$`,
        },
      ],
    });
  });

  it("the message itself (no object, no op) is refused at op, as the executor matches", () => {
    for (const value of [{ op: "nope" }, "x", null, [INVOKE]]) {
      expect(parseRemoteRequest(value)).toEqual({
        ok: false,
        issues: [{ path: "op", message: "Unsupported op" }],
      });
    }
  });

  it("several issues keep their order", () => {
    expect(parseRemoteRequest({ ...INVOKE, v: 2, now: -1, jobs: [] })).toEqual({
      ok: false,
      issues: [
        { path: "v", message: "Expected 1" },
        { path: "now", message: "Expected a value of at least 0" },
        { path: "jobs", message: "Expected at least 1 items" },
      ],
    });
  });

  it("a union that no member accepts names the members' types", () => {
    expect(
      parseRemoteResponse({
        v: 1,
        op: "status-result",
        id: "s",
        jobs: [
          {
            queue: { ns: "a", queue: "b" },
            job: "J",
            attempt: 1,
            state: "done",
            outcome: { op: "rejected", code: "BUSY" },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "jobs.0.outcome",
          message: "Expected object or object, received object",
        },
      ],
    });
  });

  it("an enum's literals stay in its message while another field holds one", () => {
    // `name` holds "gateway", one of `role`'s literals: the message is the
    // schema's words, not the received value.
    expect(
      parseRemoteMessage({ ...WELCOME, role: "boss", name: "gateway" }),
    ).toEqual({
      ok: false,
      issues: [
        { path: "role", message: 'Expected one of "gateway", "executor"' },
      ],
    });
  });

  it("a literal's message is kept", () => {
    expect(parseRemoteRequest({ ...INVOKE, kind: "run" })).toEqual({
      ok: false,
      issues: [{ path: "kind", message: 'Expected "job"' }],
    });
  });

  it("a message that quotes the received value", () => {
    // The builder never quotes a value, but its type message names the
    // expected type, so a value spelling that type appears in it verbatim.
    expect(parseRemoteRequest({ ...INVOKE, now: "integer" })).toEqual({
      ok: false,
      issues: [{ path: "now", message: "Expected integer, received string" }],
    });
  });

  it("a literal equal to a key of the object holding the field", () => {
    // Objects keep unknown keys, so a sender can add a `job` beside `kind`.
    expect(parseRemoteRequest({ ...INVOKE, kind: "run", job: 1 })).toEqual({
      ok: false,
      issues: [{ path: "kind", message: 'Expected "job"' }],
    });
  });
});
