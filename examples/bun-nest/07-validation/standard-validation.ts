/**
 * BunValidate's Nest pipes and filter, asserted: `StandardSchemaPipe` on a
 * parameter, a `SchemaDto` body under the global `StandardValidationPipe`,
 * `ValidationExceptionFilter`'s answers over HTTP and over a gateway, and
 * `StandardValidationModule`, which registers the pipe and the filter.
 *
 * ```bash
 * bun 07-validation/standard-validation.ts
 * ```
 *
 * Worth knowing:
 *
 * - The handler receives the schema's **output**: `z.coerce.number()` hands
 *   it a `number`, `z.coerce.date()` a `Date`. A `SchemaDto` parameter is a
 *   plain value, not an instance of its class.
 * - `SchemaDto` is found through Nest's `design:paramtypes`, so the app needs
 *   `emitDecoratorMetadata`, which Bun reads from the **working directory's**
 *   `tsconfig.json` (oven-sh/bun#28605): run this from `examples/bun-nest`.
 * - A refused value is a `StandardValidationException`, a
 *   `BadRequestException`. With no filter, Nest answers its own 400 body,
 *   one `message` line per issue; the issues themselves, `{ target, message,
 *   path }`, are on the exception's `.issues`, for a filter of the app's own.
 * - `ValidationExceptionFilter` answers `{ error, issues }` over HTTP and, in
 *   a gateway, emits an `exception` event carrying `{ status, code:
 *   "VALIDATION", issues }`. It is `@Catch`-scoped to BunValidate's errors:
 *   every other error, Nest's own pipes' included, keeps Nest's answer.
 * - Nest applies global filters to HTTP only, so a gateway takes the filter
 *   with `@UseFilters`. Global pipes reach a gateway on Nest 12 only, so a
 *   gateway takes `@UsePipes(StandardValidationPipe)`, which works on both;
 *   on Nest 12 the schema then runs twice, the second time on its own
 *   output. So there a schema must accept what it outputs: one that changes
 *   a type (a string transformed to a `Date`) refuses every message, and
 *   belongs in a `StandardSchemaPipe`, which the global pipe passes by.
 * - `StandardValidationModule.forRoot({ messages: "generic" })` words the
 *   global pipe's issues; a `StandardSchemaPipe` keeps its own options, and
 *   a wrong option is a `TypeError` when the module is built.
 * - On Nest 12, its own `@Body({ schema })` and `StandardSchemaValidationPipe`
 *   work beside these, independently. On Nest 11 those checks sit out on a
 *   line starting `skipped:`; the rest runs on both.
 */
import type { BunResponse, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type {
  ArgumentsHost,
  ExceptionFilter,
  PipeTransform,
  Type,
} from "@nestjs/common";
import type { WirePacket, WsClient } from "../04-websockets/fixtures/ws-client";
import {
  BunHttpAdapter,
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationException,
  StandardValidationModule,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "@kingsleyweb/bun-nest";
import * as nestCommon from "@nestjs/common";
import {
  Body,
  Catch,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  UseFilters,
  UsePipes,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { SocketModule } from "@nestjs/websockets/socket-module.js";
import { z } from "zod";
import { connect, eventName } from "../04-websockets/fixtures/ws-client";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { nestCommonVersion } from "../shared/nest";
import "reflect-metadata";

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */

/**
 * Nest 12's `StandardSchemaValidationPipe`, when the installed
 * `@nestjs/common` exports it, and with it `@Body({ schema })`. Nest 11 has
 * neither: its `@Body({ schema })` is accepted and the schema never read,
 * the body reaching the handler unchecked, so the controller using it is
 * built only where the pipe exists.
 */
const NestSchemaPipe = (nestCommon as unknown as Record<string, unknown>)
  .StandardSchemaValidationPipe as (new () => PipeTransform) | undefined;

/**
 * Whether Nest applies global pipes to gateways: Nest 12's
 * `SocketModule.getContextCreator(container, config, …)` hands the
 * application's config (its global pipes) to the gateway's pipes; Nest 11's
 * takes the container alone.
 */
const GLOBAL_PIPES_REACH_GATEWAYS =
  (
    SocketModule.prototype as unknown as {
      getContextCreator: (...args: unknown[]) => unknown;
    }
  ).getContextCreator.length >= 2;

/** The installed `@nestjs/common`, printed on the `skipped:` line. */
const NEST_VERSION = await nestCommonVersion();

/* ------------------------------------------------------------------ */
/* Schemas                                                             */

/** A new event, as clients send it: `seats` and `startsAt` arrive as strings. */
const NewEvent = z.object({
  title: z.string().min(1),
  seats: z.coerce.number().int().min(1),
  startsAt: z.coerce.date(),
});

/** A parameter typed from the schema: `seats` a `number`, `startsAt` a `Date`. */
class NewEventDto extends SchemaDto(NewEvent) {}

/** A page number from the query string. */
const Page = z.coerce.number().int().min(1);

/** An event id from the path. */
const EventId = z.coerce.number().int().positive();

/** How many times the chat schema ran, to see where a gateway's pipes run. */
let chatRuns = 0;

/** A chat message, its runs counted by a refinement that always passes. */
const Chat = z
  .object({ room: z.string().min(1), text: z.string().max(140) })
  .refine(() => {
    chatRuns++;
    return true;
  });

/** A chat message under the global pipe or `@UsePipes(StandardValidationPipe)`. */
class ChatDto extends SchemaDto(Chat) {}

/**
 * A reminder: `at` arrives a string and leaves a `Date`, which the schema
 * refuses as input.
 */
const Reminder = z.object({ at: z.string().transform((at) => new Date(at)) });

/** A reminder under `@UsePipes(StandardValidationPipe)`. */
class ReminderDto extends SchemaDto(Reminder) {}

/** What a handler reports about the value it received. */
interface Received {
  /** The event's title. */
  title: string;
  /** `typeof seats`: `"number"` once the schema coerced it. */
  seats: string;
  /** Whether `startsAt` is a `Date`. */
  startsAtIsDate: boolean;
  /** Whether the value is an instance of the DTO class (it never is). */
  isDtoInstance: boolean;
}

/** Describes a received event for the response. */
function received(body: StandardSchemaV1.InferOutput<typeof NewEvent>) {
  return {
    title: body.title,
    seats: typeof body.seats,
    startsAtIsDate: body.startsAt instanceof Date,
    isDtoInstance: body instanceof NewEventDto,
  } satisfies Received;
}

/* ------------------------------------------------------------------ */
/* The application                                                     */

@Controller("events")
class EventsController {
  /** A `SchemaDto` body, checked by the global `StandardValidationPipe`. */
  @Post()
  create(@Body() body: NewEventDto) {
    return received(body);
  }

  /** One query parameter through `StandardSchemaPipe`. */
  @Get()
  list(@Query("page", new StandardSchemaPipe(Page)) page: number) {
    return { page, type: typeof page };
  }

  /** One path parameter through `StandardSchemaPipe`. */
  @Get(":id")
  one(@Param("id", new StandardSchemaPipe(EventId)) id: number) {
    return { id, type: typeof id };
  }
}

/**
 * Nest 12's own per-parameter schema, `@Body({ schema })` read by its
 * `StandardSchemaValidationPipe`, beside ours in the same application. Built
 * only where that pipe exists (see {@link NestSchemaPipe}).
 */
function nest12Controller(NestPipe: new () => PipeTransform): Type {
  /** `@Body()` as Nest 12 declares it, taking `{ schema }`. */
  const BodyWithSchema = Body as unknown as (options: {
    /** The schema Nest's pipe validates the body with. */
    schema: StandardSchemaV1;
  }) => ParameterDecorator;

  @Controller("nest12")
  @UsePipes(new NestPipe())
  class Nest12EventsController {
    @Post("events")
    create(
      @BodyWithSchema({ schema: NewEvent })
      body: StandardSchemaV1.InferOutput<typeof NewEvent>,
    ) {
      return received(body);
    }
  }

  return Nest12EventsController;
}

/** A gateway: the filter by `@UseFilters`, since no global filter reaches it. */
@WebSocketGateway({ path: "/live" })
@UseFilters(ValidationExceptionFilter)
class LiveGateway {
  /** `StandardSchemaPipe` on the message body. */
  @SubscribeMessage("piped")
  piped(
    @MessageBody(new StandardSchemaPipe(Chat))
    msg: StandardSchemaV1.InferOutput<typeof Chat>,
  ) {
    return { event: "piped", data: msg };
  }

  /** A `SchemaDto` message under `@UsePipes(StandardValidationPipe)`: both majors. */
  @SubscribeMessage("scoped")
  @UsePipes(StandardValidationPipe)
  scoped(@MessageBody() msg: ChatDto) {
    return { event: "scoped", data: msg };
  }

  /** A `SchemaDto` message left to the global pipe: Nest 12 only. */
  @SubscribeMessage("global")
  global(@MessageBody() msg: ChatDto) {
    return { event: "global", data: msg };
  }

  /** A type-changing `SchemaDto` under `@UsePipes`: run twice on Nest 12. */
  @SubscribeMessage("remind")
  @UsePipes(StandardValidationPipe)
  remind(@MessageBody() msg: ReminderDto) {
    return { event: "remind", data: { isDate: msg.at instanceof Date } };
  }

  /** The same schema through `StandardSchemaPipe`: run once on both majors. */
  @SubscribeMessage("remind-piped")
  remindPiped(
    @MessageBody(new StandardSchemaPipe(Reminder))
    msg: StandardSchemaV1.InferOutput<typeof Reminder>,
  ) {
    return { event: "remind-piped", data: { isDate: msg.at instanceof Date } };
  }
}

/** The same message handler with no filter: Nest's own answer. */
@WebSocketGateway({ path: "/bare" })
class BareGateway {
  /** `StandardSchemaPipe` on the message body, no filter. */
  @SubscribeMessage("piped")
  piped(
    @MessageBody(new StandardSchemaPipe(Chat))
    msg: StandardSchemaV1.InferOutput<typeof Chat>,
  ) {
    return { event: "piped", data: msg };
  }
}

@Module({
  imports: [StandardValidationModule],
  controllers: [
    EventsController,
    ...(NestSchemaPipe === undefined ? [] : [nest12Controller(NestSchemaPipe)]),
  ],
  providers: [LiveGateway, BareGateway],
})
class AppModule {}

/** A Nest response as the example reads it. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body. */
  body: unknown;
}

/** Request options for a JSON `POST`. */
function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Reads a response's status and JSON body. */
async function answer(response: Response): Promise<Answer> {
  return { status: response.status, body: await response.json() };
}

title("StandardSchemaPipe, SchemaDto and ValidationExceptionFilter");

const httpAdapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, httpAdapter, {
  logger: false,
});
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(0);
const url = await app.getUrl();
show("listening on", url);

/** Calls the served app. */
async function call(path: string, init?: RequestInit): Promise<Answer> {
  return answer(await fetch(`${url}${path}`, init));
}

/* ------------------------------------------------------------------ */
step("A SchemaDto body: the handler receives the schema's output");

const created = await call(
  "/events",
  post({ title: "Bun meetup", seats: "40", startsAt: "2026-11-05T18:00:00Z" }),
);
show("POST /events", created);
checkEqual("seats coerced to a number, startsAt to a Date", created, {
  status: 201,
  body: {
    title: "Bun meetup",
    seats: "number",
    startsAtIsDate: true,
    isDtoInstance: false,
  },
});

/* ------------------------------------------------------------------ */
step("StandardSchemaPipe on a query and a path parameter");

checkEqual(
  "GET /events?page=2: the page as a number",
  await call("/events?page=2"),
  {
    status: 200,
    body: { page: 2, type: "number" },
  },
);
checkEqual("GET /events/7: the id as a number", await call("/events/7"), {
  status: 200,
  body: { id: 7, type: "number" },
});

/* ------------------------------------------------------------------ */
step("ValidationExceptionFilter over HTTP: { error, issues }");

const refusedBody = await call(
  "/events",
  post({ title: "", seats: "many", startsAt: "2026-11-05" }),
);
show("POST /events, two fields wrong", refusedBody);
checkEqual("a refused SchemaDto body", refusedBody, {
  status: 400,
  body: {
    error: "Validation failed",
    issues: [
      {
        target: "body",
        message: "Too small: expected string to have >=1 characters",
        path: "title",
      },
      {
        target: "body",
        message: "Invalid input: expected number, received NaN",
        path: "seats",
      },
    ],
  },
});

const refusedPage = await call("/events?page=0");
show("GET /events?page=0", refusedPage);
checkEqual(
  "the query issue names its part and the parameter's key",
  refusedPage,
  {
    status: 400,
    body: {
      error: "Validation failed",
      issues: [
        {
          target: "query",
          message: "Too small: expected number to be >=1",
          path: "page",
        },
      ],
    },
  },
);

const refusedId = await call("/events/abc");
checkEqual(
  "a path parameter's issue: target params, path id",
  (refusedId.body as { issues: unknown[] }).issues,
  [
    {
      target: "params",
      message: "Invalid input: expected number, received NaN",
      path: "id",
    },
  ],
);

const badJson = await call("/events", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"title":',
});
show("invalid JSON", badJson);
check(
  "an error the filter is not scoped to keeps Nest's answer (invalid JSON)",
  badJson.status === 400 &&
    (badJson.body as { statusCode?: number }).statusCode === 400 &&
    !("issues" in (badJson.body as object)),
  badJson,
);

/* ------------------------------------------------------------------ */
step("Nest 12's own @Body({ schema }) beside ours");

/** How many checks the Nest 12 step holds, for the skip line. */
const NEST12_CHECKS = 2;

if (NestSchemaPipe === undefined) {
  show(
    `skipped: Nest 11 has no StandardSchemaValidationPipe or @Body({ schema }); ${NEST12_CHECKS} checks skipped on @nestjs/common ${NEST_VERSION}`,
  );
} else {
  checkEqual(
    "@Body({ schema }) hands the handler the schema's output too",
    await call(
      "/nest12/events",
      post({ title: "Bun meetup", seats: "40", startsAt: "2026-11-05" }),
    ),
    {
      status: 201,
      body: {
        title: "Bun meetup",
        seats: "number",
        startsAtIsDate: true,
        isDtoInstance: false,
      },
    },
  );
  const nestRefused = await call(
    "/nest12/events",
    post({ title: "", seats: "40", startsAt: "2026-11-05" }),
  );
  show("Nest 12's pipe refusing", nestRefused);
  checkEqual(
    "Nest's pipe throws a plain BadRequestException: Nest's body, not the filter's",
    nestRefused,
    {
      status: 400,
      body: {
        statusCode: 400,
        message: ["title: Too small: expected string to have >=1 characters"],
        error: "Bad Request",
      },
    },
  );
}

/* ------------------------------------------------------------------ */
step("In a gateway: { status, code: 'VALIDATION', issues }");

const base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
const live = await connect(`${base}/live`);
const bare = await connect(`${base}/bare`);

/**
 * Emits `event` and resolves with the `data` of the first frame after it
 * that answers it or is an `exception`.
 */
async function reply(
  client: WsClient,
  event: string,
  data: unknown,
): Promise<unknown> {
  const before = client.frames.length;
  const answers = (packet: WirePacket | string): packet is WirePacket => {
    return (
      typeof packet !== "string" &&
      (eventName(packet) === event || eventName(packet) === "exception")
    );
  };
  client.emit(event, data);
  await waitFor(`a reply to ${event}`, () => {
    return client.frames.slice(before).some(answers);
  });
  return client.frames.slice(before).find(answers)!.data;
}

checkEqual(
  "StandardSchemaPipe hands the handler the parsed message",
  await reply(live, "piped", { room: "lobby", text: "hi" }),
  ["piped", { room: "lobby", text: "hi" }],
);

const wsRefused = await reply(live, "piped", { room: "", text: 1 });
show("a refused message", wsRefused);
checkEqual("the filter's exception event", wsRefused, [
  "exception",
  {
    status: 400,
    code: "VALIDATION",
    issues: [
      {
        target: "body",
        message: "Too small: expected string to have >=1 characters",
        path: "room",
      },
      {
        target: "body",
        message: "Invalid input: expected string, received number",
        path: "text",
      },
    ],
  },
]);

const bareRefused = await reply(bare, "piped", { room: "", text: "x" });
show("the same message, no filter", bareRefused);
checkEqual(
  "without the filter, Nest's 'Internal server error' frame",
  (bareRefused as [string, { message?: string }])[1].message,
  "Internal server error",
);

/* ------------------------------------------------------------------ */
step("SchemaDto in a gateway: @UsePipes(StandardValidationPipe)");

chatRuns = 0;
checkEqual(
  "@UsePipes(StandardValidationPipe) checks a SchemaDto message",
  ((await reply(live, "scoped", { room: "lobby" })) as [string])[0],
  "exception",
);
chatRuns = 0;
checkEqual(
  "a valid one reaches the handler",
  await reply(live, "scoped", { room: "lobby", text: "hi" }),
  ["scoped", { room: "lobby", text: "hi" }],
);
show("the schema ran, for one valid message", chatRuns);
checkEqual(
  GLOBAL_PIPES_REACH_GATEWAYS
    ? "Nest 12: twice, the global pipe's run and @UsePipes' (on its output)"
    : "Nest 11: once, @UsePipes' alone",
  chatRuns,
  GLOBAL_PIPES_REACH_GATEWAYS ? 2 : 1,
);

const globalOnly = (await reply(live, "global", { room: "lobby" })) as [string];
show("a SchemaDto message left to the global pipe", globalOnly);
checkEqual(
  GLOBAL_PIPES_REACH_GATEWAYS
    ? "Nest 12: the global pipe reaches the gateway and refuses it"
    : "Nest 11: no global pipe reaches the gateway, so it passes unchecked",
  globalOnly[0],
  GLOBAL_PIPES_REACH_GATEWAYS ? "exception" : "global",
);

const reminder = { at: "2026-11-05T09:00:00Z" };
const remind = await reply(live, "remind", reminder);
show("a valid reminder, schema output a Date, under @UsePipes", remind);
checkEqual(
  GLOBAL_PIPES_REACH_GATEWAYS
    ? "Nest 12: the second run refuses the first's Date"
    : "Nest 11: one run, the handler gets a Date",
  remind,
  GLOBAL_PIPES_REACH_GATEWAYS
    ? [
        "exception",
        {
          status: 400,
          code: "VALIDATION",
          issues: [
            {
              target: "body",
              message: "Invalid input: expected string, received Date",
              path: "at",
            },
          ],
        },
      ]
    : ["remind", { isDate: true }],
);
checkEqual(
  "through StandardSchemaPipe instead, one run on both: the handler gets a Date",
  await reply(live, "remind-piped", reminder),
  ["remind-piped", { isDate: true }],
);

await live.close();
await bare.close();
await app.close();

/* ------------------------------------------------------------------ */
step("No filter: Nest's 400 body, and .issues for a filter of the app's own");

/** Answers a pipe's refusal with 422 and where each issue is. */
@Catch(StandardValidationException)
class WhereFilter implements ExceptionFilter<StandardValidationException> {
  catch(error: StandardValidationException, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<BunResponse>()
      .status(422)
      .json({
        where: error.issues.map((issue) => `${issue.target}.${issue.path}`),
      });
  }
}

@Controller("plain")
class PlainController {
  /** `StandardSchemaPipe` with no filter anywhere. */
  @Get()
  page(@Query("page", new StandardSchemaPipe(Page)) page: number) {
    return { page };
  }

  /** The same, under a filter of the app's own reading `.issues`. */
  @Get("own-filter")
  @UseFilters(WhereFilter)
  ownFilter(@Query("page", new StandardSchemaPipe(Page)) page: number) {
    return { page };
  }
}

@Module({ controllers: [PlainController] })
class PlainModule {}

const plainAdapter = new BunHttpAdapter();
const plain = await NestFactory.create(PlainModule, plainAdapter, {
  logger: false,
});
await plain.init();

checkEqual(
  "Nest's own 400 body: one message line per issue",
  await answer(await plainAdapter.fetch("/plain?page=0")),
  {
    status: 400,
    body: {
      statusCode: 400,
      message: ["page: Too small: expected number to be >=1"],
      error: "Bad Request",
    },
  },
);
checkEqual(
  "@Catch(StandardValidationException) reads .issues",
  await answer(await plainAdapter.fetch("/plain/own-filter?page=x")),
  { status: 422, body: { where: ["query.page"] } },
);
await plain.close();

/* ------------------------------------------------------------------ */
step("StandardValidationModule.forRoot(): the global pipe's options");

@Module({
  imports: [StandardValidationModule.forRoot({ messages: "generic" })],
  controllers: [EventsController],
})
class GenericModule {}

const genericAdapter = new BunHttpAdapter();
const generic = await NestFactory.create(GenericModule, genericAdapter, {
  logger: false,
});
await generic.init();

const genericBody = await answer(
  await genericAdapter.fetch("/events", post({ title: "", seats: "40" })),
);
show('forRoot({ messages: "generic" }), a refused SchemaDto body', genericBody);
checkEqual(
  "the global pipe's issues are worded generically",
  (genericBody.body as { issues: { message: string }[] }).issues.map(
    (issue) => issue.message,
  ),
  ["Invalid value (too_small)", "Invalid value (invalid_type)"],
);
checkEqual(
  "a StandardSchemaPipe keeps its own options (none: zod's message)",
  await answer(await genericAdapter.fetch("/events?page=0")),
  {
    status: 400,
    body: {
      error: "Validation failed",
      issues: [
        {
          target: "query",
          message: "Too small: expected number to be >=1",
          path: "page",
        },
      ],
    },
  },
);
await generic.close();

await checkRejects(
  'forRoot({ messages: "quiet" }) throws when the module is built',
  () => StandardValidationModule.forRoot({ messages: "quiet" as "generic" }),
  { name: "TypeError", message: /messages must be "generic" or unset/ },
);

summary();
