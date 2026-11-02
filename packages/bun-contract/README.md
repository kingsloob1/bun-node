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
wants the server's own checks without bun-common's dependencies (the
typed-client plan, `docs/plans/typed-client/` §10.1).

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Logging](#logging)
- [What it exports](#what-it-exports)
- [Browser safety](#browser-safety)

## Requirements

- **Bun 1.4.2 or later** (`engines.bun: ">=1.4.2"`), or any browser bundler.
- **`@types/bun` 1.4.2 or later** and **TypeScript** 5.9 or 6: optional
  peers, for type-checking only. The declarations need no environment's
  types: they check under `lib: ["dom"]` alone.
- **No dependency**: installing it installs nothing else
  (`__tests__/packaging.test.ts` asserts the manifest).

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

The full guide (policies, `onIssues`, keyed sides, `describeContract`,
`mergeContracts`, carrying a contract on a middleware, channels) is
bun-common's
[Contracts](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common#contracts)
section: every name there is this package's, under either import path.

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

## Browser safety

`__tests__/browserSafety.test.ts` bundles the entry with
`Bun.build({ target: "browser" })` and fails on any server marker (`node:`
or `bun:` imports, `Bun.*`, `process.env`, `require(`, `Buffer.*`, an
`@kingsleyweb/bun-common` import) and on any module outside the package's
own `lib/`; a fixture reaching a Node API is its negative control. The
consumer check (`bun scripts/consumer-check.ts packages/bun-contract` from
the repo root) checks every spelling as a `browser` entry: no Node or Bun
type is loaded by its declarations.

The contract symbols are `Symbol.for(…)` keys, so two copies of the package
in one process (or this package and an older bun-common) agree on them.
