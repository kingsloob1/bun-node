import type { WorkerDto } from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { sweepWarning } from "../../../app/screens/workers/sweeps";

/**
 * The three-state rule behind the queue panel's housekeeping note. It is a
 * pure function on purpose: the interesting case — every live worker too old
 * to report `sweeps` — renders *nothing*, and "nothing rendered" is the one
 * assertion a DOM test cannot tell apart from a component that never ran.
 */

/** A live worker, with `sweeps` set only when the argument says so. */
function worker(sweeps?: boolean): WorkerDto {
  const base = {
    id: "api.emails.1",
    key: "api.emails",
    queue: "emails",
    concurrency: 1,
    active: 0,
    paused: false,
    startedAt: 0,
    heartbeatAt: 0,
    expiresAt: 0,
  } as unknown as WorkerDto;
  return sweeps === undefined ? base : { ...base, sweeps };
}

describe("the housekeeping warning", () => {
  it("says nothing when no live worker reports the field", () => {
    // Absent is not `false`: these workers predate `sweeps` and have said
    // nothing. Warning here would make every fleet mid-upgrade read as
    // misconfigured.
    expect(sweepWarning([worker(), worker()])).toBeNull();
    expect(sweepWarning([])).toBeNull();
  });

  it("says nothing when any live worker reports that it sweeps", () => {
    expect(sweepWarning([worker(false), worker(true)])).toBeNull();
    expect(sweepWarning([worker(true)])).toBeNull();
    expect(sweepWarning([worker(true), worker()])).toBeNull();
  });

  it("warns, without hedging, when every live worker reports `false`", () => {
    const warning = sweepWarning([worker(false), worker(false)]);
    expect(warning?.uncertain).toBe(false);
    expect(warning?.message).toContain(
      "No live worker on this queue runs housekeeping",
    );
  });

  it("hedges when some live workers are too old to say", () => {
    const warning = sweepWarning([worker(false), worker()]);
    expect(warning?.uncertain).toBe(true);
    expect(warning?.message).toContain("there may be nobody doing it");
  });

  it("describes the consequence as untidiness, never as a stuck queue", () => {
    const warning = sweepWarning([worker(false)]);
    // Liveness is not optional in bun-jobs: a queue nobody sweeps still runs
    // its jobs. The note must not be readable as "this queue is broken".
    expect(warning?.message).toContain("Jobs still run");
    expect(warning?.message).toContain("delayed jobs are promoted");
    expect(warning?.message).toContain("stalled ones recovered");
    expect(warning?.message).toContain("expired results");
    expect(warning?.message).not.toContain("stuck");
  });
});
