/**
 * Compile-time guarantees of the contract core (`lib/contract/`), with
 * negative controls: the spike's 24 (`docs/plans/bun-validate/evidence/
 * contract-core/types.probe.ts`), the per-field `WireInput` rule (plan §4.12
 * M1), the receiver policy rule (Q-C1), and the helpers' types.
 *
 * Checked by `bun run check`; never run. Every `@ts-expect-error` must fire:
 * an unused one is itself an error (TS2578).
 *
 * Prettier is off for this file: `@ts-expect-error` covers only the next
 * line, so a statement reflowed over several lines would move the error off
 * its control.
 */
/* eslint-disable prettier/prettier */
import type { Carries, Received, Sent, WireInput } from "../lib/contract/model";
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import type {
  ChildResult,
  GrpcUnary,
  HttpReply,
  HttpResult,
  KafkaConsume,
  KafkaProduce,
  SseEmit,
  WsSend,
} from "./contract/fixtures";
import { z } from "zod";
import {
  ContractError,
  createReceiver,
  createSender,
} from "../lib/contract/guard";
import { documented, recordOf } from "../lib/contract/schemas";
import { getContract } from "../lib/contract/transport";
import { flow, grpc, http, jobs, kafka, sse, ws } from "./contract/fixtures";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expectType<T extends true>(): T | void {}

/** A hand-rolled schema whose input is `unknown`, as `toStandardSchema<T>` makes. */
function wrapped<T>(
  validate: (v: unknown) => StandardSchemaV1.Result<T>,
): StandardSchemaV1<unknown, T> {
  return { "~standard": { version: 1, vendor: "custom", validate } };
}

const User = z.object({ id: z.string(), born: z.date() });
const Problem = z.object({ title: z.string() });
const Page = z.object({
  page: z.coerce.number(),
  len: z.string().transform((s) => s.length),
});
const Wrapped = wrapped<{ total: number }>((v) => ({
  value: v as { total: number },
}));

// ---------------------------------------------------------------- HTTP
const getUser = http.contract({
  inbound: { params: z.object({ id: z.string() }), query: Page },
  outbound: {
    200: {
      body: { "application/json": User, "text/plain": z.string() },
      headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }),
    },
    201: {
      headers: z.object({
        location: z.string(),
        "set-cookie": z.array(z.string()).optional(),
      }),
      body: { "application/json": User },
    },
    204: { body: null },
    404: { body: { "application/json": Problem } },
    207: { body: { "application/json": Wrapped } },
  },
});
type GetUser = typeof getUser;

declare const req: Received<GetUser, "inbound">;
// A z.coerce.number() part reaches the receiver as number; a transform as its output.
expectType<Equal<typeof req.query.page, number>>();
expectType<Equal<typeof req.query.len, number>>();
// @ts-expect-error control 1: the receiver gets the output (number), not the input (string)
const lenAsInput: string = req.query.len;

declare const reply: HttpReply<GetUser>;
reply(201, {
  headers: { location: "/users/1" },
  body: { mediaType: "application/json", value: { id: "1", born: new Date() } },
});
reply(200, {
  headers: { "x-rate-limit-remaining": 9 },
  body: { mediaType: "text/plain", value: "user 1" },
});
reply(204, {});
// @ts-expect-error control 2: 418 is not a declared status
reply(418, {});
reply(201, {
  // @ts-expect-error control 3: 201 must carry a Location header
  headers: {},
  body: { mediaType: "application/json", value: { id: "1", born: new Date() } },
});
// @ts-expect-error control 4: a 204 has no body
reply(204, { body: { mediaType: "application/json", value: {} } });
// @ts-expect-error control 5: text/plain is declared on 200, not on 404
reply(404, { body: { mediaType: "text/plain", value: "gone" } });
reply(200, {
  headers: { "x-rate-limit-remaining": 1 },
  // @ts-expect-error control 6: the text/plain variant takes a string
  body: { mediaType: "text/plain", value: 42 },
});
reply(201, {
  headers: { location: "/u" },
  body: {
    mediaType: "application/json",
    // @ts-expect-error control 7: zod's input binds the sender: born must be a Date (input is not unknown)
    value: { id: "1", born: "2026-01-01" },
  },
});
// A wrapped schema has input `unknown`, so the sender falls back to its output.
reply(207, { body: { mediaType: "application/json", value: { total: 1 } } });
// @ts-expect-error control 8: the fallback is the output, not `unknown`: total must be a number
reply(207, { body: { mediaType: "application/json", value: { total: "1" } } });

// A typed client narrows the response union on status.
declare const res: HttpResult<GetUser>;
if (res.status === 201)
  expectType<Equal<typeof res.headers.location, string>>();
if (res.status === 200 && res.body.mediaType === "text/plain")
  expectType<Equal<typeof res.body.value, string>>();
if (res.status === 200)
  expectType<Equal<(typeof res.headers)["x-rate-limit-remaining"], number>>();
// @ts-expect-error control 9: a 404 has no headers part declared
const noHeaders = res.status === 404 && res.headers;

// @ts-expect-error control 10: "bdy" is not an HTTP part
http.contract({ inbound: { bdy: User } });
// @ts-expect-error control 11: the request side is not keyed, and "200" is not a part
http.contract({ inbound: { 200: { body: User } } });
// @ts-expect-error control 12: query is not media-typed, so a MediaMap is refused
http.contract({ inbound: { query: { "application/json": User } } });

// ---------------------------------------------------------------- WebSocket
const chat = ws.contract({
  inbound: {
    "chat.post": { data: z.object({ text: z.string().max(500) }) },
    ping: {},
  },
  outbound: {
    "chat.message": { data: z.object({ from: z.string(), text: z.string() }) },
    pong: {},
  },
});
declare const wsSend: WsSend<typeof chat>;
wsSend({ type: "chat.message", data: { from: "a", text: "hi" } });
wsSend({ type: "pong" });
// @ts-expect-error control 13: "chat.post" is an inbound type, not one the server sends
wsSend({ type: "chat.post", data: { text: "x" } });
declare const frame: Received<typeof chat, "inbound">;
if (frame.type === "chat.post")
  expectType<Equal<typeof frame.data.text, string>>();

// ---------------------------------------------------------------- SSE
const progress = sse.contract({
  outbound: { tick: { data: z.object({ pct: z.number() }), id: z.string() } },
});
declare const emit: SseEmit<typeof progress>;
emit({ event: "tick", data: { pct: 1 }, id: "1" });
// @ts-expect-error control 14: pct is a number
emit({ event: "tick", data: { pct: "1" }, id: "1" });
// @ts-expect-error control 15: SSE has no inbound side
sse.contract({ inbound: {} });

// ---------------------------------------------------------------- Jobs and a flow
const ocr = jobs.contract({
  inbound: { data: z.object({ url: z.string() }) },
  outbound: { result: z.object({ text: z.string(), confidence: z.number() }) },
});
const resize = jobs.contract({
  inbound: { data: z.object({ url: z.string() }) },
  outbound: { result: z.object({ width: z.number() }) },
});
const publish = flow({
  data: z.object({ docId: z.string() }),
  result: z.object({ ok: z.boolean() }),
  children: { ocr, resize },
});
declare const parent: Received<typeof publish, "inbound">;
expectType<Equal<typeof parent.children.ocr.text, string>>();
expectType<Equal<typeof parent.children.resize.width, number>>();
expectType<
  Equal<ChildResult<typeof ocr>, { text: string; confidence: number }>
>();
// @ts-expect-error control 16: the child's text is a string, from the child's contract
const textAsNumber: number = parent.children.ocr.text;
// @ts-expect-error control 17: no child named "thumb"
const noThumb = parent.children.thumb;

// ---------------------------------------------------------------- Kafka
const orders = {
  orders: {
    payload: z.object({ id: z.string(), total: z.number() }),
    key: z.string(),
    headers: z.object({ "trace-id": z.string() }),
  },
} as const;
const orderTopics = kafka.contract({ inbound: orders, outbound: orders });
declare const produce: KafkaProduce<typeof orderTopics>;
void produce({
  topic: "orders",
  payload: { id: "o1", total: 3 },
  key: "o1",
  headers: { "trace-id": "t" },
});
void produce({
  topic: "orders",
  // @ts-expect-error control 18: wrong payload type to a sender
  payload: { id: "o1", total: "3" },
  key: "o1",
  headers: { "trace-id": "t" },
});
void produce({
  topic: "orders",
  payload: { id: "o1", total: 3 },
  // @ts-expect-error control 19: the record key is a string
  key: 1,
  headers: { "trace-id": "t" },
});
void produce({
  // @ts-expect-error control 20: undeclared topic
  topic: "refunds",
  payload: { id: "o1", total: 3 },
  key: "o1",
  headers: { "trace-id": "t" },
});
// eslint-disable-next-line unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars -- `r` is read in a type position only
const consume: KafkaConsume<typeof orderTopics> = (r) => {
  expectType<Equal<typeof r.payload.total, number>>();
};

// ---------------------------------------------------------------- gRPC
const users = grpc.contract({
  inbound: { GetUser: { request: z.object({ id: z.string() }) } },
  outbound: { GetUser: { response: z.object({ name: z.string() }) } },
});
const getUserRpc: GrpcUnary<typeof users, "GetUser"> = (call) => ({
  response: { name: call.request.id },
});
const badRpc: GrpcUnary<typeof users, "GetUser"> = () => ({
  // @ts-expect-error control 21: the response's name is a string
  response: { name: 1 },
});

// ---------------------------------------------------------------- Guards and getContract
const receive = createReceiver(chat, "inbound");
const received = receive({});
if (!(received instanceof Promise) && !(received instanceof ContractError))
  expectType<Equal<typeof received, Received<typeof chat, "inbound">>>();
const sendOrder = createSender(orderTopics, "outbound");
void sendOrder({
  topic: "orders",
  payload: { id: "o1", total: 3 },
  key: "o1",
  headers: { "trace-id": "t" },
});
void sendOrder({
  topic: "orders",
  // @ts-expect-error control 22: a sender guard is held to the input rule too
  payload: { id: 1, total: 3 },
  key: "o1",
  headers: { "trace-id": "t" },
});
expectType<
  Equal<
    ReturnType<typeof sendOrder>,
    | Sent<typeof orderTopics, "outbound">
    | ContractError
    | Promise<Sent<typeof orderTopics, "outbound"> | ContractError>
  >
>();
expectType<
  Equal<typeof sendOrder.checksKey, (key: string | number) => boolean>
>();

declare const handler: (() => void) & Carries<typeof getUser>;
expectType<
  Equal<ReturnType<typeof getContract<typeof getUser>>, typeof getUser>
>();
const fromHandler = getContract(handler);
expectType<Equal<typeof fromHandler, typeof getUser>>();
// @ts-expect-error control 23: getContract on a carrier keeps its contract's type: 200 has no "items" part
const noItems = fromHandler.def.outbound[200].items;

// The Equal helper itself must be able to fail.
// @ts-expect-error control 24: Equal is not vacuous
expectType<Equal<typeof req.query.page, string>>();

// ---------------------------------------------------------------- WireInput, field by field (§4.12 M1)
const Search = z.object({
  page: z.coerce.number(),
  q: z.string().default(""),
  tags: z.array(z.object({ n: z.coerce.number(), at: z.date() })),
});
expectType<
  Equal<
    WireInput<typeof Search>,
    { page: number; q?: string | undefined; tags: { n: number; at: Date }[] }
  >
>();
const search = http.contract({ inbound: { query: Search } });
declare const sendSearch: (m: Sent<typeof search, "inbound">) => void;
sendSearch({ query: { page: 2, tags: [] } });
// @ts-expect-error control 25 (M1): page's input is unknown (a coercion), so the sender is held to its output, number; the spike's per-part rule let "x" compile
sendSearch({ query: { page: "x", tags: [] } });
// @ts-expect-error control 26 (M1, deep): the coercion rule reaches into arrays of objects
sendSearch({ query: { page: 1, tags: [{ n: "1", at: new Date() }] } });
// A receiver still gets the output: q is defaulted, so required.
declare const searched: Received<typeof search, "inbound">;
expectType<
  Equal<
    typeof searched.query,
    { page: number; q: string; tags: { n: number; at: Date }[] }
  >
>();

// ---------------------------------------------------------------- Receivers and policies (Q-C1)
const strict = createReceiver(chat, "inbound", { policy: "error" });
const strictOut = strict({});
if (!(strictOut instanceof Promise) && !(strictOut instanceof ContractError))
  expectType<Equal<typeof strictOut, Received<typeof chat, "inbound">>>();
const lenient = createReceiver(chat, "inbound", { policy: "warn" });
const lenientOut = lenient({});
if (!(lenientOut instanceof Promise) && !(lenientOut instanceof ContractError))
  expectType<Equal<typeof lenientOut, unknown>>();
declare const somePolicy: "off" | "warn" | "error";
const unsure = createReceiver(chat, "inbound", { policy: somePolicy });
const unsureOut = unsure({});
// @ts-expect-error control 27 (Q-C1): a receiver that may run under "warn"/"off" hands on unknown, not the parsed type
const unsureTyped:
  Received<typeof chat, "inbound"> | Promise<unknown> | ContractError =
  unsureOut;
const offSender = createSender(orderTopics, "outbound", { policy: "off" });
// Senders take every policy and keep their type.
void offSender({
  topic: "orders",
  payload: { id: "o1", total: 3 },
  key: "o1",
  headers: { "trace-id": "t" },
});

// ---------------------------------------------------------------- recordOf and documented
const pair = recordOf({ a: z.coerce.number(), b: z.string() });
expectType<
  Equal<StandardSchemaV1.InferOutput<typeof pair>, { a: number; b: string }>
>();
expectType<Equal<WireInput<typeof pair>, { a: number; b: string }>>();
const legacy = documented<{ id: string }>({ type: "object" });
expectType<
  Equal<StandardSchemaV1.InferOutput<typeof legacy>, { id: string }>
>();
// @ts-expect-error control 28: documented() needs a JSON Schema object, not a string
documented("object");

export {
  badRpc,
  consume,
  getUser,
  getUserRpc,
  legacy,
  lenAsInput,
  noHeaders,
  noItems,
  noThumb,
  pair,
  progress,
  publish,
  searched,
  textAsNumber,
  unsureTyped,
  users,
};
