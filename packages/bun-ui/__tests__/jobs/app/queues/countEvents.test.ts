import { QUEUE_EVENT_TYPES } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import { COUNT_EVENTS } from "../../../app/screens/queues/live";

/**
 * Which queue events make the queue screens re-read their counts, pages and
 * lists (`COUNT_EVENTS`). An event that moves no job must not be among them:
 * each one would be a re-read of every count on screen for nothing, and a
 * summon controller emits one per attempt.
 */
describe("the events that change a queue's counts", () => {
  it("leaves out the events that move no job, a summon attempt among them", () => {
    for (const quiet of [
      "progress",
      "duplicate",
      "throttled",
      "debounced",
      "summon",
    ] as const) {
      expect(COUNT_EVENTS).not.toContain(quiet);
    }
  });

  it("keeps every other event the contract lists", () => {
    const quiet = new Set([
      "progress",
      "duplicate",
      "throttled",
      "debounced",
      "summon",
    ]);
    expect([...COUNT_EVENTS]).toEqual(
      QUEUE_EVENT_TYPES.filter((type) => !quiet.has(type)),
    );
    // The events that do move jobs are there.
    for (const moving of ["added", "completed", "failed", "active"] as const) {
      expect(COUNT_EVENTS).toContain(moving);
    }
  });
});
