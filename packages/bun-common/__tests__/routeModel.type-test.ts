/**
 * Compile-time guarantees of the route model (`lib/routeModel.ts`, V12): the
 * wire view of a contract row (`RowWireValue`, plan §4.12 M2/m3 — a body is
 * `Jsonify<WireInput<S>>`, so a `transform`'s field types as its **input** on
 * the wire, and a `Date` arrives as a string; path/query/header/cookie parts
 * are strings), and the `ListedRoute`/`BodyPlacement` shapes.
 *
 * Checked by `bun run check`; never run. Every `@ts-expect-error` must fire:
 * an unused one is itself an error (TS2578).
 *
 * Prettier is off for this file: `@ts-expect-error` covers only the next
 * line, so a statement reflowed over several lines would move the error off
 * its control.
 */
/* eslint-disable prettier/prettier */
/* eslint-disable unused-imports/no-unused-vars, @typescript-eslint/no-unused-vars -- the schemas are read through `typeof` only */
import type {
  ContractDescription,
  ContractEntry,
} from "../lib/contract/describe";
import type {
  BodyPlacement,
  ListedRoute,
  RowWireValue,
} from "../lib/routeModel";
import type {
  ResponseOutputMode,
  ResponseValidationMode,
} from "../lib/responseValidation";
import { z } from "zod";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
function expectType<T extends true>(): T | void {}

// M2's control: a transform's field types as its input on the wire.
const Body = z.object({ n: z.string().transform((s) => s.length) });
type BodyRow = ContractEntry & { encoding: "body"; schema: typeof Body };
expectType<Equal<RowWireValue<BodyRow>, { n: string }>>();
// @ts-expect-error the wire carries the transform's input (a string), never its output
expectType<Equal<RowWireValue<BodyRow>, { n: number }>>();

// m3's agreed Jsonify: a Date body field arrives as a string.
const Dated = z.object({ at: z.date() });
type DateRow = ContractEntry & { encoding: "body"; schema: typeof Dated };
expectType<Equal<RowWireValue<DateRow>, { at: string }>>();

// Path, query, header and cookie parts are strings on the wire.
type QueryRow = ContractEntry & {
  encoding: "querystring";
  schema: typeof Body;
};
expectType<Equal<RowWireValue<QueryRow>, string>>();
type HeaderRow = ContractEntry & {
  encoding: "header-string";
  schema: typeof Body;
};
expectType<Equal<RowWireValue<HeaderRow>, string>>();

// A part declared absent crosses as null.
type AbsentRow = ContractEntry & { encoding: "body"; schema: null };
expectType<Equal<RowWireValue<AbsentRow>, null>>();

// Bare, a row's encoding is not narrowed: the view degenerates to string.
expectType<Equal<RowWireValue, string>>();

// ListedRoute's shape.
expectType<Equal<ListedRoute["key"], string>>();
expectType<Equal<ListedRoute["method"], string>>();
expectType<Equal<ListedRoute["path"], string>>();
expectType<Equal<ListedRoute["params"], string[]>>();
expectType<Equal<ListedRoute["contract"], ContractDescription | undefined>>();
expectType<
  Equal<ListedRoute["responseValidation"], ResponseValidationMode | undefined>
>();
expectType<
  Equal<ListedRoute["responseOutput"], ResponseOutputMode | undefined>
>();
expectType<Equal<ListedRoute["partial"], true | undefined>>();

// @ts-expect-error `partial` is only ever `true`, never `false`
const wrongPartial: ListedRoute["partial"] = false;

declare const placement: BodyPlacement;
expectType<Equal<BodyPlacement["mediaType"], string>>();
expectType<Equal<BodyPlacement["required"], boolean>>();
// @ts-expect-error the placement is readonly
placement.required = true;
