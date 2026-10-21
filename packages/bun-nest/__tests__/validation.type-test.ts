/**
 * Compile-time assertions for bun-validate V6 (plan
 * `docs/plans/bun-validate/` §4.5.2–§4.5.3): a `SchemaDto` class's instance
 * type is its schema's output (zod, yup, a coercion, a
 * `string[]` wildcard), a union output is TS2509 at `extends`, and
 * `StandardSchemaPipe`'s schema and answer are typed from its schema.
 * Checked by `bun run check`, not `bun test`.
 *
 * Every `@ts-expect-error` sits directly above the line it guards; each was
 * shown to fire by deleting the directives (every guarded line then errors,
 * on that line, and nothing else does).
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type {
  ArgumentMetadata,
  BadRequestException,
  PipeTransform,
} from "@nestjs/common";
import type {
  StandardValidationException,
  StandardValidationPipeOptions,
} from "../lib";
import * as yup from "yup";
import { z } from "zod";
import {
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationModule,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "../lib";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** A DTO instance's own fields, without the class's (it has none). */
type Fields<T> = Pick<T, keyof T>;

/* ---- SchemaDto ------------------------------------------------------ */

const CreateUser = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int(),
  tags: z.array(z.string()).optional(),
});
class CreateUserDto extends SchemaDto(CreateUser) {}

// The instance type is the schema's output: a coerced `age` is a number.
export type _dtoIsOutput = Expect<
  Equal<
    Fields<CreateUserDto>,
    { name: string; age: number; tags?: string[] | undefined }
  >
>;
export type _dtoNotInput = Expect<
  Equal<Fields<CreateUserDto>, StandardSchemaV1.InferOutput<typeof CreateUser>>
>;

// The schema is carried, with its own type.
export type _dtoSchema = Expect<
  Equal<(typeof CreateUserDto)["schema"], typeof CreateUser>
>;

/** A handler typed through the DTO, as `@Body() body: CreateUserDto` is. */
export function handler(body: CreateUserDto): number {
  return body.age;
}

// @ts-expect-error the DTO's type is the schema's output: age is a number, not the wire's string
export const _wrongAge: CreateUserDto = { name: "a", age: "1" };

// @ts-expect-error a field the schema does not declare is not on the DTO
export const _undeclared: string = ({} as CreateUserDto).email;

// A wildcard route's `*path` param is a `string[]` (Nest 12, nestjs-12-parity PR-5).
const Wildcard = z.object({ path: z.array(z.string()) });
class WildcardDto extends SchemaDto(Wildcard) {}
export type _wildcard = Expect<Equal<Fields<WildcardDto>, { path: string[] }>>;

// yup, an async vendor: the same rule.
const YupUser = yup.object({
  name: yup.string().required(),
  age: yup.number().required(),
});
class YupUserDto extends SchemaDto(YupUser) {}
export type _yup = Expect<
  Equal<Fields<YupUserDto>, { name: string; age: number }>
>;

// A subclass keeps the type and the schema.
export class AdminDto extends CreateUserDto {}
export type _subclass = Expect<
  Equal<(typeof AdminDto)["schema"], typeof CreateUser>
>;

const Either = z.union([
  z.object({ a: z.string() }),
  z.object({ b: z.number() }),
]);
// @ts-expect-error a union output cannot be a class's instance type (TS2509): such a schema takes StandardSchemaPipe and InferOutput<>
export class _UnionDto extends SchemaDto(Either) {}

// @ts-expect-error a non-object output is refused at the call
export const _StringDto = SchemaDto(z.string());

/* ---- StandardSchemaPipe -------------------------------------------- */

const pipe = new StandardSchemaPipe(CreateUser);
export type _pipeSchema = Expect<Equal<typeof pipe.schema, typeof CreateUser>>;

declare const metadata: ArgumentMetadata;
export const answer = pipe.transform({}, metadata);
// The answer is the output, or a Promise of it for an async vendor.
export type _pipeAnswer = Expect<
  Equal<
    typeof answer,
    | StandardSchemaV1.InferOutput<typeof CreateUser>
    | Promise<StandardSchemaV1.InferOutput<typeof CreateUser>>
  >
>;

// It is a Nest pipe, whose output type is the schema's (or a Promise of it).
export const _isPipe: PipeTransform<
  unknown,
  | StandardSchemaV1.InferOutput<typeof CreateUser>
  | Promise<StandardSchemaV1.InferOutput<typeof CreateUser>>
> = pipe;

// A one-key schema (`@Query('page', pipe)`): the value's own type.
const pagePipe = new StandardSchemaPipe(z.coerce.number().int());
export const _page: number | Promise<number> = pagePipe.transform("2");

// @ts-expect-error the answer is not the schema's input
export const _notInput: string | Promise<string> = pagePipe.transform("2");

// @ts-expect-error a schema is required
export const _noSchema = new StandardSchemaPipe();

export const _badMessages = new StandardSchemaPipe(CreateUser, {
  // @ts-expect-error `messages` takes "generic" only, as on validate()
  messages: "verbose",
});

// @ts-expect-error `redactPaths` is a boolean
export const _badRedact = new StandardValidationPipe({ redactPaths: "yes" });

// The same options, accepted everywhere they are taken.
export const _options = [
  new StandardSchemaPipe(CreateUser, {
    messages: "generic",
    redactPaths: true,
  }),
  new StandardValidationPipe({ messages: "generic" }),
  StandardValidationModule.forRoot({ redactPaths: true }),
  new ValidationExceptionFilter(),
];

/* ---- the exported error and options type ---------------------------- */

// The pipes' error is a BadRequestException carrying the core's issues.
export const _isBadRequest: BadRequestException =
  {} as StandardValidationException;
export type _issues = Expect<
  Equal<
    StandardValidationException["issues"][number]["target"],
    "body" | "query" | "params" | "custom"
  >
>;

// The options type is what each pipe and forRoot() take.
export type _optionsType = Expect<
  Equal<
    ConstructorParameters<typeof StandardValidationPipe>[0],
    StandardValidationPipeOptions | undefined
  >
>;
export type _optionsFields = Expect<
  Equal<
    Required<StandardValidationPipeOptions>,
    { messages: "generic"; redactPaths: boolean }
  >
>;
