/**
 * A recording logger for the package's own tests: the core's `logger` option
 * takes a sink, and this one keeps every record it is handed. (bun-common's
 * suite uses its own `createTestLogger`, which is a full `Logger`.)
 */
import type { ContractLogEvent, ContractLogSink } from "../lib/logger";

/** A sink to pass as a `logger` option, and the records it has received, in order. */
export function createTestLogger(): {
  /** The sink: pass it as `logger`. */
  logger: ContractLogSink;
  /** Every record the sink received. */
  events: ContractLogEvent[];
} {
  const events: ContractLogEvent[] = [];
  return {
    logger: (event) => {
      events.push(event);
    },
    events,
  };
}
