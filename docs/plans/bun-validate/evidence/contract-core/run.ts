/**
 * Runtime cases for the contract core. Run from this folder:
 *
 *   bun run.ts
 *
 * Prints labelled lines C1… with what was measured; README.md says what each
 * must show. Light work: a few UDP datagrams on loopback and short timing loops.
 *
 * A CLI entry point whose output is its product, so the two rules the repo's
 * `scripts/` lint config turns off are off here too.
 */
/* eslint-disable no-console, antfu/no-top-level-await */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { ContractIssue, GuardOptions, IssueContext, Schema } from "./core";
import process from "node:process";
import { type } from "arktype";
import { fullGC, heapStats } from "bun:jsc";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";
import { broker, createBroker } from "./broker";
import {
  attachContract,
  ContractError,
  createReceiver,
  createSender,
  defineTransport,
  describeContract,
  getContract,
  validateStandard,
} from "./core";
import { flow, http, jobs } from "./transports";
import { serveUdp, udp, udpClient } from "./udp";

const line = (label: string, text: string): void =>
  console.log(`${label.padEnd(4)} ${text}`);
const kind = (x: unknown): string =>
  x instanceof Promise ? "Promise" : "sync";

/** A hand-rolled sync Standard Schema, and an async one (both input `unknown`). */
function custom<T>(
  check: (v: unknown) => v is T,
  async = false,
): StandardSchemaV1<unknown, T> {
  const run = (value: unknown): StandardSchemaV1.Result<T> =>
    check(value)
      ? { value }
      : { issues: [{ message: "Rejected by custom check", path: [] }] };
  return {
    "~standard": {
      version: 1,
      vendor: async ? "custom-async" : "custom",
      validate: async ? async (x: unknown) => run(x) : run,
    },
  };
}
const isPoint = (x: unknown): x is { x: number } =>
  typeof (x as { x?: unknown } | null)?.x === "number";

/** A logger that records what `"warn"` emits. */
function capture() {
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  return {
    lines,
    logger: {
      warn: (message: string, fields: Record<string, unknown>) =>
        void lines.push({ message, fields }),
    },
  };
}

/**
 * Minimum ns/op over `rounds` rounds of `n` calls, after a warm-up. Each call
 * compiles its own loop (`new Function`), so the `fn()` call site is
 * monomorphic for every case; a shared loop made the first case measured
 * look 10x cheaper than the rest (measured while building this file).
 */
function bench(fn: () => unknown, n = 200_000, rounds = 7): number {
  // eslint-disable-next-line no-new-func
  const loop = new Function(
    "fn",
    "n",
    "now",
    "let s; const t0 = now(); for (let i = 0; i < n; i++) s = fn(); const t = now() - t0; globalThis.__sink = s; return t;",
  ) as (f: () => unknown, n: number, now: () => number) => number;
  loop(fn, n, Bun.nanoseconds);
  let best = Infinity;
  for (let r = 0; r < rounds; r++)
    best = Math.min(best, loop(fn, n, Bun.nanoseconds) / n);
  return best;
}

console.log(
  `# bun ${Bun.version} (${Bun.revision.slice(0, 9)}) ${process.platform}/${process.arch}`,
);

// ---------------------------------------------------------------- UDP
const chat = udp.contract({
  inbound: {
    "chat.post": {
      payload: z.object({
        room: z.string(),
        text: z.string().max(20),
        at: z.coerce.date(),
      }),
    },
  },
  outbound: { "chat.ack": { payload: z.object({ seq: z.number().int() }) } },
});
const seen: unknown[] = [];
let seq = 0;
async function udpRound(
  label: string,
  options: GuardOptions,
  message: unknown,
) {
  seen.length = 0;
  const server = await serveUdp(
    chat,
    (m) => {
      seen.push(m);
      return { type: "chat.ack", payload: { seq: ++seq } };
    },
    options,
  );
  const client = await udpClient(chat, server.port, { policy: "off" });
  try {
    const reply = await client.raw(message);
    const got = seen[0] as { payload: { at: unknown } } | undefined;
    line(
      label,
      `policy=${options.policy}  reply=${JSON.stringify(reply)}  handler saw ${seen.length}${got ? `, payload.at is ${got.payload.at instanceof Date ? "a Date (parsed)" : typeof got.payload.at} ` : ""}`,
    );
  } finally {
    client.close();
    server.close();
  }
}
const good = {
  type: "chat.post",
  payload: { room: "r1", text: "hi", at: "2026-10-17T00:00:00Z" },
};
const bad = {
  type: "chat.post",
  payload: { room: "r1", text: "x".repeat(30), at: "2026-10-17T00:00:00Z" },
};
await udpRound("C1", { policy: "error" }, good);
await udpRound("C2", { policy: "error" }, bad);
{
  const { lines, logger } = capture();
  await udpRound("C3", { policy: "warn", logger }, bad);
  line(
    "C3",
    `warn logged ${lines.length}: ${lines.map((l) => `${l.message} ${JSON.stringify(l.fields)}`).join(" | ")}`,
  );
}
await udpRound("C4", { policy: "off" }, bad);
{
  // "off" compiles to the identity guard: no schema is ever called.
  let calls = 0;
  const counted = z.object({ text: z.string() });
  const original = counted["~standard"].validate;
  Object.defineProperty(counted["~standard"], "validate", {
    value: (x: unknown) => {
      calls++;
      return original(x);
    },
  });
  const c = udp.contract({ inbound: { m: { payload: counted } } });
  const off = createReceiver(c, "inbound", { policy: "off" });
  const on = createReceiver(c, "inbound", { policy: "error" });
  off({ type: "m", payload: { text: 1 } });
  const offCalls = calls;
  on({ type: "m", payload: { text: 1 } });
  line(
    "C4",
    `"off": guard.checks=${off.checks}, schema calls ${offCalls}; the same contract under "error": schema calls ${calls - offCalls}`,
  );
}
await udpRound("C5", { policy: "error" }, { type: "chat.delete", payload: {} });
{
  // The typed client checks before sending: an invalid request never leaves.
  const server = await serveUdp(chat, () => ({
    type: "chat.ack",
    payload: { seq: 0 },
  }));
  const client = await udpClient(chat, server.port);
  const r = await client.request({
    type: "chat.post",
    payload: { room: "r", text: "y".repeat(30), at: new Date() },
  });
  line(
    "C6",
    `client-side check: ${r instanceof ContractError ? `ContractError before send, ${r.issues.length} issue(s): ${JSON.stringify(r.issues)}` : JSON.stringify(r)}`,
  );
  client.close();
  server.close();
}

// ---------------------------------------------------------------- Broker
const topicDef = {
  orders: {
    payload: z.object({ id: z.string(), total: z.coerce.number() }),
    key: z.string(),
    headers: z.object({ "trace-id": z.string() }),
  },
  audit: {},
  slow: { payload: yup.object({ id: yup.string().required() }) },
} as const;
const topics = broker.contract({ inbound: topicDef, outbound: topicDef });
{
  const bus = createBroker(topics, {
    publish: { policy: "error" },
    deliver: { policy: "error" },
  });
  const got: unknown[] = [];
  bus.subscribe("orders", (r) => got.push(r.payload.total));
  bus.subscribe("audit", (r) => got.push(r.topic));
  bus.subscribe("slow", (r) => got.push(r.payload.id));
  const ok = bus.publish({
    topic: "orders",
    payload: { id: "o1", total: 12 },
    key: "o1",
    headers: { "trace-id": "t1" },
  });
  line(
    "C7",
    `valid publish answers ${kind(ok)}: ${String(ok)} delivery; consumer saw total=${JSON.stringify(got[0])} (${typeof got[0]})`,
  );
  const rejected = bus.publish({
    topic: "orders",
    payload: { id: "o2", total: "abc" as unknown as number },
    key: "o2",
    headers: { "trace-id": "t2" },
  });
  line(
    "C8",
    `invalid publish answers ${kind(rejected)}: ${rejected instanceof ContractError ? `ContractError, issues ${JSON.stringify(rejected.issues)}` : String(rejected)}; deliveries now ${got.length}`,
  );
  const asyncOne = bus.publish({ topic: "slow", payload: { id: "s1" } });
  line(
    "C9",
    `yup topic answers ${kind(asyncOne)}: ${String(await asyncOne)} delivery, consumer saw ${JSON.stringify(got.at(-1))}; a schema-less topic ("audit") answers ${kind(bus.publish({ topic: "audit" }))}, consumer saw ${JSON.stringify(got.at(-1))}`,
  );
}

// ---------------------------------------------------------------- Sync vs Promise, per vendor
{
  const vendors: Record<string, Schema> = {
    "zod 4": z.object({ x: z.number() }),
    "valibot 1": v.object({ x: v.number() }),
    "arktype 2": type({ x: "number" }),
    "yup 1.7": yup.object({ x: yup.number().required() }),
    "custom sync": custom(isPoint),
    "custom async": custom(isPoint, true),
  };
  const msg = { topic: "t", payload: { x: 1 } };
  console.log(
    "C10  vendor        direct ~standard.validate  validateStandard  receiver guard  sender guard",
  );
  for (const [name, s] of Object.entries(vendors)) {
    const c = broker.contract({
      inbound: { t: { payload: s } },
      outbound: { t: { payload: s } },
    });
    const direct = s["~standard"].validate(msg.payload);
    const runner = validateStandard(s, msg.payload, "payload");
    const recv = createReceiver(c, "inbound")(msg);
    const send = createSender(c, "outbound")(msg as never);
    await Promise.all([direct, runner, recv, send]);
    console.log(
      `     ${name.padEnd(13)} ${kind(direct).padEnd(26)} ${kind(runner).padEnd(17)} ${kind(recv).padEnd(15)} ${kind(send)}`,
    );
  }
  const mixed = broker.contract({
    inbound: {
      t: { payload: vendors["zod 4"]!, headers: vendors["yup 1.7"]! },
    },
  });
  const r = createReceiver(
    mixed,
    "inbound",
  )({ topic: "t", payload: { x: 1 }, headers: { x: 2 } });
  line(
    "C10",
    `mixed zod+yup parts on one message: ${kind(r)} (one async part makes the message async)`,
  );
  await r;
}

// ---------------------------------------------------------------- Issues never carry the received value
{
  const S = "SECRET-7731";
  const cases: [string, Schema, unknown][] = [
    ["zod type", z.object({ n: z.number() }), { n: S }],
    ["zod unknown key", z.strictObject({ a: z.string() }), { a: "x", [S]: 1 }],
    ["valibot type", v.object({ n: v.number() }), { n: S }],
    ["valibot email", v.object({ e: v.pipe(v.string(), v.email()) }), { e: S }],
    [
      "valibot unknown key",
      v.strictObject({ a: v.string() }),
      { a: "x", [S]: 1 },
    ],
    ["arktype email", type({ e: "string.email" }), { e: S }],
    ["arktype enum", type({ k: "'a'|'b'" }), { k: S }],
    [
      "arktype unknown key",
      type({ "+": "reject", a: "string" }),
      { a: "x", [S]: 1 },
    ],
    ["yup number", yup.object({ n: yup.number().required() }), { n: S }],
  ];
  console.log(
    "C11  case                 vendor issue leaks?  core issue: message leaks? path leaks?  core message",
  );
  for (const [name, s, value] of cases) {
    const vendorIssues = (await s["~standard"].validate(value)).issues ?? [];
    const vendorLeak = vendorIssues.some((i) => {
      try {
        return JSON.stringify(i).includes(S);
      } catch {
        return true;
      }
    });
    const outcome = await validateStandard(s, value, "payload");
    const issues = outcome.ok ? [] : outcome.issues;
    const msgLeak = issues.some((i) => i.message.includes(S));
    const pathLeak = issues.some((i) => i.path.includes(S));
    console.log(
      `     ${name.padEnd(20)} ${String(vendorLeak).padEnd(20)} ${String(msgLeak).padEnd(24)} ${String(pathLeak).padEnd(12)} ${JSON.stringify(issues[0]?.message)}`,
    );
  }
  const { lines, logger } = capture();
  const c = broker.contract({
    inbound: {
      t: { payload: v.object({ card: v.pipe(v.string(), v.length(16)) }) },
    },
  });
  createReceiver(c, "inbound", { policy: "warn", logger })({
    topic: "t",
    payload: { card: "4111-1111-1111" },
  });
  const logged = JSON.stringify(lines);
  const issueKeys = [
    ...new Set(
      (lines[0]?.fields.issues as Record<string, unknown>[]).flatMap((i) =>
        Object.keys(i),
      ),
    ),
  ];
  line(
    "C12",
    `warn log: ${logged.includes("4111") ? "LEAKS" : "no value"}; fields ${Object.keys(lines[0]!.fields).join(",")}; issue keys ${issueKeys.join(",")}; ${logged}`,
  );
}

// ---------------------------------------------------------------- Zero cost without a schema; onIssues
{
  const c = broker.contract({
    inbound: { bare: {}, typed: { payload: z.object({ n: z.number() }) } },
  });
  const none = jobs.contract({});
  const g = createReceiver(c, "inbound");
  const gNone = createReceiver(none, "inbound");
  const bare = { topic: "bare", payload: { n: 1 } };
  const job = { data: { n: 1 } };
  const typed = { topic: "typed", payload: { n: 1 } };
  const r1 = g(bare);
  const r2 = gNone(job);
  line(
    "C13",
    `no schema for the key: ${kind(r1)}, same object ${r1 === bare}; no side declared: ${kind(r2)}, same object ${r2 === job}, guard.checks=${gNone.checks}; with a schema: same object ${g(typed) === typed} (a parsed copy), guard.checks=${g.checks}`,
  );

  let count = 0;
  const handler = (m: unknown): number => (m === null ? 0 : ++count);
  const tDirect = bench(() => handler(bare), 2_000_000);
  const tBare = bench(() => handler(g(bare)), 2_000_000);
  const tNone = bench(() => handler(gNone(job)), 2_000_000);
  const tSkip = bench(
    () => handler(gNone.checks ? gNone(job) : job),
    2_000_000,
  );
  const tTyped = bench(() => handler(g(typed)), 500_000);
  line(
    "C14",
    `ns/message, min of 7: handler directly ${tDirect.toFixed(2)}; through a guard, no schema for the key ${tBare.toFixed(2)}; no side declared ${tNone.toFixed(2)} (calling the identity guard), ${tSkip.toFixed(2)} (adapter skips on guard.checks); one zod part ${tTyped.toFixed(1)}`,
  );

  // Retained results: a path that returns the input allocates no result object.
  const retained = (fn: () => unknown, n = 100_000): number => {
    const keep: unknown[] = Array.from({ length: n });
    fullGC();
    const before = heapStats().objectTypeCounts.Object ?? 0;
    for (let i = 0; i < n; i++) keep[i] = fn();
    fullGC();
    const delta = (heapStats().objectTypeCounts.Object ?? 0) - before;
    void keep.length;
    return delta;
  };
  line(
    "C15",
    `live Objects added by 100,000 retained results: no schema ${retained(() => g(bare))}; no side ${retained(() => gNone(job))}; one zod part ${retained(() => g(typed))}`,
  );

  const calls: { issues: readonly ContractIssue[]; ctx: IssueContext }[] = [];
  const hooked = createReceiver(c, "inbound", {
    policy: "error",
    onIssues: (issues, ctx) => void calls.push({ issues, ctx }),
  });
  hooked(typed);
  const okCalls = calls.length;
  hooked({ topic: "typed", payload: { n: "x" } });
  hooked({ topic: "nope" });
  line(
    "C16",
    `onIssues: ${okCalls} call(s) on a valid message, then ${calls.length - okCalls} for 2 failing; ${calls.map((c2) => `${JSON.stringify(c2.ctx)} → target=${c2.issues[0]?.target} paths=${JSON.stringify(c2.issues.map((i) => i.path))} count=${c2.issues.length}`).join(" | ")}`,
  );
  let spans = 0;
  const plain = createReceiver(c, "inbound", { policy: "error" });
  const withHook = createReceiver(c, "inbound", {
    policy: "error",
    onIssues: () => void spans++,
  });
  const failing = { topic: "typed", payload: { n: "x" } };
  const valid = { topic: "typed", payload: { n: 1 } };
  line(
    "C17",
    `ns/message, min of 7: valid ${bench(() => plain(valid), 300_000).toFixed(1)} without the hook, ${bench(() => withHook(valid), 300_000).toFixed(1)} with it; failing ${bench(() => plain(failing), 50_000).toFixed(0)} without, ${bench(() => withHook(failing), 50_000).toFixed(0)} with (hook calls ${spans})`,
  );
}

// ---------------------------------------------------------------- Runner cost against ~standard.validate
{
  const user = (i: number) => ({
    id: `u${i}`,
    name: `User ${i}`,
    email: `u${i}@example.com`,
    age: 20 + (i % 50),
    admin: i % 7 === 0,
  });
  const list = {
    items: Array.from({ length: 20 }, (_, i) => user(i)),
    total: 20,
  };
  const small = { id: "u1", age: 3 };
  const schemas: Record<string, [Schema, Schema]> = {
    "zod 4": [
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            email: z.email(),
            age: z.number().int(),
            admin: z.boolean(),
          }),
        ),
        total: z.number().int(),
      }),
      z.object({ id: z.string(), age: z.number() }),
    ],
    "valibot 1": [
      v.object({
        items: v.array(
          v.object({
            id: v.string(),
            name: v.string(),
            email: v.pipe(v.string(), v.email()),
            age: v.pipe(v.number(), v.integer()),
            admin: v.boolean(),
          }),
        ),
        total: v.pipe(v.number(), v.integer()),
      }),
      v.object({ id: v.string(), age: v.number() }),
    ],
    "arktype 2": [
      type({
        items: type({
          id: "string",
          name: "string",
          email: "string.email",
          age: "number.integer",
          admin: "boolean",
        }).array(),
        total: "number.integer",
      }),
      type({ id: "string", age: "number" }),
    ],
  };
  console.log(
    "C18  ns/check, min of 7    direct   validateStandard  receiver   sender   (20-item list | 2-field object)",
  );
  for (const [name, [big, tiny]] of Object.entries(schemas)) {
    const row: string[] = [];
    for (const [s, value, n] of [
      [big, list, 20_000],
      [tiny, small, 300_000],
    ] as const) {
      const c = broker.contract({
        inbound: { t: { payload: s } },
        outbound: { t: { payload: s } },
      });
      const recv = createReceiver(c, "inbound");
      const send = createSender(c, "outbound");
      const msg = { topic: "t", payload: value };
      row.push(
        [
          bench(() => s["~standard"].validate(value), n),
          bench(() => validateStandard(s, value, "payload"), n),
          bench(() => recv(msg), n),
          bench(() => send(msg as never), n),
        ]
          .map((x) => x.toFixed(0).padStart(7))
          .join(" "),
      );
    }
    console.log(`     ${name.padEnd(20)} ${row.join("  |  ")}`);
  }
  const yupSchema = yup.object({
    id: yup.string().required(),
    age: yup.number().required(),
  });
  const yc = broker.contract({ inbound: { t: { payload: yupSchema } } });
  const yr = createReceiver(yc, "inbound");
  const timeAsync = async (fn: () => unknown, n = 20_000): Promise<number> => {
    let best = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = Bun.nanoseconds();
      for (let i = 0; i < n; i++) await fn();
      best = Math.min(best, (Bun.nanoseconds() - t0) / n);
    }
    return best;
  };
  line(
    "C18",
    `yup 1.7 (2-field, awaited): direct ${(await timeAsync(() => yupSchema["~standard"].validate(small))).toFixed(0)} ns, receiver ${(await timeAsync(() => yr({ topic: "t", payload: small }))).toFixed(0)} ns`,
  );
}

// ---------------------------------------------------------------- HTTP's model at runtime: status → {headers, body by media type}
{
  const User = z.object({ id: z.string() });
  const route = http.contract(
    {
      inbound: { params: z.object({ id: z.string() }) },
      outbound: {
        200: {
          body: { "application/json": User, "text/plain": z.string() },
          headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }),
        },
        201: {
          headers: z.object({ location: z.string() }),
          body: { "application/json": User },
        },
        204: { body: null },
      },
    },
    { name: "getUser" },
  );
  const send = createSender(route, "outbound");
  const show = (x: unknown): string =>
    x instanceof ContractError ? `error ${JSON.stringify(x.issues)}` : "ok";
  line(
    "C19",
    `200 text/plain "u1": ${show(send({ status: 200, headers: { "x-rate-limit-remaining": 3 }, body: { mediaType: "text/plain", value: "u1" } }))}`,
  );
  line(
    "C19",
    `200 "Text/Plain; charset=utf-8" (parameters and case ignored at runtime): ${show(send({ status: 200, headers: { "x-rate-limit-remaining": 3 }, body: { mediaType: "Text/Plain; charset=utf-8", value: "u1" } } as never))}`,
  );
  line(
    "C19",
    `200 text/plain 42: ${show(send({ status: 200, headers: { "x-rate-limit-remaining": 3 }, body: { mediaType: "text/plain", value: 42 } } as never))}`,
  );
  line(
    "C19",
    `200 text/html: ${show(send({ status: 200, headers: { "x-rate-limit-remaining": 3 }, body: { mediaType: "text/html", value: "<p>" } } as never))}`,
  );
  line(
    "C19",
    `201 without Location: ${show(send({ status: 201, headers: {}, body: { mediaType: "application/json", value: { id: "1" } } } as never))}`,
  );
  line(
    "C19",
    `204 with a body: ${show(send({ status: 204, body: { mediaType: "application/json", value: {} } } as never))}`,
  );
  line("C19", `418: ${show(send({ status: 418 } as never))}`);
  const recv = createReceiver(route, "outbound");
  const parsed = recv({
    status: 200,
    headers: { "x-rate-limit-remaining": "7" },
    body: { mediaType: "application/json", value: { id: "u1" } },
  });
  line(
    "C19",
    `client parses a 200: ${JSON.stringify(parsed)} (header coerced to ${typeof (parsed as { headers: { "x-rate-limit-remaining": unknown } }).headers["x-rate-limit-remaining"]})`,
  );

  // ------------------------------------------------------------ Reachable at runtime
  const handler = attachContract(() => undefined, route);
  const found = getContract(handler);
  const entries = describeContract(getContract(handler as unknown) ?? route);
  line(
    "C20",
    `getContract(handler) === route: ${found === route}; enumerable keys of the handler: ${JSON.stringify(Object.keys(handler))}; describeContract → ${entries.length} entries`,
  );
  for (const e of entries) {
    const js = (
      e.schema?.["~standard"] as
        | { jsonSchema?: { input: (o: { target: string }) => unknown } }
        | undefined
    )?.jsonSchema;
    let doc = "(no ~standard.jsonSchema)";
    if (e.schema === null) doc = "(absent)";
    else if (js) {
      try {
        doc = JSON.stringify(js.input({ target: "draft-2020-12" })).replace(
          /"\$schema":"[^"]+",/,
          "",
        );
      } catch (error) {
        doc = `(jsonSchema threw: ${(error as Error).message})`;
      }
    }
    console.log(
      `     ${e.side.padEnd(8)} ${(e.keyName ? `${e.keyName}=${e.key}` : "").padEnd(10)} ${e.part.padEnd(7)} ${(e.mediaType ?? "").padEnd(16)} ${(e.vendor ?? "").padEnd(4)} ${doc}`,
    );
  }
}

// ---------------------------------------------------------------- A flow: children results typed and checked from the children's contracts
{
  const ocr = jobs.contract({
    inbound: { data: z.object({ url: z.string() }) },
    outbound: { result: z.object({ text: z.string() }) },
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
  const recv = createReceiver(publish, "inbound");
  const ok = recv({
    data: { docId: "d1" },
    children: { ocr: { text: "hello" }, resize: { width: 640 } },
  });
  const bad = recv({
    data: { docId: "d1" },
    children: { ocr: { text: 42 }, resize: { width: 640 } },
  });
  line(
    "C21",
    `valid flow parent: ${kind(ok)} ${JSON.stringify(ok)}; a bad child result: ${bad instanceof ContractError ? JSON.stringify(bad.issues) : "passed"}`,
  );
}

// ---------------------------------------------------------------- Declaration errors at runtime too
{
  const tries: [string, () => unknown][] = [
    [
      "key that is also a part",
      () =>
        defineTransport({
          name: "x",
          inbound: { key: "payload", parts: ["payload"] },
        }),
    ],
    [
      "media part not a part",
      () =>
        defineTransport({ name: "x", inbound: { parts: ["a"], media: ["b"] } }),
    ],
    [
      "undeclared part",
      () => http.contract({ inbound: { bdy: z.string() } } as never),
    ],
    ["undeclared side", () => jobs.contract({ sideways: {} } as never)],
  ];
  line(
    "C22",
    tries
      .map(([n, f]) => {
        try {
          f();
          return `${n}: accepted`;
        } catch (error) {
          return `${n}: ${(error as Error).name} "${(error as Error).message}"`;
        }
      })
      .join(" | "),
  );
}
