import type { JobsApiAction } from "../../../app/api/contract";
import { describe, expect, it } from "bun:test";
import {
  WORKER_BLOCKED_HINT,
  workerActionGates,
} from "../../../app/screens/workers/actions/gating";
import { workerFixture } from "./fixtures";

/** Every worker action permitted. */
const ALL = () => true;
/** No action permitted (a read-only API, or a caller without them). */
const NONE = () => false;

/** Permits only the named actions. */
function only(...allowed: JobsApiAction[]) {
  return (action: JobsApiAction) => allowed.includes(action);
}

describe("workerActionGates", () => {
  it("offers pause and stop to a running worker, resume and stop to a paused one", () => {
    const running = workerActionGates(workerFixture(), ALL);
    expect(running).toMatchObject({
      pause: true,
      resume: false,
      stop: true,
      start: false,
      configure: true,
      blocked: null,
    });
    const paused = workerActionGates(
      workerFixture({ state: "paused", paused: true }),
      ALL,
    );
    expect(paused).toMatchObject({ pause: false, resume: true, stop: true });
  });

  it("offers only start to a stopped worker", () => {
    const gates = workerActionGates(workerFixture({ state: "stopped" }), ALL);
    expect(gates).toMatchObject({
      pause: false,
      resume: false,
      stop: false,
      start: true,
    });
  });

  it("offers nothing mid-transition, and says why", () => {
    for (const state of ["stopping", "restarting"] as const) {
      const gates = workerActionGates(workerFixture({ state }), ALL);
      expect(gates).toMatchObject({
        pause: false,
        resume: false,
        stop: false,
        start: false,
        blocked: "transitioning",
      });
      // Settings still apply: they are stored for whichever replica is next.
      expect(gates.configure).toBe(true);
    }
    expect(WORKER_BLOCKED_HINT.transitioning).toContain("between states");
  });

  it("offers no lifecycle action to a worker that stopped reporting", () => {
    const stale = workerActionGates(workerFixture({ stale: true }), ALL);
    expect(stale).toMatchObject({
      pause: false,
      stop: false,
      blocked: "stale",
    });
    expect(stale.configure).toBe(true);
    // An API that sends no `stale` flag: a lapsed `expiresAt` says the same.
    const lapsed = workerFixture({ stale: undefined });
    lapsed.expiresAt = Date.now() - 1;
    expect(workerActionGates(lapsed, ALL).pause).toBe(false);
  });

  it("offers nothing at all for a worker the API cannot control", () => {
    const off = workerActionGates(
      workerFixture({
        control: { ...workerFixture().control!, enabled: false },
      }),
      ALL,
    );
    expect(off).toMatchObject({
      pause: false,
      stop: false,
      configure: false,
      blocked: "uncontrollable",
    });
    // An older worker sends no `control` at all.
    expect(
      workerActionGates(workerFixture({ control: undefined }), ALL).blocked,
    ).toBe("uncontrollable");
  });

  it("follows the caller's permissions, one action at a time", () => {
    expect(workerActionGates(workerFixture(), NONE)).toMatchObject({
      pause: false,
      stop: false,
      configure: false,
      blocked: null,
    });
    expect(
      workerActionGates(workerFixture(), only("workers.pause")),
    ).toMatchObject({ pause: true, stop: false, configure: false });
  });

  it("does not offer settings for a worker that reports no stable key", () => {
    expect(
      workerActionGates(workerFixture({ key: undefined }), ALL).configure,
    ).toBe(false);
  });
});
