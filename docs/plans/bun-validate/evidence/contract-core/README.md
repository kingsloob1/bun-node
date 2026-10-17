# contract-core: one validation contract for every transport

A spike, not product code. It tests whether one model can sit under every
transport BunValidate is asked to cover: HTTP requests and responses,
WebSocket frames, SSE events, bun-jobs data and results (flows included),
Kafka and other message brokers, gRPC and UDP. The parts it has to hold are
one contract, one runner, one issue shape, one failure policy, static types
derived from the contract, and schemas a generator can reach at runtime. It
backs the plan's §4.1 revision ([`../../README.md`](../../README.md)).

Recorded 2026-10-17 on branch `docs/plan-bun-validate-scope` (base
`68023d36`), Bun 1.4.4-canary.1 (`5f5799ed1`), linux/x64, zod 4.6.1, valibot
1.5.0, arktype 2.2.3, yup 1.7.1 (the repo's root `node_modules`; run
`bun install` at the root first).

## Files and how to run them

Run everything from this folder.

| File | What it is | Run | Pass condition |
|---|---|---|---|
| `core.ts` | the core: model, `defineTransport`, contracts, runner, issues, policy, `getContract`, `describeContract` | imported by the rest | — |
| `transports.ts` | HTTP, WebSocket, SSE, jobs (with `flow`), Kafka and gRPC declared through the core, with the typed handler and sender types each would expose | types only | — |
| `udp.ts` | spike adapter: request/reply over `Bun.udpSocket` on loopback, port 0 | via `run.ts` | C1–C6 |
| `broker.ts` | spike adapter: an in-process topic → handlers broker, `{ payload, key, headers }` | via `run.ts` | C7–C9 |
| `types.probe.ts` | type assertions with 24 negative controls | `bash check-types.sh` | clean exit 0, **and** the mutant fails on exactly the 24 lines the controls guard |
| `check-types.sh` | `bun --check` here, then the mutant (every `// @ts-expect-error` line removed) in a scratch directory (default `~/.cache/bun-node-11/validate-plan/s1/mutant`; it writes and deletes only there) | `bash check-types.sh [dir]` | prints `PASS: every control fires, and nothing else fails` |
| `run.ts` | the runtime cases C1–C22 | `bun run.ts` | each line as described below |
| `results.txt` | recorded output of both | — | — |
| `tsconfig.json` | extends `../tsconfig.json`, `include: ["./*.ts"]`, so `bun --check` here checks these files (the parent's `include` covers only `../*.ts`) | — | — |

Every `bun --check` runs as `env -u AGENT -u CLAUDECODE -u REPL_ID bun --check`
(the repo's `CLAUDE.md`, "Bun's checker, not tsc"). Lint:
`CI=1 bunx eslint --config ../../../../../templates/eslint.config.mjs --no-warn-ignored *.ts`
gives 0 errors and 0 warnings. `run.ts` turns off `no-console` and
`antfu/no-top-level-await` as the repo's `scripts/` config does, and
`types.probe.ts` turns off `prettier/prettier`, because its controls are tied
to lines.

### What each runtime case shows

| Case | Shows | Recorded |
|---|---|---|
| C1 | UDP, `"error"`: a valid datagram reaches the typed handler, parsed (`z.coerce.date()` arrives as a `Date`); the reply is checked as a sender | ack `seq:1` |
| C2 | UDP, `"error"`: an invalid datagram gets an error frame with the issues; the handler never runs | `handler saw 0` |
| C3 | UDP, `"warn"`: logged once, passed through **raw** (the handler sees the string, not the `Date`) | 1 log line |
| C4 | UDP, `"off"`: unchecked; `"off"` compiles to the identity guard, so the schema is never called | `schema calls 0` against 1 under `"error"` |
| C5 | UDP: an undeclared `type` is an issue on the key field | `target: "type"` |
| C6 | the typed UDP client checks before sending; an invalid request never leaves | `ContractError before send` |
| C7–C9 | broker: a valid publish answers **synchronously** (zod), consumers get outputs (`z.coerce.number()` → number); an invalid one returns a `ContractError` synchronously and delivers nothing; a yup topic answers with a Promise; a topic with no schema answers synchronously | as stated |
| C10 | sync or Promise, per vendor, at all four levels (direct, `validateStandard`, receiver, sender) | table below |
| C11 | the received value in issues: the vendors' raw issues against the core's | table below |
| C12 | `"warn"`'s log line holds `transport, side, key, issues` and each issue only `target, path, message, key` | `no value` |
| C13–C15 | no schema: a synchronous answer, the very same object, no result allocated | below |
| C16–C17 | `onIssues` is called once per failing message and never on a valid one, with `{ transport, side, key, policy }`; unset, it costs nothing measurable | below |
| C18 | what the runner costs over `~standard.validate` | below |
| C19 | HTTP's model at runtime: status → `{ headers, body }`, the body keyed by media type; an undeclared media type, a missing `Location`, a body on a 204 and an undeclared status are each one issue; a client parse coerces a header | as stated |
| C20 | `getContract(handler)` returns the contract (attached non-enumerably); `describeContract` lists 7 entries, with JSON Schema from zod's `~standard.jsonSchema` | as stated |
| C21 | a flow parent receives its children's results, checked against each child's own result schema; a bad child result is `target: "children", path: "ocr.text"` | as stated |
| C22 | the declaration mistakes the types catch are also `TypeError`s at runtime (key that is also a part, media part not a part, undeclared part, undeclared side) | as stated |

## The final signatures

```ts
// The model
type Schema = StandardSchemaV1;
interface MediaMap { readonly [mediaType: string]: Schema }          // OpenAPI's `content`
type PartDecl = Schema | MediaMap | null;                           // null: must be absent (a 204 body)
interface SideSpec { parts: readonly string[]; key?: string; media?: readonly string[] }
interface TransportSpec { name: string; inbound?: SideSpec; outbound?: SideSpec }
type Side = "inbound" | "outbound";
type Policy = "off" | "warn" | "error";

function defineTransport<const T extends TransportSpec>(spec: T): Transport<T>;
interface Transport<T> {
  spec: T;
  contract<const D extends ContractDef<T>>(def: D & StrictDef<T, D>, meta?: ContractMeta): Contract<T, D>;
}
interface Contract<T, D> { transport: T; def: D; meta: ContractMeta; [CONTRACT]: Contract<T, D> }

// Static types (R = "send" | "receive")
type ReceiveOf<S> = StandardSchemaV1.InferOutput<S>;
type SendOf<S> = unknown extends StandardSchemaV1.InferInput<S> ? StandardSchemaV1.InferOutput<S> : StandardSchemaV1.InferInput<S>;
type Received<C, Sd extends Side>;   // flat message: { [keyName]: K, ...each part's output }, a union over keys
type Sent<C, Sd extends Side>;       // the same, held to SendOf
type KeysOf<C, Sd>; type PartsOf<C, Sd, K, R>; type MediaValue<M, R> = { mediaType: K; value: … } (a union over M)

// Runtime reachability
const CONTRACT: unique symbol;      // Symbol.for("bun-validate.contract")
function attachContract<X extends object, C>(target: X, contract: C): X & Carries<C>;
function getContract<C>(x: Carries<C>): C;
function getContract(x: unknown): AnyContract | undefined;
function describeContract(c: AnyContract): ContractEntry[];  // { side, keyName?, key?, part, mediaType?, schema, vendor? }

// The runner and the issue
interface ContractIssue { target: string; message: string; path: string; key?: string; mediaType?: string }
type StandardOutcome<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };
function validateStandard<S extends Schema>(schema: S, value: unknown, target: string, key?: string, mediaType?: string):
  StandardOutcome<ReceiveOf<S>> | Promise<StandardOutcome<ReceiveOf<S>>>;
function recordOf<const M extends Record<string, Schema>>(schemas: M): StandardSchemaV1<{ [K in keyof M]: SendOf<M[K]> }, { [K in keyof M]: ReceiveOf<M[K]> }>;
function andThen<A, B>(x: MaybePromise<A>, f: (a: A) => MaybePromise<B>): MaybePromise<B>;

// The policy
interface GuardOptions {
  policy?: Policy;                                                      // default "error"
  logger?: { warn(message: string, fields: Record<string, unknown>): void };
  onIssues?: (issues: readonly ContractIssue[], ctx: IssueContext) => void;
  undeclaredKey?: "report" | "allow";                                   // default "report"
}
interface IssueContext { transport: string; side: Side; key?: string; policy: Policy }
class ContractError extends Error { issues: readonly ContractIssue[]; context: IssueContext }
interface Guard<In, Out> { (message: In): MaybePromise<Out | ContractError>; readonly checks: boolean }
function createReceiver<C, Sd extends Side>(c: C, side: Sd, o?: GuardOptions): Guard<unknown, Received<C, Sd>>;
function createSender<C, Sd extends Side>(c: C, side: Sd, o?: GuardOptions): Guard<Sent<C, Sd>, Sent<C, Sd>>;
```

Declaring HTTP, with the coordinator's per-status `{ headers, body }` and the
body keyed by media type:

```ts
export const http = defineTransport({
  name: "http",
  inbound: { parts: ["params", "query", "headers", "cookies", "body"], media: ["body"] },
  outbound: { key: "status", parts: ["headers", "body"], media: ["body"] },
});
http.contract({
  inbound: { params: IdParams, query: Page },
  outbound: {
    200: { headers: z.object({ "x-rate-limit-remaining": z.coerce.number() }),
           body: { "application/json": User, "text/plain": z.string() } },
    201: { headers: z.object({ location: z.string(), "set-cookie": z.array(z.string()).optional() }),
           body: { "application/json": User } },
    204: { body: null },
  },
});
```

That is the nesting key → parts → media-type variants, and the model needs
nothing more to express it: a part listed in `media` takes a `MediaMap`, and
its value in a message is `{ mediaType, value }`. Text, HTML, bytes and Blob
are variants with their own schemas. How the bytes are checked is
`evidence/http-complete/`'s job.

## What the design proved

- **One model holds every transport named.** Each is three to five lines of
  part and key names (`transports.ts`, `udp.ts`, `broker.ts`). Typing,
  checking and documentation metadata all follow from that declaration.
- **The runner answers synchronously when the vendor does** (C10): zod,
  valibot, arktype and a hand-rolled sync schema are sync at every level. yup
  and a hand-rolled async schema return a Promise, and so does any message
  with one async part. A broker publish therefore rejects before the enqueue
  (C8), and an HTTP sender can decide before the `Response` is built.
- **The input-or-output rule holds on every transport.** zod's input binds
  the sender (a `z.date()` must be a `Date`). A schema whose input is
  `unknown` binds by its output. A `z.coerce.number()` or a transform reaches
  the receiver as its output. These are type-checked in `types.probe.ts`.
- **Undeclared keys, parts, sides and media types** are type errors, and
  also runtime errors (C5, C19, C22).
- **Flows compose.** `recordOf` builds a Standard Schema over the children's
  result schemas, so the parent's `children.ocr.text` is typed from the
  child's contract and checked at runtime (C21, and the probe).
- **The schemas can be reached at runtime** (C20). A generator walks
  `describeContract` and reads `~standard.jsonSchema`, without enumerable
  noise on the carrier.
- **Issues carry no received value** (C11, C12; details below).
- **No schema costs no await and no allocation** (C13–C15): the identity
  guard, or a key whose plan is empty, hands back the same object
  synchronously, and 100,000 retained results add 0 live objects (199,999
  with one zod part). That the path allocates nothing *transient* is by
  construction: the identity guard is `(m) => m`, and the empty-plan branch
  returns before the first allocating statement. The retained count cannot
  see short-lived objects.
- **`onIssues` costs nothing when unset** (C17): the success path never
  reaches it, and on the failure path it is one branch.

### Sync or Promise, per vendor (C10)

| Vendor | `~standard.validate` | `validateStandard` | receiver | sender |
|---|---|---|---|---|
| zod 4.6 | sync | sync | sync | sync |
| valibot 1.5 | sync | sync | sync | sync |
| arktype 2.2 | sync | sync | sync | sync |
| yup 1.7 | Promise | Promise | Promise | Promise |
| hand-rolled sync | sync | sync | sync | sync |
| hand-rolled async | Promise | Promise | Promise | Promise |

### What the received value does in issues (C11)

The vendors' own issues quote the received value: valibot in every message
(`received "SECRET-7731"`) and in its path segments (`input`, `value`),
arktype (`(was "SECRET-7731")`), yup (`cast from the value`), and zod for an
unrecognised key. The core copies only `message` and the path's keys. It
replaces any message that contains a received leaf value (strings of three
or more characters, numbers of three or more digits, shorter ones in quoted
form, and object keys in quoted form) with `Invalid value`, plus the
vendor's `code` when it has one. After that, no message leaks in any case.
**What is left is the path**: an unknown key's *name* is in the path for
valibot's and arktype's strict objects. See the open questions.

### Cost (C14, C17, C18; the minimum of each figure over three runs, `results.txt`)

`run.ts` takes the minimum of 7 rounds, and `results.txt` holds three runs,
made at a 1-minute load of 9 to 13 on 16 cores (another session's job; it
had peaked at 61 a few minutes earlier). Read the figures as orders of
magnitude.

| Path | ns per message |
|---|---|
| the handler called directly | 0.43 (the JIT folds most of it) |
| no side declared: the identity guard | 2.77 |
| the same, with the adapter testing `guard.checks` and skipping the call | 3.83 |
| a keyed side, a key with no schema (one property read, one `Map` lookup) | 15.1 |
| one zod part, 2-field object, receiver | 151 |

| One check, 2-field object | `~standard.validate` | `validateStandard` | receiver | sender |
|---|---|---|---|---|
| zod 4 | 71 | 79 | 199 | 172 |
| valibot 1 | 65 | 74 | 189 | 165 |
| arktype 2 | 63 | 84 | 197 | 173 |

- `validateStandard` adds 8–21 ns over the vendor (one outcome object). A
  receiver adds ~125–135 ns: the key lookup, the outcome objects and the
  parsed copy. A sender adds ~100 ns. These are fixed costs. On the 20-item
  list (zod 4.3 µs, valibot 3.5 µs, arktype 1.1 µs direct) they fall inside
  the run-to-run noise at this load: see the rows in `results.txt`.
- yup, 2 fields, awaited: 4.6 µs direct, 4.8 µs through the receiver.
- `onIssues` (C17): a valid message costs 165 ns without the hook and 164
  ns with it, and a failing one 1,661 ns and 1,679 ns. The failing path
  costs ~1.7 µs either way: the scrub, plus a `ContractError` with its stack.

## What changed from the sketch, and why

1. **Messages are flat and named by the transport's key field.** A message
   is `{ status: 201, headers, body }` or `{ topic: "orders", payload, key,
   headers }`, not an envelope with a `key` field. Kafka has a *part* named
   `key`, so a fixed envelope name would collide. `defineTransport` refuses
   a key that is also a part (C22).
2. **A part declaration can be a `MediaMap` or `null`**, for the
   coordinator's per-status, per-media-type responses. `null` is "must be
   absent" (a 204's body). Only parts listed in `media` accept a map, and
   the probe checks that.
3. **There are two guards, not one: `createReceiver` parses,
   `createSender` checks.** A receiver's handler gets each part's output. A
   sender's guard returns the very object it was given, because what goes on
   the wire is the sender's value (plan §4.2 sends the raw body once it
   passes). The roles are views of a side, so one Kafka topic map serves as
   the producer's `outbound` and the consumer's `inbound`.
4. **A guard *returns* a `ContractError` rather than throwing**, and is
   compiled once per side, with a plan per key. Without that there is no
   allocation-free path, and the sync/Promise answer could not be kept.
   `Guard.checks` is `false` when there is nothing to check, so an adapter
   can skip the call entirely.
5. **`StrictDef`** is needed because a `const` generic skips excess-property
   checks. Without it, `http.contract({ inbound: { bdy: … } })` compiled.
6. **The issue gained `key` and `mediaType`.** `target` is the part, or the
   key field for an undeclared key; `path` stays a dotted string, so
   `{ target, message, path }` keeps today's meaning. The message is
   scrubbed (rule 1).
7. **`recordOf` joined the core.** Flows need it, and so would gRPC
   metadata maps. Its input type applies `SendOf` per member: a whole-object
   input is never `unknown`, so the rule must apply at the leaves.
8. **The helper is `andThen`, not `then`.** A module that exports `then` is
   a thenable, and `await import("./core.ts")` called it and rejected. That
   is ordinary JavaScript semantics, not a Bun bug. Measured while building
   this.

## Open design questions (each with a recommendation)

1. **`"warn"` and `"off"` on a receiver break its static type.** C3 and C4:
   the handler is typed `Date` and gets a string. **Recommend** that
   receivers (inbound HTTP, consumers, job processors) accept only
   `"error"`, as BunValidate's request side does today, and that
   `"warn"`/`"off"` apply only to senders, where the compiler has already
   typed the value. If a receiver ever needs `"warn"`, type its handler's
   message as `unknown`.
2. **Path segments can carry user data.** An unknown key's name appears in
   valibot's and arktype's paths (C11). A record schema keyed by user data
   (emails as keys) does the same. **Recommend** that paths stay, because a
   client needs them to point at a field, and that the plan states the rule
   as "no received *value*". Add an opt-in `redactPaths` for a schema keyed
   by user data. Do not scrub paths by default: that would blind every 400
   body.
3. **The scrub is heuristic.** It matches leaves of three or more
   characters, and shorter ones only in quoted form, bounded at 256 leaves
   and depth 8. **Recommend** keeping it, since it runs only on failure, and
   pairing it with a `messages: "generic"` option for deployments that must
   guarantee no value in any message. A test like C11 should run against
   each supported vendor.
4. **Media-type matching.** At runtime, parameters and case are ignored
   (C19), but the types demand the bare literal. Wildcards (`text/*`,
   `*/*`) are not matched. **Recommend** keeping exact bare types in the
   contract, as OpenAPI keys them, deriving `mediaType` from `Content-Type`
   in the HTTP adapter, and adding wildcard ranges only with a precedence
   rule (most specific wins), as OpenAPI's do.
5. **The wire changes types.** A typed HTTP client receives
   `Jsonify<output>` (TC D5), not the output itself: a `Date` arrives as a
   string. The core's `Received` is the in-process view. **Recommend** a
   per-transport `wire` mapping on `defineTransport` (identity for
   in-process brokers, `Jsonify` for JSON transports) that the client types
   apply. It does not belong in the core's `Received`.
6. **The keyed lookup is ~15 ns, even for a key with no schema.**
   **Recommend** exposing `checksKey(key)` (or the plan map) so a router
   that already resolves the key (a topic table, a route table) caches the
   answer beside its handler and skips the guard.
7. **Double checking in-process.** The broker checks on publish (as the
   sender) and again on delivery (as the receiver). That is right across
   services and redundant in one process. **Recommend** defaulting
   `deliver.policy` to `"error"` but letting a broker that knows the
   producer is local reuse the publish result. Measure before optimising.
8. **A failed flow child.** `recordOf` requires every child's result. A
   parent that tolerates child failure (bun-jobs' `failParentOnFailure:
   false`) needs those members optional. **Recommend** that `flow` take
   per-child `optional: true`, typed as `T | undefined`.
9. **HTTP routes sit above the contract.** A contract is per route; the
   route table (method + path) is the key one level up, and that is what
   OpenAPI's `paths` reads. **Recommend** keeping it there (the router's
   layers carry contracts through `attachContract`) rather than making
   `method`/`path` a key of the HTTP transport.
