/**
 * Checking a `summon` event's `eventId`.
 *
 * Every `summon` event a controller emits carries `eventId`: a UUIDv7 of its
 * own, given once before it is emitted, so the copy heard in the process and
 * every copy published (a shared unit's goes out once on each of its queues)
 * carry the same one. It is new on every event, so a check that compares a
 * whole payload cannot write it out. {@link markEventId} puts
 * {@link A_UUID_V7} in place of one that is a UUIDv7, and leaves anything
 * else — a missing one, a malformed one — as it is, so a check expecting
 * `eventId: A_UUID_V7` fails on either, and still compares every other field
 * exactly.
 *
 * ```ts
 * checkEqual("one event", events.map(markEventId), [
 *   { id: "", outcome: "budget-exhausted", kind: "k", eventId: A_UUID_V7 },
 * ]);
 * ```
 */

/** A UUIDv7, lower-case, as `Bun.randomUUIDv7()` writes it. */
export const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** What {@link markEventId} puts in place of an `eventId` that is a UUIDv7. */
export const A_UUID_V7 = "(a UUIDv7)";

/** `event` with an `eventId` that is a UUIDv7 replaced by {@link A_UUID_V7}; anything else kept as it is. */
export function markEventId<T>(event: T): T {
  const eventId: unknown = (event as { eventId?: unknown }).eventId;
  return typeof eventId === "string" && UUID_V7.test(eventId)
    ? { ...event, eventId: A_UUID_V7 }
    : event;
}
