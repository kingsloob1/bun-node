/**
 * Transports declared through the contract core: each is a few lines of part
 * and key names. Runtime adapters live elsewhere (udp.ts, broker.ts); here the
 * point is that the typing and the docs metadata follow from the declaration.
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
} from "./core";
import { defineTransport, recordOf } from "./core";

// --- HTTP: one request shape; responses keyed by status, each {headers, body}, the body by media type.
export const http = defineTransport({
  name: "http",
  inbound: {
    parts: ["params", "query", "headers", "cookies", "body"],
    media: ["body"],
  },
  outbound: { key: "status", parts: ["headers", "body"], media: ["body"] },
});

/** A handler's typed reply: `reply(201, { headers: { location }, body })`; an undeclared status is a type error. */
export type HttpReply<C> = <S extends KeysOf<C, "outbound">>(
  status: S,
  parts: PartsOf<C, "outbound", S, "send">,
) => void;

/** A route handler typed by its contract: request parts parsed, reply held to the input rule. */
export type HttpHandler<C> = (
  req: Received<C, "inbound">,
  reply: HttpReply<C>,
) => MaybePromise<void>;

/** What a typed client gets back: a union discriminated by `status`. */
export type HttpResult<C> = Received<C, "outbound">;

// --- WebSocket: both directions keyed by `type`, one `data` part.
export const ws = defineTransport({
  name: "websocket",
  inbound: { key: "type", parts: ["data"] },
  outbound: { key: "type", parts: ["data"] },
});

/** A socket's typed `send`. */
export type WsSend<C> = (frame: Sent<C, "outbound">) => void;

// --- SSE: outbound only, keyed by `event`.
export const sse = defineTransport({
  name: "sse",
  outbound: { key: "event", parts: ["data", "id"] },
});

/** A stream's typed `emit`. */
export type SseEmit<C> = (event: Sent<C, "outbound">) => void;

// --- Jobs: {data} in, {result} out; a flow parent also receives its children's results.
export const jobs = defineTransport({
  name: "jobs",
  inbound: { parts: ["data", "children"] },
  outbound: { parts: ["result"] },
});

/** A job's contract, as far as a flow parent needs it: a result schema. */
export type JobContract = Contract<
  typeof jobs.spec,
  { readonly outbound: { readonly result: Schema } }
>;

type ResultSchemas<K extends Readonly<Record<string, JobContract>>> = {
  readonly [N in keyof K]: K[N]["def"]["outbound"]["result"];
};

/**
 * A flow parent's contract: its own data and result, plus a `children` part
 * composed from each child's result schema, so the parent's view of
 * `children.<name>` is that child's output, and is checked at runtime.
 */
export function flow<
  const D extends Schema,
  const R extends Schema,
  const K extends Readonly<Record<string, JobContract>>,
>(def: { data: D; result: R; children: K }, meta?: ContractMeta) {
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

/** A job handler typed by its contract. */
export type JobHandler<C> = (
  job: Received<C, "inbound">,
) => MaybePromise<Sent<C, "outbound">["result" & keyof Sent<C, "outbound">]>;

/** A flow child's result type, read from the child's contract. */
export type ChildResult<C extends JobContract> = ReceiveOf<
  C["def"]["outbound"]["result"]
>;

// --- Kafka: records keyed by topic, {payload, key, headers}; one topic map serves both roles.
export const kafka = defineTransport({
  name: "kafka",
  inbound: { key: "topic", parts: ["payload", "key", "headers"] },
  outbound: { key: "topic", parts: ["payload", "key", "headers"] },
});

/** A producer's typed `send`: a record held to the input rule. */
export type KafkaProduce<C> = (record: Sent<C, "outbound">) => Promise<void>;

/** A consumer's typed handler: each part's output. */
export type KafkaConsume<C> = (
  record: Received<C, "inbound">,
) => MaybePromise<void>;

// --- gRPC: keyed by method; request/response plus metadata.
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
