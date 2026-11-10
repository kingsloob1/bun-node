# @kingsleyweb/bun-contract

The transport-agnostic **contract core** of the bun-\* packages, on its own:
no dependency, no Bun or Node API, safe in a browser bundle.

A transport declares the **parts** its messages carry on each **side**
(and, when a side carries several kinds of message, its **key**). A
**contract** maps parts to [Standard Schemas](https://standardschema.dev)
(zod, valibot, arktype, yup, or your own), and **guards** check messages
against it: a **receiver** parses what a side gets, a **sender** checks what
it sends.

[`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common#readme)
depends on this package and re-exports it, unchanged, as
`@kingsleyweb/bun-common/contract`: its `validate()`, `defineChannel()`,
documents and route listing are built on it. A server keeps importing from
bun-common. This package is for the other end, a browser or any client that
wants the server's own checks without bun-common's dependencies.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Guard options](#guard-options)
- [Logging](#logging)
- [What it exports](#what-it-exports)
- [Browser safety](#browser-safety)

## Requirements

- **Bun 1.4.2 or later** (`engines.bun: ">=1.4.2"`), or any browser bundler.
- **`@types/bun` 1.4.2 or later** and **TypeScript** 5.9 or 6: optional
  peers, for type-checking only. The declarations need no environment's
  types: they check under `lib: ["dom"]` alone.
- **No dependency**: installing it installs nothing else.

## Installation

```bash
bun add @kingsleyweb/bun-contract
```

## Usage

```ts
import { createReceiver, createSender, defineTransport } from "@kingsleyweb/bun-contract";
import { z } from "zod";

const jobs = defineTransport({
  name: "jobs",
  inbound: { parts: ["data"] },
  outbound: { parts: ["result"] },
});

const sendMail = jobs.contract({
  inbound: { data: z.object({ to: z.email(), at: z.coerce.date() }) },
  outbound: { result: z.object({ id: z.string() }) },
});

const receive = createReceiver(sendMail, "inbound");
const message = await receive({ data: { to: "a@example.com", at: "2026-11-02" } });
// message.data.at is a Date; a failing message is a ContractError, never a throw.

const send = createSender(sendMail, "outbound");
await send({ result: { id: "m1" } }); // the very message, checked
```

A **receiver** parses, so what it hands on carries each part's output (the
`z.coerce.date()` above arrives as a `Date`). A **sender** checks and
resolves to the very message it was given, which is what goes on the wire.
Either guard resolves to a `ContractError` (with `issues` and `context`) on a
mismatch under the default `"error"` policy; it never throws one. A guard is
synchronous when every schema it runs is, so `await` is only needed for an
async schema. A side with no schema, or a guard under `"off"`, is the
identity (`guard.checks` is `false`).

The full guide (policies, `onIssues`, keyed sides, `describeContract`,
`mergeContracts`, carrying a contract on a middleware, channels) is
bun-common's
[Contracts](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common#contracts)
section: every name there is this package's, under either import path. Its
[Writing a transport](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common#writing-a-transport)
shows a complete transport (UDP request and reply) built on the four calls
above.

## Guard options

`createReceiver(contract, side, options?)` and
`createSender(contract, side, options?)` take the same `GuardOptions`:

| Option | Default | What it does |
|---|---|---|
| `policy` | `"error"` | `"error"` resolves a mismatch to a `ContractError`; `"warn"` logs one line per failing message (no values) and hands the raw message on; `"off"` checks nothing. A receiver under `"warn"` or `"off"` is typed to hand on `unknown`. |
| `logger` | the console | Where `"warn"`'s lines and an `onIssues` failure go: a `ContractLoggerLike` ([Logging](#logging)). |
| `onIssues` | unset | `(issues, context) => void`, called once per failing message under `"warn"` and `"error"` (a telemetry hook). If it throws, the error is logged and the guard answers as if it had not. |
| `undeclaredKey` | `"report"` | On a keyed side, a key the contract does not declare is an issue (`"report"`) or passed through unchecked (`"allow"`). |
| `redactPaths` | `false` | Replace every issue's `path` with `""`, for schemas keyed by user data. |
| `messages` | unset | `"generic"` replaces every issue message with `Invalid value` (plus the vendor's issue code when it has one). By default only messages that quote a received value are withheld. |
| `stripProtoKeys` | `"nest"` | Which prototype-pollution keys a receiver deletes, in place, before its schemas run: `"nest"` removes every own `__proto__`, `prototype` and `constructor` key, recursively; `"minimal"` only own `__proto__` keys and own `constructor` keys whose value is an object with an own `prototype`. A sender never strips. Any other value throws a `TypeError` when the guard is built. |

A side declaring a key with variants (bun-common's HTTP `variants()`) is
not checked by these guards yet: building one throws a `TypeError`.

## Logging

A guard under the `"warn"` policy writes one warning per failing message
(no values), a guard whose `onIssues` hook throws writes one error, and
`mergeContracts` warns about a refined part. The `logger` option takes a
`ContractLoggerLike`:

- a **`ContractLogger`**: an object with `warn(message, fields)` and
  `error(message, fields)`, such as the console or bun-common's `Logger`;
- a **`ContractLogSink`**: a function taking each record
  (`{ level, message, error?, fields, bindings, time }`, a subset of
  bun-common's `LogEvent`).

With no logger the records go to the console. Objects are called message
first, so a logger that takes its fields first (pino, bunyan) needs an
adapter, such as bun-common's `fromPino`.

**With bun-common loaded**, its contract entry installs bun-common's
`resolveLogger` as the resolution: the option then takes every `LoggerLike`
bun-common does (pino, bunyan, winston, consola, log4js, tslog, NestJS and
console-like loggers, each called its own way), and the default is
bun-common's console logger, exactly as before the core moved here. Every
bun-common `LoggerLike` is a `ContractLoggerLike`, so the types accept the
same loggers either way.

## What it exports

From `@kingsleyweb/bun-contract` (and `/lib`):

| Kind | Names |
|---|---|
| Transports and contracts | `defineTransport`, `attachContract`, `getContract`, `forwardContract`, `CONTRACT` |
| Guards | `createReceiver`, `createSender`, `ContractError`, `validateStandard` |
| Reading contracts | `describeContract`, `mergeContracts`, `documented`, `recordOf` |
| Channels | `channelContract`, `channelErrorFrame`, `wsTransport` |
| Types | `Contract`, `ContractDef`, `GuardOptions`, `Guard`, `Policy`, `Received`, `Sent`, `WireInput`, `ValidationIssue`, `IssueContext`, `ContractEntry`, `ContractDescription`, the `Channel*` types and the rest of the model |
| Logging types | `ContractLogger`, `ContractLoggerLike`, `ContractLogSink`, `ContractLogEvent` |
| Standard Schema | `StandardSchemaV1`, `StandardTypedV1`, `StandardJSONSchemaV1` (vendored, types only) |

Every module is also reachable by deep import,
`@kingsleyweb/bun-contract/lib/<module>` (`guard`, `model`, `http`, `sse`,
`channel`, `logger`, `standardSchema`, …), for the internal helpers the root
does not export; bun-common's `lib/contract/<module>` paths re-export the
same modules.

## Browser safety and tree-shaking

- **No server API.** Nothing in the package imports a `node:` or `bun:`
  module, reads `process.env` or touches `Bun.*`, `Buffer` or `require`, and
  it imports no other package (the Standard Schema types are vendored). Its
  declarations load no Node or Bun types either, so they check under
  `lib: ["dom"]`.
- **ESM, named exports, no side effects.** `package.json` declares
  `"sideEffects": false`, so a bundler keeps only the exports you import.
- **TypeScript source.** The runtime entry is the package's `.ts` source
  (`lib/`), with built declarations in `dts/` for the type checker. Bun runs
  it directly; for a browser, bundle it with a bundler that compiles
  TypeScript from `node_modules`, such as `Bun.build` or esbuild.

The contract symbols are `Symbol.for(…)` keys, so two copies of the package
in one process (or this package and an older bun-common) agree on them.
