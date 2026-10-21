/**
 * The bun-validate V6 groups of the differential (plan
 * `docs/plans/bun-validate/` §4.5.3, §4.5.5).
 *
 * - `validation` and `validation-no-filter`: the same application on both
 *   adapters, with `StandardValidationModule` (pipe and filter) or with the
 *   global pipe alone. The pipes and the filter are platform-neutral, so
 *   status, headers and body must be platform-express's.
 * - `validation-vs-nest12`: Nest 12's own `StandardSchemaValidationPipe` and
 *   `@Body({ schema })` on platform-express against `StandardSchemaPipe` on
 *   bun-nest, on schemas whose messages quote nothing and parameters with no
 *   key: the answers must be the same, a yup body with an own `__proto__`
 *   key included (both strip it first: 201, where yup alone crashes).
 *   Skipped visibly on Nest 11, which has no such pipe (read from
 *   `@nestjs/common`'s exports, never a version).
 */
import type { ExecutionContext, PipeTransform } from "@nestjs/common";
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { Configure, Side } from "./app";
import type { KnownDifference, Probe, ProbeGroup } from "./probes";
import * as nestCommon from "@nestjs/common";
import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  Get,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import * as yup from "yup";
import { z } from "zod";
import {
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationModule,
  StandardValidationPipe,
} from "../../lib";

const CreateUser = z.object({
  name: z.string().min(1),
  age: z.coerce.number().int(),
});
class CreateUserDto extends SchemaDto(CreateUser) {}
const Page = z.object({ page: z.coerce.number().int().min(1) });
class PageDto extends SchemaDto(Page) {}
const ApiHeaders = z.object({ "x-api-version": z.enum(["1", "2"]) });
const YupUser = yup.object({
  name: yup.string().required(),
  age: yup.number().required(),
});
class YupUserDto extends SchemaDto(YupUser) {}

/** A JSON body with an own `__proto__` key, as `JSON.parse` builds it. */
const PROTO_BODY = '{"name":"n","age":4,"__proto__":{"polluted":"yes"}}';

/** The request's headers, through a custom decorator (pipeable). */
const ReqHeaders = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<{ headers: unknown }>().headers,
);

@Controller("v")
class ValidationController {
  @Post("dto")
  dto(@Body() body: CreateUserDto) {
    return body;
  }

  @Get("dto")
  query(@Query() query: PageDto) {
    return query;
  }

  @Post("pipe")
  pipe(@Body(new StandardSchemaPipe(CreateUser)) body: unknown) {
    return body;
  }

  @Get("param/:id")
  param(
    @Param("id", new StandardSchemaPipe(z.coerce.number().int())) id: number,
  ) {
    return { id };
  }

  @Get("headers")
  headers(@ReqHeaders(new StandardSchemaPipe(ApiHeaders)) headers: unknown) {
    return headers;
  }

  @Post("yup")
  yup(@Body(new StandardSchemaPipe(YupUser)) body: unknown) {
    return body;
  }

  @Get("other-400")
  other() {
    throw new BadRequestException("not a validation error");
  }
}

@Module({
  imports: [StandardValidationModule],
  controllers: [ValidationController],
})
class ValidationModule {}

@Module({ controllers: [ValidationController] })
class PipeOnlyModule {}

/** The global pipe alone: no filter, so Nest answers the pipes' errors. */
const configurePipeOnly: Configure = (app) => {
  app.useGlobalPipes(new StandardValidationPipe());
};

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** The probes both validation groups send. */
const PROBES: Probe[] = [
  {
    name: "SchemaDto body, valid",
    path: "/v/dto",
    init: json({ name: "a", age: "3" }),
  },
  {
    name: "SchemaDto body, invalid",
    path: "/v/dto",
    init: json({ name: "", age: "x" }),
  },
  { name: "SchemaDto query, valid", path: "/v/dto?page=2" },
  { name: "SchemaDto query, invalid", path: "/v/dto?page=0" },
  { name: "pipe body, invalid", path: "/v/pipe", init: json({ name: "a" }) },
  { name: "pipe param, valid", path: "/v/param/7" },
  { name: "pipe param, invalid", path: "/v/param/x" },
  {
    name: "pipe headers, invalid",
    path: "/v/headers",
    init: { headers: { "x-api-version": "9" } },
  },
  {
    name: "pipe yup, valid",
    path: "/v/yup",
    init: json({ name: "n", age: "4" }),
  },
  { name: "pipe yup, invalid", path: "/v/yup", init: json({ age: 1 }) },
  { name: "pipe yup, a __proto__ key", path: "/v/yup", init: json(PROTO_BODY) },
  { name: "another 400, not caught", path: "/v/other-400" },
  { name: "invalid JSON, not caught", path: "/v/dto", init: json('{"name":') },
];

/* ---- ours on bun-nest against Nest 12's on platform-express -------- */

/** Nest 12's `StandardSchemaValidationPipe`, when the installed `@nestjs/common` has it. */
const NestStandardSchemaValidationPipe = (
  nestCommon as unknown as Record<string, unknown>
).StandardSchemaValidationPipe as (new () => PipeTransform) | undefined;

/** `@Body({ schema })` and `@Query({ schema })`, Nest 12's per-parameter schema. */
type WithSchema = (options: { schema: StandardSchemaV1 }) => ParameterDecorator;

/**
 * The Nest 12 application of `validation-vs-nest12`, one per side. Built
 * only where Nest 12's pipe exists. Nest 11's `@Body()` takes `{ schema }`
 * as a pipe without complaint: on 11.2.7 and 11.1.20 the class decorates,
 * `app.init()` succeeds, and a body the schema would refuse reaches the
 * handler unchecked (201, measured). Decorators applied by call, so nothing
 * runs at load.
 */
function nest12Modules(): Record<Side, new () => object> {
  const BodyWith = Body as unknown as WithSchema;
  const QueryWith = Query as unknown as WithSchema;

  class Nest12Controller {
    create(body: unknown) {
      return body;
    }

    list(query: unknown) {
      return query;
    }

    yup(body: unknown) {
      return body;
    }

    yupDto(body: unknown) {
      return body;
    }
  }
  BodyWith({ schema: CreateUser })(Nest12Controller.prototype, "create", 0);
  QueryWith({ schema: Page })(Nest12Controller.prototype, "list", 0);
  BodyWith({ schema: YupUser })(Nest12Controller.prototype, "yup", 0);
  BodyWith({ schema: YupUser })(Nest12Controller.prototype, "yupDto", 0);

  class OursController {
    create(body: unknown) {
      return body;
    }

    list(query: unknown) {
      return query;
    }

    yup(body: unknown) {
      return body;
    }

    yupDto(body: unknown) {
      return body;
    }
  }
  Body(new StandardSchemaPipe(CreateUser))(
    OursController.prototype,
    "create",
    0,
  );
  Query(new StandardSchemaPipe(Page))(OursController.prototype, "list", 0);
  Body(new StandardSchemaPipe(YupUser))(OursController.prototype, "yup", 0);
  // A SchemaDto parameter, for the global StandardValidationPipe: the
  // metadata `emitDecoratorMetadata` would write for `body: YupUserDto`.
  Body()(OursController.prototype, "yupDto", 0);
  Reflect.defineMetadata(
    "design:paramtypes",
    [YupUserDto],
    OursController.prototype,
    "yupDto",
  );

  for (const controller of [Nest12Controller, OursController]) {
    const proto = controller.prototype;
    for (const [method, decorate] of [
      ["create", Post("users")],
      ["list", Get("users")],
      ["yup", Post("users-yup")],
      ["yupDto", Post("users-yup-dto")],
    ] as const) {
      decorate(proto, method, Object.getOwnPropertyDescriptor(proto, method)!);
    }
    Controller("n12")(controller);
  }

  class ExpressSide {}
  Module({ controllers: [Nest12Controller] })(ExpressSide);
  class BunSide {}
  Module({ controllers: [OursController] })(BunSide);
  return { express: ExpressSide, bun: BunSide };
}

/**
 * The Nest 12 pipe, global on the platform-express side; ours on the
 * bun-nest side, for its `SchemaDto` route (it passes the others through).
 */
const configureNest12: Configure = (app, side) => {
  app.useGlobalPipes(
    side === "express"
      ? new NestStandardSchemaValidationPipe!()
      : new StandardValidationPipe(),
  );
};

export const VALIDATION_GROUPS: ProbeGroup[] = [
  { name: "validation", module: ValidationModule, probes: PROBES },
  {
    name: "validation-no-filter",
    module: PipeOnlyModule,
    configure: configurePipeOnly,
    probes: PROBES,
  },
  {
    name: "validation-vs-nest12",
    ...(NestStandardSchemaValidationPipe === undefined
      ? {
          module: PipeOnlyModule,
          skip: "Nest 11 has no StandardSchemaValidationPipe",
        }
      : { module: nest12Modules(), configure: configureNest12 }),
    probes: [
      {
        name: "body, valid",
        path: "/n12/users",
        init: json({ name: "a", age: "3" }),
      },
      {
        name: "body, invalid",
        path: "/n12/users",
        init: json({ name: "", age: "x" }),
      },
      { name: "query, valid", path: "/n12/users?page=2" },
      { name: "query, invalid", path: "/n12/users?page=0" },
      {
        name: "yup body with a __proto__ key (StandardSchemaPipe)",
        path: "/n12/users-yup",
        init: json(PROTO_BODY),
      },
      {
        name: "yup body with a __proto__ key (SchemaDto + StandardValidationPipe)",
        path: "/n12/users-yup-dto",
        init: json(PROTO_BODY),
      },
    ],
  },
];

/** None: every field of every validation probe is platform-express's. */
export const VALIDATION_KNOWN: Record<string, KnownDifference> = {};
