/**
 * Transports declared through the contract core for the tests, as the plan's
 * §4.1.1 table declares them, with the typed handler and sender types an
 * adapter would expose. Types plus declarations only; the UDP adapter lives
 * in `udp.ts`.
 */
import type {
  Contract,
  ContractMeta,
  KeysOf,
  MaybePromise,
  PartsOf,
  Received,
  ReceiveOf,
  Schema,
  Sent,
} from "../../lib/contract/model";
import { recordOf } from "../../lib/contract/schemas";
import { defineTransport } from "../../lib/contract/transport";

export { httpTransport as http } from "../../lib/contract/http";

/** A handler's typed reply: `reply(201, { headers: { location }, body })`; an undeclared status is a type error. */
export type HttpReply<C> = <S extends KeysOf<C, "outbound">>(
  status: S,
  parts: PartsOf<C, "outbound", S, "send">,
) => void;

/** What a typed client gets back: a union discriminated by `status` (in-process view). */
export type HttpResult<C> = Received<C, "outbound">;

/** WebSocket: both directions keyed by `type`, one `data` part. */
export const ws = defineTransport({
  name: "websocket",
  inbound: { key: "type", parts: ["data"] },
  outbound: { key: "type", parts: ["data"] },
});

/** A socket's typed `send`. */
export type WsSend<C> = (frame: Sent<C, "outbound">) => void;

/** SSE: outbound only, keyed by `event`. */
export const sse = defineTransport({
  name: "sse",
  outbound: { key: "event", parts: ["data", "id"] },
});

/** A stream's typed `emit`. */
export type SseEmit<C> = (event: Sent<C, "outbound">) => void;

/** Jobs: `{ data }` in, `{ result }` out; a flow parent also receives its children's results. */
export const jobs = defineTransport({
  name: "jobs",
  wire: "identity",
  inbound: { parts: ["data", "children"] },
  outbound: { parts: ["result"] },
});

/** A job's contract, as far as a flow parent needs it: a result schema. */
export type JobContract = Contract<
  typeof jobs.spec,
  {
    /** The result side. */
    readonly outbound: {
      /** The result schema. */
      readonly result: Schema;
    };
  }
>;

/** Each child's result schema, by child name. */
type ResultSchemas<K extends Readonly<Record<string, JobContract>>> = {
  readonly [N in keyof K]: K[N]["def"]["outbound"]["result"];
};

/**
 * A flow parent's contract: its own data and result, plus a `children` part
 * composed from each child's result schema with `recordOf`.
 */
export function flow<
  const D extends Schema,
  const R extends Schema,
  const K extends Readonly<Record<string, JobContract>>,
>(
  def: {
    /** The parent's data schema. */
    data: D;
    /** The parent's result schema. */
    result: R;
    /** The children's contracts, by name. */
    children: K;
  },
  meta?: ContractMeta,
) {
  const results = Object.fromEntries(
    Object.entries(def.children).map(([n, c]) => [n, c.def.outbound.result]),
  ) as ResultSchemas<K>;
  return jobs.contract(
    {
      inbound: { data: def.data, children: recordOf(results) },
      outbound: { result: def.result },
    },
    meta,
  );
}

/** A flow child's result type, read from the child's contract. */
export type ChildResult<C extends JobContract> = ReceiveOf<
  C["def"]["outbound"]["result"]
>;

/** Kafka: records keyed by topic, `{ payload, key, headers }`. */
export const kafka = defineTransport({
  name: "kafka",
  inbound: { key: "topic", parts: ["payload", "key", "headers"] },
  outbound: { key: "topic", parts: ["payload", "key", "headers"] },
});

/** A producer's typed `send`. */
export type KafkaProduce<C> = (record: Sent<C, "outbound">) => Promise<void>;

/** A consumer's typed handler. */
export type KafkaConsume<C> = (
  record: Received<C, "inbound">,
) => MaybePromise<void>;

/** gRPC: keyed by method; request/response plus metadata. */
export const grpc = defineTransport({
  name: "grpc",
  inbound: { key: "method", parts: ["request", "metadata"] },
  outbound: { key: "method", parts: ["response", "metadata", "trailers"] },
});

/** A unary call's typed implementation for method `M`. */
export type GrpcUnary<
  C,
  M extends KeysOf<C, "inbound"> & KeysOf<C, "outbound">,
> = (
  call: PartsOf<C, "inbound", M, "receive">,
) => MaybePromise<PartsOf<C, "outbound", M, "send">>;

/** An in-process broker: topic-keyed records, values arrive as sent. */
export const broker = defineTransport({
  name: "broker",
  wire: "identity",
  inbound: { key: "topic", parts: ["payload", "key", "headers"] },
  outbound: { key: "topic", parts: ["payload", "key", "headers"] },
});
