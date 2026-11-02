/**
 * Server-sent events, declared through the core (plan §4.1.1, §4.7): an
 * outbound side keyed by the event's name, with the parts `data` and `id`.
 * `sse()` builds its events' contract on it, so `describeContract` lists an
 * SSE body's events as the same rows an SSE writer's contract will (plan
 * §4.12 M4).
 */
import { defineTransport } from "./transport";

/**
 * The SSE transport. Its exported name is not approved (internal); an SSE
 * body's events are reached through `describeContract`'s `nested` rows.
 *
 * @internal
 */
export const sseTransport = defineTransport({
  name: "sse",
  wire: "json",
  outbound: { key: "event", parts: ["data", "id"] },
});
