/**
 * Type assertions for the contract core, with negative controls. Checked by a
 * bare `bun --check` in this folder; never run. Every `@ts-expect-error` must
 * fire: README.md records the error count with all of them removed.
 *
 * `declare const` values stand in for what an adapter would hand a handler;
 * nothing here executes.
 *
 * Prettier is off for this file: `@ts-expect-error` covers only the next
 * line, and check-types.sh matches each control to the line after it, so a
 * statement reflowed over several lines would move the error off its control.
 */
/* eslint-disable prettier/prettier */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { Carries, ContractError, Received, Sent } from "./core";
import type { ChildResult, GrpcUnary, HttpReply, HttpResult, KafkaConsume, KafkaProduce, SseEmit, WsSend } from "./transports";
import { z } from "zod";
import { createReceiver, createSender, getContract } from "./core";
import { flow, grpc, http, jobs, kafka, sse, ws } from "./transports";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function expectType<T extends true>(): T | void {}

/** The plan's `toStandardSchema<T>`: a hand-rolled schema whose input is `unknown`. */
function toStandardSchema<T>(validate: (v: unknown) => StandardSchemaV1.Result<T>): StandardSchemaV1<unknown, T> {
  return { "~standard": { version: 1, vendor: "custom", validate } };
}

const User = z.object({ id: z.string(), born: z.date() });
const Problem = z.object({ title: z.string() });
const Page = z.object({ page: z.coerce.number(), len: z.string().transform(s => s.length) });
const Wrapped = toStandardSchema<{ total: number }>(v => ({ value: v as { total: number } }));

// ---------------------------------------------------------------- HTTP
const getUser = http.contract({
  inbound: { params: z.object({ id: z.string() }), query: Page },
  outbound: {
    200: { body: { "application/json": User, "text/plain": z.string() }, headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }) },
    201: { headers: z.object({ location: z.string(), "set-cookie": z.array(z.string()).optional() }), body: { "application/json": User } },
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
// @ts-expect-error control: the receiver gets the output (number), not the input (string)
const lenAsInput: string = req.query.len;

declare const reply: HttpReply<GetUser>;
reply(201, { headers: { location: "/users/1" }, body: { mediaType: "application/json", value: { id: "1", born: new Date() } } });
reply(200, { headers: { "x-rate-limit-remaining": 9 }, body: { mediaType: "text/plain", value: "user 1" } });
reply(204, {});
// @ts-expect-error control: 418 is not a declared status
reply(418, {});
// @ts-expect-error control: 201 must carry a Location header
reply(201, { headers: {}, body: { mediaType: "application/json", value: { id: "1", born: new Date() } } });
// @ts-expect-error control: a 204 has no body
reply(204, { body: { mediaType: "application/json", value: {} } });
// @ts-expect-error control: text/plain is declared on 200, not on 404
reply(404, { body: { mediaType: "text/plain", value: "gone" } });
// @ts-expect-error control: the text/plain variant takes a string
reply(200, { headers: { "x-rate-limit-remaining": 1 }, body: { mediaType: "text/plain", value: 42 } });
// @ts-expect-error control: zod's input binds the sender: born must be a Date (input is not unknown)
reply(201, { headers: { location: "/u" }, body: { mediaType: "application/json", value: { id: "1", born: "2026-01-01" } } });
// A wrapped schema has input `unknown`, so the sender falls back to its output.
reply(207, { body: { mediaType: "application/json", value: { total: 1 } } });
// @ts-expect-error control: the fallback is the output, not `unknown`: total must be a number
reply(207, { body: { mediaType: "application/json", value: { total: "1" } } });

// A typed client narrows the response union on status.
declare const res: HttpResult<GetUser>;
if (res.status === 201)
  expectType<Equal<typeof res.headers.location, string>>();
if (res.status === 200 && res.body.mediaType === "text/plain")
  expectType<Equal<typeof res.body.value, string>>();
if (res.status === 200)
  expectType<Equal<typeof res.headers["x-rate-limit-remaining"], number>>();
// @ts-expect-error control: a 404 has no headers part declared
const noHeaders = res.status === 404 && res.headers;

// @ts-expect-error control: "bdy" is not an HTTP part
http.contract({ inbound: { bdy: User } });
// @ts-expect-error control: the request side is not keyed, and "200" is not a part
http.contract({ inbound: { 200: { body: User } } });
// @ts-expect-error control: query is not media-typed, so a MediaMap is refused
http.contract({ inbound: { query: { "application/json": User } } });

// ---------------------------------------------------------------- WebSocket
const chat = ws.contract({
  inbound: { "chat.post": { data: z.object({ text: z.string().max(500) }) }, "ping": {} },
  outbound: { "chat.message": { data: z.object({ from: z.string(), text: z.string() }) }, "pong": {} },
});
declare const wsSend: WsSend<typeof chat>;
wsSend({ type: "chat.message", data: { from: "a", text: "hi" } });
wsSend({ type: "pong" });
// @ts-expect-error control: "chat.post" is an inbound type, not one the server sends
wsSend({ type: "chat.post", data: { text: "x" } });
declare const frame: Received<typeof chat, "inbound">;
if (frame.type === "chat.post")
  expectType<Equal<typeof frame.data.text, string>>();

// ---------------------------------------------------------------- SSE
const progress = sse.contract({ outbound: { tick: { data: z.object({ pct: z.number() }), id: z.string() } } });
declare const emit: SseEmit<typeof progress>;
emit({ event: "tick", data: { pct: 1 }, id: "1" });
// @ts-expect-error control: pct is a number
emit({ event: "tick", data: { pct: "1" }, id: "1" });
// @ts-expect-error control: SSE has no inbound side
sse.contract({ inbound: {} });

// ---------------------------------------------------------------- Jobs and a flow
const ocr = jobs.contract({ inbound: { data: z.object({ url: z.string() }) }, outbound: { result: z.object({ text: z.string(), confidence: z.number() }) } });
const resize = jobs.contract({ inbound: { data: z.object({ url: z.string() }) }, outbound: { result: z.object({ width: z.number() }) } });
const publish = flow({ data: z.object({ docId: z.string() }), result: z.object({ ok: z.boolean() }), children: { ocr, resize } });
declare const parent: Received<typeof publish, "inbound">;
expectType<Equal<typeof parent.children.ocr.text, string>>();
expectType<Equal<typeof parent.children.resize.width, number>>();
expectType<Equal<ChildResult<typeof ocr>, { text: string; confidence: number }>>();
// @ts-expect-error control: the child's text is a string, from the child's contract
const textAsNumber: number = parent.children.ocr.text;
// @ts-expect-error control: no child named "thumb"
const noThumb = parent.children.thumb;

// ---------------------------------------------------------------- Kafka
const orders = { orders: { payload: z.object({ id: z.string(), total: z.number() }), key: z.string(), headers: z.object({ "trace-id": z.string() }) } } as const;
const orderTopics = kafka.contract({ inbound: orders, outbound: orders });
declare const produce: KafkaProduce<typeof orderTopics>;
void produce({ topic: "orders", payload: { id: "o1", total: 3 }, key: "o1", headers: { "trace-id": "t" } });
// @ts-expect-error control: wrong payload type to a sender
void produce({ topic: "orders", payload: { id: "o1", total: "3" }, key: "o1", headers: { "trace-id": "t" } });
// @ts-expect-error control: the record key is a string
void produce({ topic: "orders", payload: { id: "o1", total: 3 }, key: 1, headers: { "trace-id": "t" } });
// @ts-expect-error control: undeclared topic
void produce({ topic: "refunds", payload: { id: "o1", total: 3 }, key: "o1", headers: { "trace-id": "t" } });
// eslint-disable-next-line unused-imports/no-unused-vars -- `r` is read in a type position only
const consume: KafkaConsume<typeof orderTopics> = (r) => {
  expectType<Equal<typeof r.payload.total, number>>();
};

// ---------------------------------------------------------------- gRPC
const users = grpc.contract({
  inbound: { GetUser: { request: z.object({ id: z.string() }) } },
  outbound: { GetUser: { response: z.object({ name: z.string() }) } },
});
const getUserRpc: GrpcUnary<typeof users, "GetUser"> = call => ({ response: { name: call.request.id } });
// @ts-expect-error control: the response's name is a string
const badRpc: GrpcUnary<typeof users, "GetUser"> = () => ({ response: { name: 1 } });

// ---------------------------------------------------------------- Guards and getContract
const receive = createReceiver(chat, "inbound");
const r = receive({});
if (!(r instanceof Promise) && !(r instanceof Error))
  expectType<Equal<typeof r, Received<typeof chat, "inbound">>>();
const sendOrder = createSender(orderTopics, "outbound");
sendOrder({ topic: "orders", payload: { id: "o1", total: 3 }, key: "o1", headers: { "trace-id": "t" } });
// @ts-expect-error control: a sender guard is held to the input rule too
sendOrder({ topic: "orders", payload: { id: 1, total: 3 }, key: "o1", headers: { "trace-id": "t" } });
expectType<Equal<ReturnType<typeof sendOrder>, Sent<typeof orderTopics, "outbound"> | ContractError | Promise<Sent<typeof orderTopics, "outbound"> | ContractError>>>();

declare const handler: (() => void) & Carries<typeof getUser>;
expectType<Equal<ReturnType<typeof getContract<typeof getUser>>, typeof getUser>>();
const fromHandler = getContract(handler);
expectType<Equal<typeof fromHandler, typeof getUser>>();
// @ts-expect-error control: getContract on a carrier keeps its contract's type: 200 has no "items" part
const noItems = fromHandler.def.outbound[200].items;

// The Equal helper itself must be able to fail.
// @ts-expect-error control: Equal is not vacuous
expectType<Equal<typeof req.query.page, string>>();

export { badRpc, consume, getUser, getUserRpc, lenAsInput, noHeaders, noItems, noThumb, progress, publish, textAsNumber, users };
