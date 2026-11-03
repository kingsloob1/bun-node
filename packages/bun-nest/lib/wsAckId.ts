/**
 * The ack id of the event a gateway exception answers, so the `exception`
 * frame can carry it as `ackId` and a client waiting on that id (bun-client's
 * `request()`) fails at once instead of timing out.
 *
 * The adapter marks the ack callback it hands a handler (the packet's `id`)
 * and Nest passes it on in the exception host's arguments (`[client, data,
 * ack?, pattern]`). Exception filters reach the client through `emit`, which
 * has no host, so the id travels as an ambient value for the synchronous span
 * of the filter's `catch` ({@link withAckIdOf}), read by the adapter's `emit`.
 */

/** Marks an ack callback with its packet's id. Registered, so two copies of this package agree. */
export const ACK_ID = Symbol.for("@kingsleyweb/bun-nest/ws-ack-id");

/** The ack id in force while an exception filter runs, if the event had one. */
let ambient: string | number | undefined;

/** The ack id an exception host's arguments carry (the marked callback), if any. */
export function ackIdOf(args: readonly unknown[]): string | number | undefined {
  for (const arg of args) {
    if (typeof arg !== "function") continue;
    const id = (arg as { [ACK_ID]?: unknown })[ACK_ID];
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return undefined;
}

/** Runs `run` with the ack id of `args` in force, restoring the previous one after. */
export function withAckIdOf<T>(args: readonly unknown[], run: () => T): T {
  const previous = ambient;
  ambient = ackIdOf(args);
  try {
    return run();
  } finally {
    ambient = previous;
  }
}

/**
 * `payload` with the ambient ack id as `ackId`, when the event is
 * `exception`, an id is in force and the payload is a plain object that does
 * not carry an `ackId` of its own; otherwise `payload` itself.
 */
export function withAckId(event: string, payload: unknown): unknown {
  if (
    event !== "exception" ||
    ambient === undefined ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    "ackId" in payload
  ) {
    return payload;
  }
  return { ...payload, ackId: ambient };
}
