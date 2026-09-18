import {
  JOB_STATES as PKG_API_JOB_STATES,
  JOBS_API_ACTIONS as PKG_JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS as PKG_JOBS_API_MUTATIONS,
  JOBS_API_PROTOCOL_VERSION as PKG_JOBS_API_PROTOCOL_VERSION,
  JOBS_API_WS_SUBPROTOCOL as PKG_JOBS_API_WS_SUBPROTOCOL,
} from "@kingsleyweb/bun-jobs";
import { JOB_STATES as PKG_SCHEMA_JOB_STATES } from "@kingsleyweb/bun-jobs/lib/api/schemas/common.ts";
import { describe, expect, it } from "bun:test";
import {
  JOB_STATES,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_PROTOCOL_VERSION,
  JOBS_API_WS_SUBPROTOCOL,
} from "../../../app/api/contract";

/**
 * The app duplicates these constants so the browser bundle never imports a
 * value from the package (which would pull its drivers and `node:*` in).
 * The tests run in Bun, where importing the real values is fine: any drift
 * fails here.
 */
describe("contract constants match @kingsleyweb/bun-jobs", () => {
  it("JOB_STATES, in lifecycle order", () => {
    expect([...JOB_STATES]).toEqual([...PKG_SCHEMA_JOB_STATES]);
    expect([...JOB_STATES]).toEqual([...PKG_API_JOB_STATES]);
  });

  it("JOBS_API_ACTIONS, in order", () => {
    expect([...JOBS_API_ACTIONS]).toEqual([...PKG_JOBS_API_ACTIONS]);
  });

  it("JOBS_API_MUTATIONS", () => {
    expect([...JOBS_API_MUTATIONS].sort()).toEqual(
      [...PKG_JOBS_API_MUTATIONS].sort(),
    );
  });

  it("JOBS_API_PROTOCOL_VERSION", () => {
    expect(JOBS_API_PROTOCOL_VERSION).toBe(PKG_JOBS_API_PROTOCOL_VERSION);
  });

  it("JOBS_API_WS_SUBPROTOCOL", () => {
    expect(JOBS_API_WS_SUBPROTOCOL).toBe(PKG_JOBS_API_WS_SUBPROTOCOL);
  });
});
