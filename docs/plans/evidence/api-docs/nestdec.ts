/* eslint-disable */
import type { StandardSchemaV1 } from "../lib/types/standardSchema";
import { toStandardSchema } from "../lib/BunValidate";

interface CreateUser { name: string }
interface UserDto { id: string; name: string }
interface Problem { code: string }
const CreateUserS = toStandardSchema<CreateUser>((v) => ({ value: v as CreateUser }));
const UserS = toStandardSchema<UserDto>((v) => ({ value: v as UserDto }));
const ProblemS = toStandardSchema<Problem>((v) => ({ value: v as Problem }));

type Out<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : never;

// ---------- D1: can a METHOD decorator constrain the RETURN type? ----------
interface ValidateOpts<
  B extends StandardSchemaV1 | undefined = undefined,
  R extends Record<number, StandardSchemaV1> | undefined = undefined,
> { body?: B; responses?: R }

type ReturnUnion<R> = R extends Record<number, StandardSchemaV1>
  ? { [K in keyof R]: Out<R[K]> }[keyof R]
  : unknown;

declare function Validate<
  B extends StandardSchemaV1 | undefined = undefined,
  const R extends Record<number, StandardSchemaV1> | undefined = undefined,
>(opts: ValidateOpts<B, R>): <
  T extends (...args: any[]) => ReturnUnion<R> | Promise<ReturnUnion<R>>,
>(
  target: object, key: string | symbol, descriptor: TypedPropertyDescriptor<T>,
) => void;

declare function Body(): ParameterDecorator;
declare function Post(p?: string): MethodDecorator;

class GoodController {
  @Post()
  @Validate({ body: CreateUserS, responses: { 200: UserS, 404: ProblemS } })
  create(@Body() body: Out<typeof CreateUserS>): UserDto {
    return { id: "1", name: body.name };
  }

  @Post()
  @Validate({ responses: { 200: UserS } })
  async asyncOk(): Promise<UserDto> { return { id: "1", name: "n" }; }
}

class BadController {
  @Post()
  // @ts-expect-error the method returns a shape no declared response allows
  @Validate({ responses: { 200: UserS, 404: ProblemS } })
  create(): { totally: "wrong" } { return { totally: "wrong" }; }
}

// ---------- D2: can a decorator RETYPE a parameter? ----------
declare function ValidatedBody<S extends StandardSchemaV1>(s: S): ParameterDecorator;
class ParamController {
  @Post()
  create(@ValidatedBody(CreateUserS) body: string) {
    // `body` is whatever the DEVELOPER wrote (string), not the schema output.
    const s: string = body;      // compiles => the decorator did NOT retype it
    return s;
  }
}

// ---------- D3: the helper-type route (what actually works) ----------
const schemas = { body: CreateUserS, query: UserS } as const;
type InferTargets<S> = { [K in keyof S]: Out<S[K]> };
class HelperController {
  @Post()
  @Validate({ body: CreateUserS, responses: { 200: UserS } })
  create(@Body() body: InferTargets<typeof schemas>["body"]): UserDto {
    const name: string = body.name;   // inferred from the schema, no restating
    return { id: "1", name };
  }
}
export { GoodController, BadController, ParamController, HelperController };
