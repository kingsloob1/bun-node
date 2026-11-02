/**
 * Compile-time guarantees of the contract core's move to
 * `@kingsleyweb/bun-contract` (typed-client plan PR-K): every logger bun-common
 * accepts is still a contract `logger` option, and bun-common's contract
 * entries name the package's very types, with negative controls.
 *
 * Checked by `bun run check`; never run. Every `@ts-expect-error` must fire:
 * an unused one is itself an error (TS2578).
 */
import type * as Contract from "@kingsleyweb/bun-contract";
import type {
  BunyanLike,
  ConsolaLike,
  ConsoleLike,
  Log4jsLike,
  LogSink,
  Logger,
  LoggerLike,
  NestLoggerLike,
  PinoLike,
  TslogLike,
  WinstonLike,
} from "../lib/logging";
import type * as Common from "../lib/contract/index";
import type * as Model from "../lib/contract/model";
import type * as Root from "../lib/index";
import type * as Schemas from "../lib/types/standardSchema";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expectType<T extends true>(): T | void {}

/** Whether `A` can be passed where `B` is asked for. */
type Assignable<A, B> = [A] extends [B] ? true : false;

// Every LoggerLike, and each of its members, is a ContractLoggerLike: no
// logger bun-common took before the move is refused by the moved option.
expectType<Assignable<LoggerLike, Contract.ContractLoggerLike>>();
expectType<Assignable<Logger, Contract.ContractLogger>>();
expectType<Assignable<LogSink, Contract.ContractLogSink>>();
expectType<Assignable<PinoLike, Contract.ContractLogger>>();
expectType<Assignable<BunyanLike, Contract.ContractLogger>>();
expectType<Assignable<WinstonLike, Contract.ContractLogger>>();
expectType<Assignable<ConsolaLike, Contract.ContractLogger>>();
expectType<Assignable<Log4jsLike, Contract.ContractLogger>>();
expectType<Assignable<TslogLike, Contract.ContractLogger>>();
expectType<Assignable<NestLoggerLike, Contract.ContractLogger>>();
expectType<Assignable<ConsoleLike, Contract.ContractLogger>>();
expectType<Assignable<Console, Contract.ContractLoggerLike>>();
expectType<
  Equal<Common.GuardOptions["logger"], Contract.ContractLoggerLike | undefined>
>();

// Controls: what is not a logger stays refused.
// @ts-expect-error a number is not a logger
expectType<Assignable<number, Contract.ContractLoggerLike>>();
// @ts-expect-error an object with warn alone is not a logger
expectType<Assignable<{ warn: () => void }, Contract.ContractLoggerLike>>();
// @ts-expect-error a sink must take a record, not a number
expectType<Assignable<(line: number) => void, Contract.ContractLoggerLike>>();

// bun-common's entries name the package's very types and values: the
// re-export is unchanged, not a copy that could drift.
expectType<Equal<Common.GuardOptions, Contract.GuardOptions>>();
expectType<Equal<Model.GuardOptions, Contract.GuardOptions>>();
expectType<Equal<Root.GuardOptions, Contract.GuardOptions>>();
expectType<Equal<Root.ValidationIssue, Contract.ValidationIssue>>();
expectType<Equal<Common.ContractEntry, Contract.ContractEntry>>();
expectType<Equal<Common.ChannelSpec, Contract.ChannelSpec>>();
expectType<
  Equal<typeof Common.createReceiver, typeof Contract.createReceiver>
>();
expectType<Equal<typeof Root.createSender, typeof Contract.createSender>>();
expectType<Equal<typeof Root.CONTRACT, typeof Contract.CONTRACT>>();
expectType<
  Equal<
    Schemas.StandardSchemaV1<string, number>,
    Contract.StandardSchemaV1<string, number>
  >
>();
expectType<Equal<Root.StandardJSONSchemaV1, Contract.StandardJSONSchemaV1>>();
expectType<
  Equal<
    Schemas.StandardSchemaV1.InferOutput<
      Contract.StandardSchemaV1<string, number>
    >,
    number
  >
>();
// @ts-expect-error control: a different type is told apart
expectType<Equal<Common.GuardOptions, Contract.IssueContext>>();
