/**
 * Plan §B3.2: a Standard Schema "ValidationPipe" for Nest, and parameter types
 * that follow the schema without restating it.
 *
 * The idea (the nestjs-zod `createZodDto` pattern, made vendor-neutral):
 * `class CreateUserDto extends SchemaDto(CreateUser) {}` is a class whose
 * instance type IS the schema's output and which carries the schema as a
 * static. A parameter typed with it (`@Body() body: CreateUserDto`) is typed
 * from the schema, and Nest hands the class to pipes as `metadata.metatype`
 * (emitDecoratorMetadata), so ONE global pipe validates every such parameter.
 *
 * Runs the real Nest pipeline on bun-nest's BunHttpAdapter through
 * `adapter.fetch()`. From this directory (its tsconfig carries the decorator
 * options, which Bun reads from the cwd: oven-sh/bun#28605):
 *
 *   bun nest-schema-dto.ts; NOPIPE=1 bun nest-schema-dto.ts   (results-nest.txt)
 *   env -u AGENT -u CLAUDECODE -u REPL_ID bun --check   # the type controls
 */
import "reflect-metadata";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { BadRequestException, Body, Controller, Module, Post, Query, Get } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";

/* ---- the two pieces the plan proposes (prototype) ---------------------- */

/** A class whose instance type is `S`'s output, carrying `S` as `schema`. */
function SchemaDto<S extends StandardSchemaV1<unknown, object>>(schema: S) {
  abstract class Dto {
    /** The schema this DTO validates with. */
    static readonly schema: S = schema;
  }
  return Dto as unknown as (abstract new () => StandardSchemaV1.InferOutput<S>) & { readonly schema: S };
}

/** Validates any parameter whose type is a {@link SchemaDto} class; passes the rest through. */
class StandardValidationPipe implements PipeTransform {
  async transform(value: unknown, metadata: ArgumentMetadata) {
    const schema = (metadata.metatype as { schema?: StandardSchemaV1 } | undefined)?.schema;
    if (!schema?.["~standard"]) return value;
    const result = await schema["~standard"].validate(value);
    if (result.issues) {
      throw new BadRequestException({
        error: "Validation failed",
        issues: result.issues.map((i) => ({
          target: metadata.type,
          message: i.message,
          path: (i.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join("."),
        })),
      });
    }
    return result.value;
  }
}

/* ---- an app using them ------------------------------------------------- */

const CreateUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });
class CreateUserDto extends SchemaDto(CreateUser) {}
const Page = z.object({ page: z.coerce.number().int().min(1) });
class PageDto extends SchemaDto(Page) {}

@Controller("users")
class UsersController {
  @Post()
  create(@Body() body: CreateUserDto) {
    // Typed from the schema: age is a number, no annotation restating it.
    const age: number = body.age;
    return { name: body.name, age, typeofAge: typeof age };
  }

  @Get()
  list(@Query() query: PageDto) {
    return { page: query.page, typeofPage: typeof query.page };
  }
}

/* ---- type controls ----------------------------------------------------- */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _instance = Expect<Equal<Pick<CreateUserDto, keyof CreateUserDto>, { name: string; age: number }>>;
// @ts-expect-error the DTO's type is the schema's output: age is a number
const _bad: CreateUserDto = { name: "a", age: "1" };
// @ts-expect-error a union output cannot be a class's instance type (TS2509): such schemas need Infer<> instead
class _UnionDto extends SchemaDto(z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])) {}

@Module({ controllers: [UsersController] })
class AppModule {}

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
// Negative control: NOPIPE=1 runs the same app without the pipe (N2 then passes).
if (!process.env.NOPIPE) app.useGlobalPipes(new StandardValidationPipe());
await app.init();

const show = async (r: Response) => `${r.status} ${(await r.text()).slice(0, 200)}`;
const post = (body: unknown) =>
  adapter.fetch("/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log(`N1 POST valid body, age "41" coerced  => ${await show(await post({ name: "Ada", age: "41" }))}`);
console.log(`N2 POST invalid body                  => ${await show(await post({ name: "", age: "x" }))}`);
console.log(`N3 GET ?page=2 via a query DTO         => ${await show(await adapter.fetch("/users?page=2"))}`);
console.log(`N4 GET ?page=0                         => ${await show(await adapter.fetch("/users?page=0"))}`);
await app.close();
