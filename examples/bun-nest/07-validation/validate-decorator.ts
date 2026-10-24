/**
 * BunValidate's `@Validate` decorator, asserted: the request side (V7a) —
 * one decorator checking a route's request parts (`params`, `query`,
 * `headers`, `cookies`, `signedCookies`, `body`) with Standard Schemas
 * before the handler and before Nest's pipes, the parsed outputs written
 * back in place and recorded on the request's `valid` view, `@Validated(part)`
 * and its six aliases reading it, class- and method-level `@Validate` merging
 * per part, the Nest 12 skip rule composing with `@Body({ schema })` — and
 * the response side (V7b): `responses` and `responseValidation`, `reply()`,
 * a thrown non-2xx checked against its declared status, a plain `@Res()`
 * through the adapter's before-write hook, and `@Sse()` events checked per
 * event.
 *
 * ```bash
 * bun 07-validation/validate-decorator.ts
 * ```
 *
 * Worth knowing:
 *
 * - The handler sees the schemas' **outputs** two ways: Nest's own
 *   `@Param`/`@Query`/`@Body` read the parts written back in place (so
 *   `@Param("id")` is a `number`), and `@Validated("params")` /
 *   `@ValidParams()` and friends read the same parsed values off
 *   `req.valid`. `@Validated` is `undefined` on a route with no `@Validate`.
 * - **Headers are checked but never written back**: `@Headers("x-seats")`
 *   stays the raw string; the typed view is `req.valid.headers` alone, read
 *   with `@Validated("headers")` or `@ValidHeaders()`. (The live header store
 *   feeds `accepts`, `type-is` and the body parsers.)
 * - Signed cookies need a secret, given here as the adapter's request option
 *   `parseCookies: { secret }`; a cookie no secret verifies is `false` and
 *   fails its schema.
 * - A refused part throws a `StandardValidationException` (400) carrying
 *   every part's issues; `ValidationExceptionFilter` answers
 *   `{ error: "Validation failed", issues }`, each issue naming its `target`
 *   (the part) and `path`. A message found to quote a received value is
 *   withheld — shown here with a planted secret zod's own message quotes.
 * - A class-level and a method-level `@Validate` merge per part: a part both
 *   declare is the method's.
 * - On Nest 12 a part is **not checked twice**: when a whole-part
 *   `@Body({ schema })` covers it and Nest's own `StandardSchemaValidationPipe`
 *   applies (here, registered globally), `@Validate` leaves the part to
 *   Nest's pipe — the route's counted schema proves it never runs, while the
 *   decorator's schema runs exactly once. On Nest 11 (no such pipe)
 *   `@Validate` checks everything itself and those checks sit out on a line
 *   starting `skipped:`.
 * - With `responses` declared and `responseValidation: "error"` (the default
 *   is `"off"`), a response breaking its status's declaration is a
 *   `ResponseValidationError`, a 500: the server's fault, not the client's.
 *   The filter answers `{ error: "Response validation failed", issues }`,
 *   each issue with `target: "body"` (or `"status"`) and `key: "<status>"`,
 *   scrubbed the same way as a request issue.
 * - `reply<typeof responses>(status, body, { headers })` types the body from
 *   the status's declaration; the interceptor applies the status and headers
 *   and checks the body. A status the route never declared (smuggled past
 *   the types) is refused like any other mismatch.
 * - A thrown `HttpException` is checked against its own status's declaration:
 *   a declared 409 passes through unchanged; a 409 whose body breaks its
 *   schema becomes the 500.
 * - A plain `@Res()` route sends the response itself, after `map()` ran: the
 *   adapter's **before-write hook** checks the final status, headers and
 *   body, and a refusal is a fresh 500 — the response the handler wrote
 *   (status included) never reaches the client.
 * - An `@Sse()` route's events are checked one by one against a
 *   `sse({ ... })` declaration. A refused **first** event fails before the
 *   headers are committed, so the filters answer a 500; after the commit,
 *   Nest answers the refusal with its own `event: error` frame. The event
 *   itself never reaches the client either way.
 */
import type { BunResponse, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type {
  INestApplication,
  MessageEvent,
  PipeTransform,
  Type,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { signCookie, sse } from "@kingsleyweb/bun-common";
import {
  BunHttpAdapter,
  Validate,
  Validated,
  ValidBody,
  ValidCookies,
  ValidHeaders,
  ValidParams,
  ValidQuery,
  ValidSignedCookies,
  ValidationExceptionFilter,
  reply,
} from "@kingsleyweb/bun-nest";
import * as nestCommon from "@nestjs/common";
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Module,
  Param,
  Post,
  Query,
  Res,
  Sse,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { concatMap, from, of } from "rxjs";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { nestCommonVersion } from "../shared/nest";
import "reflect-metadata";

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */

/**
 * Nest 12's `StandardSchemaValidationPipe`, when the installed
 * `@nestjs/common` exports it, and with it `@Body({ schema })`. Nest 11 has
 * neither, so the skip-rule module is built only where the pipe exists.
 */
const NestSchemaPipe = (nestCommon as unknown as Record<string, unknown>)
  .StandardSchemaValidationPipe as (new () => PipeTransform) | undefined;

/** The installed `@nestjs/common`, printed on the `skipped:` line. */
const NEST_VERSION = await nestCommonVersion();

/* ------------------------------------------------------------------ */
/* Schemas                                                             */

/** A booking id from the path. */
const BookingId = z.object({ id: z.coerce.number().int().positive() });

/** A page number from the query string. */
const Page = z.object({ page: z.coerce.number().int().min(1) });

/** The API headers: `x-seats` arrives a string and leaves a number. */
const ApiHeaders = z.object({ "x-seats": z.coerce.number().int() });

/** The session cookies. */
const Session = z.object({ sid: z.string().min(1) });

/** The signed cookies: `uid` verified, then coerced. */
const SignedUser = z.object({ uid: z.coerce.number().int().min(1) });

/**
 * A new booking, strict so a client's own key names are refused — and never
 * quoted back (see the secret planted below).
 */
const Booking = z
  .object({
    name: z.string().min(1),
    seats: z.coerce.number().int().min(1),
  })
  .strict();

/** A key no answer may ever quote, planted as an unknown key of the body. */
const SECRET = "member-email-ada@example.com";

/** The cookie secret the adapter verifies signed cookies with. */
const COOKIE_SECRET = "cookie-secret-for-the-example";

/** A signed `uid` cookie, as `res.cookie(name, value, { signed: true })` signs it. */
const signedUid = (value: string): string =>
  encodeURIComponent(`s:${signCookie(value, COOKIE_SECRET)}`);

/* ------------------------------------------------------------------ */
/* The application                                                     */

@Controller("bookings")
class BookingsController {
  /**
   * Declared before `:id` so `/bookings/echo` is its own route: no
   * `@Validate`, so `@Validated` reads nothing.
   */
  @Post("echo")
  echo(@Validated("body") body: unknown) {
    return { body: body ?? null };
  }

  /** Every request part under one `@Validate`. */
  @Validate({
    params: BookingId,
    query: Page,
    headers: ApiHeaders,
    cookies: Session,
    signedCookies: SignedUser,
    body: Booking,
  })
  @Post(":id")
  create(
    @Param("id") id: unknown,
    @Query("page") page: unknown,
    @Headers("x-seats") rawSeats: unknown,
    @Body() body: unknown,
    @ValidParams() validParams: unknown,
    @ValidQuery() validQuery: unknown,
    @ValidHeaders() validHeaders: unknown,
    @ValidCookies() validCookies: unknown,
    @ValidSignedCookies() validSigned: unknown,
    @ValidBody() validBody: unknown,
  ) {
    return {
      id,
      idType: typeof id,
      page,
      pageType: typeof page,
      // Headers are never written back: the raw value stays a string.
      rawSeats,
      rawSeatsType: typeof rawSeats,
      body,
      valid: {
        params: validParams,
        query: validQuery,
        headers: validHeaders,
        cookies: validCookies,
        signedCookies: validSigned,
        body: validBody,
      },
    };
  }
}

/** A class-level `@Validate`, merged per part with each method's own. */
@Controller("orders")
@Validate({ query: Page })
class OrdersController {
  /** The class's query schema plus the method's body schema. */
  @Validate({ body: Booking })
  @Post()
  create(@ValidQuery() query: unknown, @ValidBody() body: unknown) {
    return { query, body };
  }

  /** The method's query schema replaces the class's, per part. */
  @Validate({ query: z.object({ tag: z.string() }) })
  @Post("tagged")
  tagged(@ValidQuery() query: unknown) {
    return query;
  }
}

/* ------------------------------------------------------------------ */
/* The response side (V7b)                                             */

/** A booking confirmation, as the routes answer it (strict: nothing more). */
const Confirmation = z
  .object({
    reference: z.string().min(1),
    seats: z.number().int().min(1),
  })
  .strict();

/** A conflict's explanation. */
const Problem = z.object({ reason: z.string() });

/** V13's shape: `reference`, a defaulted `channel`; zod strips an unknown key. */
const Packed = z.object({
  reference: z.string().min(1),
  channel: z.string().default("email"),
});

/**
 * The confirmations' response contract, per status: a bare schema is a JSON
 * body, the full form names the media type. Reused by every route of the
 * controller, and the type argument of `reply()`.
 */
const responses = {
  200: Confirmation,
  201: { content: { "application/json": Confirmation } },
  206: Confirmation,
  409: Problem,
} as const;

@Controller("confirmations")
class ConfirmationsController {
  /** A returned body matching its status's declaration passes. */
  @Validate({ responses, responseValidation: "error" })
  @Post()
  create() {
    return { reference: "BK-1", seats: 3 };
  }

  /** The same, with a key the declaration refuses (and never quotes). */
  @Validate({ responses, responseValidation: "error" })
  @Post("broken")
  broken() {
    return { reference: "BK-1", seats: 3, [SECRET]: 1 };
  }

  /** `reply()`: the status and headers applied, the body typed and checked. */
  @Validate({ responses, responseValidation: "error" })
  @Post("reply")
  replied() {
    return reply<typeof responses>(
      201,
      { reference: "BK-2", seats: 2 },
      { headers: { "x-answered": "reply" } },
    );
  }

  /** A status the route never declared, smuggled past `reply()`'s types. */
  @Validate({ responses, responseValidation: "error" })
  @Post("reply-undeclared")
  replyUndeclared() {
    const undeclared = 202 as number as 201;
    return reply<typeof responses>(undeclared, { reference: "BK-3", seats: 1 });
  }

  /** A thrown 409 whose body matches the 409 declaration passes through. */
  @Validate({ responses, responseValidation: "error" })
  @Post("conflict")
  conflict(): never {
    throw new HttpException({ reason: "title taken" }, 409);
  }

  /** `responseOutput: "parsed"` (V13): the wire gets the schema's output. */
  @Validate({
    responses: { 201: { content: { "application/json": Packed } } },
    responseValidation: "error",
    responseOutput: "parsed",
  })
  @Post("parsed")
  parsed() {
    return { reference: "BK-4", channel: "email", [SECRET]: 1 };
  }

  /** A thrown 409 whose body breaks the 409 declaration becomes a 500. */
  @Validate({ responses, responseValidation: "error" })
  @Post("conflict-broken")
  conflictBroken(): never {
    throw new HttpException({ reason: 42 }, 409);
  }

  /** A plain `@Res()`: the before-write hook checks the response as written. */
  @Validate({ responses, responseValidation: "error" })
  @Get("manual")
  manual(@Res() res: BunResponse) {
    res.status(206).json({ reference: "BK-4", seats: 1 });
  }

  /** The same, refused: the 200 and its body never reach the client. */
  @Validate({ responses, responseValidation: "error" })
  @Get("manual-broken")
  manualBroken(@Res() res: BunResponse) {
    res.status(200).json({ reference: "BK-4", seats: "many" });
  }
}

/** One `tick` event's data. */
const Tick = z.object({ n: z.number().int() }).strict();

/** The events' response contract: a 200 event stream of `tick` events. */
const sseResponses = {
  200: { content: { "text/event-stream": sse({ tick: Tick }) } },
} as const;

@Controller("ticks")
class TicksController {
  /** One valid `tick` event. */
  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse()
  ticks(): Observable<MessageEvent> {
    return of({ type: "tick", data: { n: 1 } });
  }

  /** A bad first event: refused before the headers are committed (a 500). */
  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("first-broken")
  firstBroken(): Observable<MessageEvent> {
    return of({ type: "tick", data: { n: 2, [SECRET]: 1 } });
  }

  /**
   * A valid event, then one the declaration refuses, a beat apart as a live
   * stream's events arrive: the refusal lands after the commit, so Nest
   * answers it with its own `event: error` frame.
   */
  @Validate({ responses: sseResponses, responseValidation: "error" })
  @Sse("broken")
  broken(): Observable<MessageEvent> {
    return from([
      { type: "tick", data: { n: 1 } },
      { type: "tick", data: { n: 2, [SECRET]: 1 } },
    ]).pipe(
      concatMap(async (event) => {
        await Bun.sleep(1);
        return event;
      }),
    );
  }
}

@Module({
  controllers: [
    BookingsController,
    OrdersController,
    ConfirmationsController,
    TicksController,
  ],
})
class AppModule {}

/* ------------------------------------------------------------------ */
/* The skip rule (Nest 12 only)                                        */

/** What {@link CountedEcho} wraps: the body, unchanged. */
const Echo = z.object({ name: z.string() });

/** How many times the route's own `@Validate` body schema ran. */
let validateRuns = 0;

/** The route's `@Validate` body schema, its runs counted. */
const CountedEcho: StandardSchemaV1 = {
  "~standard": {
    version: 1,
    vendor: "example-counted",
    validate: (value) => {
      validateRuns++;
      return Echo["~standard"].validate(value);
    },
  },
};

/** How many times the `@Body({ schema })` schema's transform ran. */
let nestRuns = 0;

/** The schema Nest's own pipe applies: upper-cases `name`, its runs counted. */
const NestName = z.object({
  name: z.string().transform((name) => {
    nestRuns++;
    return name.toUpperCase();
  }),
});

/**
 * A route whose body both `@Validate` and `@Body({ schema })` declare. Built
 * only where Nest's own schema pipe exists (see {@link NestSchemaPipe}).
 */
function nest12Controller(): Type {
  /** `@Body()` as Nest 12 declares it, taking `{ schema }`. */
  const BodyWithSchema = Body as unknown as (options: {
    /** The schema Nest's pipe validates the body with. */
    schema: StandardSchemaV1;
  }) => ParameterDecorator;

  @Controller("nest12")
  class Nest12Controller {
    @Validate({ body: CountedEcho })
    @Post("echo")
    echo(@BodyWithSchema({ schema: NestName }) body: unknown) {
      return body;
    }
  }

  return Nest12Controller;
}

@Module({ controllers: [nest12Controller()] })
class Nest12Module {}

/* ------------------------------------------------------------------ */
/* Boot                                                                */

/** A Nest response as the example reads it. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body. */
  body: unknown;
}

/** Request options for a JSON `POST`. */
function post(body: unknown, headers?: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** Reads a response's status and JSON body. */
async function answer(response: Response): Promise<Answer> {
  return { status: response.status, body: await response.json() };
}

/** Every app booted, closed at the end. */
const apps: INestApplication[] = [];

/**
 * Boots `module` on port 0 with cookie parsing (and its secret) on; `setup`
 * runs before `listen`. Answers the base URL.
 */
async function boot(
  module: Type,
  setup?: (app: INestApplication) => void,
): Promise<string> {
  const app = await NestFactory.create(
    module,
    new BunHttpAdapter(0, {
      request: { parseCookies: { secret: COOKIE_SECRET } },
    }),
    { logger: false },
  );
  setup?.(app);
  await app.listen(0);
  apps.push(app);
  const url = await app.getUrl();
  return url.replace("[::1]", "127.0.0.1");
}

title("@Validate and @Validated: the request side");

const url = await boot(AppModule, (app) => {
  app.useGlobalFilters(new ValidationExceptionFilter());
});
show("listening on", url);

/** Calls the served app at `base`. */
function calling(base: string) {
  return async (path: string, init?: RequestInit): Promise<Answer> =>
    answer(await fetch(`${base}${path}`, init));
}
const call = calling(url);

/* ------------------------------------------------------------------ */
step(
  "Every part coerced: write-back for Nest's decorators, req.valid for ours",
);

const created = await call(
  "/bookings/5?page=2",
  post(
    { name: "Ada", seats: "3" },
    { "x-seats": "7", cookie: `sid=abc123; uid=${signedUid("5")}` },
  ),
);
show("POST /bookings/5?page=2, every part a string on the wire", created);
checkEqual("each part coerced, the raw header excepted", created, {
  status: 201,
  body: {
    id: 5,
    idType: "number",
    page: 2,
    pageType: "number",
    rawSeats: "7",
    rawSeatsType: "string",
    body: { name: "Ada", seats: 3 },
    valid: {
      params: { id: 5 },
      query: { page: 2 },
      headers: { "x-seats": 7 },
      cookies: { sid: "abc123" },
      signedCookies: { uid: 5 },
      body: { name: "Ada", seats: 3 },
    },
  },
});

/* ------------------------------------------------------------------ */
step("A refused request: 400, { error, issues }, and no received value quoted");

const raw = (await Booking["~standard"].validate({
  name: "Ada",
  seats: "3",
  [SECRET]: 1,
})) as StandardSchemaV1.FailureResult;
check(
  "zod's own message quotes the planted key (what the answer withholds)",
  raw.issues.some((issue) => issue.message.includes(SECRET)),
  raw.issues,
);

const refused = await call(
  "/bookings/5?page=0",
  post(
    { name: "Ada", seats: "3", [SECRET]: 1 },
    { "x-seats": "7", cookie: `sid=abc123; uid=${signedUid("5")}` },
  ),
);
show("POST /bookings/5?page=0, a bad page and a planted key", refused);
checkEqual("the filter's 400: each issue names its part and path", refused, {
  status: 400,
  body: {
    error: "Validation failed",
    issues: [
      {
        target: "query",
        message: "Too small: expected number to be >=1",
        path: "page",
      },
      {
        target: "body",
        message: "Invalid value (unrecognized_keys)",
        path: "",
      },
    ],
  },
});
check(
  "the answer never quotes the planted secret",
  !JSON.stringify(refused.body).includes(SECRET),
  refused.body,
);

/* ------------------------------------------------------------------ */
step("@Validated on a route with no @Validate is undefined");

checkEqual(
  "POST /bookings/echo: nothing validated the body",
  await call("/bookings/echo", post({ anything: "goes" })),
  { status: 201, body: { body: null } },
);

/* ------------------------------------------------------------------ */
step("Class-level and method-level @Validate merge per part");

checkEqual(
  "the class's query schema plus the method's body schema",
  await call("/orders?page=3", post({ name: "Ada", seats: "2" })),
  {
    status: 201,
    body: { query: { page: 3 }, body: { name: "Ada", seats: 2 } },
  },
);
checkEqual(
  "a part both declare is the method's: no page is fine, a tag is",
  await call("/orders/tagged?tag=sale", post({})),
  { status: 201, body: { tag: "sale" } },
);

/* ------------------------------------------------------------------ */
step("Nest 12's @Body({ schema }): the part is checked once, by Nest's pipe");

/** How many checks the Nest 12 step holds, for the skip line. */
const NEST12_CHECKS = 5;

if (NestSchemaPipe === undefined) {
  show(
    `skipped: Nest 11 has no StandardSchemaValidationPipe, so @Validate checks every part itself; ${NEST12_CHECKS} checks skipped on @nestjs/common ${NEST_VERSION}`,
  );
} else {
  const pipeUrl = await boot(Nest12Module, (app) => {
    app.useGlobalFilters(new ValidationExceptionFilter());
    app.useGlobalPipes(new NestSchemaPipe());
  });
  const bareUrl = await boot(Nest12Module);
  show("listening on", `${pipeUrl} (the pipe global), ${bareUrl} (no pipes)`);

  validateRuns = 0;
  nestRuns = 0;
  const skipped = await calling(pipeUrl)("/nest12/echo", post({ name: "ada" }));
  show("POST /nest12/echo, the pipe global", skipped);
  checkEqual("the handler gets Nest's pipe's output, upper-cased", skipped, {
    status: 201,
    body: { name: "ADA" },
  });
  checkEqual(
    "@Validate's own schema never ran: the part was left to Nest's pipe",
    validateRuns,
    0,
  );
  checkEqual(
    "the decorator's schema ran exactly once: one validation, not two",
    nestRuns,
    1,
  );

  validateRuns = 0;
  nestRuns = 0;
  const control = await calling(bareUrl)("/nest12/echo", post({ name: "ada" }));
  show("the same route with no pipes (the control)", control);
  checkEqual(
    "with no pipe to check the part, @Validate checks it (the body stays raw)",
    control,
    { status: 201, body: { name: "ada" } },
  );
  checkEqual(
    "@Validate's schema ran once, and the decorator's schema not at all",
    [validateRuns, nestRuns],
    [1, 0],
  );
}

/* ------------------------------------------------------------------ */
step("@Validate responses: a declared body passes, a broken one is a 500");

checkEqual(
  "a returned body matching its status's declaration passes",
  await call("/confirmations", post({})),
  { status: 201, body: { reference: "BK-1", seats: 3 } },
);

const rawOut = (await Confirmation["~standard"].validate({
  reference: "BK-1",
  seats: 3,
  [SECRET]: 1,
})) as StandardSchemaV1.FailureResult;
check(
  "zod's own message quotes the planted key (what the answer withholds)",
  rawOut.issues.some((issue) => issue.message.includes(SECRET)),
  rawOut.issues,
);

const refusedOut = await call("/confirmations/broken", post({}));
show("a body breaking the 201 declaration", refusedOut);
checkEqual("a ResponseValidationError: 500, { error, issues }", refusedOut, {
  status: 500,
  body: {
    error: "Response validation failed",
    issues: [
      {
        target: "body",
        message: "Invalid value (unrecognized_keys)",
        path: "",
        key: "201",
        mediaType: "application/json",
      },
    ],
  },
});
check(
  "the answer never quotes the planted secret",
  !JSON.stringify(refusedOut.body).includes(SECRET),
  refusedOut.body,
);

/* ------------------------------------------------------------------ */
step(
  "reply(): the status applied, the body checked, an undeclared status refused",
);

const repliedResponse = await fetch(`${url}/confirmations/reply`, post({}));
const replied = {
  status: repliedResponse.status,
  answered: repliedResponse.headers.get("x-answered"),
  body: await repliedResponse.json(),
};
show("reply(201, …, { headers })", replied);
checkEqual("the status and header applied, the checked body sent", replied, {
  status: 201,
  answered: "reply",
  body: { reference: "BK-2", seats: 2 },
});

const undeclaredOut = await call("/confirmations/reply-undeclared", post({}));
show("reply() answering a status the route never declared", undeclaredOut);
checkEqual(
  "an undeclared status is refused like any other mismatch",
  undeclaredOut,
  {
    status: 500,
    body: {
      error: "Response validation failed",
      issues: [
        {
          target: "status",
          message: "This status is not declared (200, 201, 206, 409)",
          path: "",
          key: "202",
        },
      ],
    },
  },
);

/* ------------------------------------------------------------------ */
step('responseOutput: "parsed" (V13): the wire gets the schema\'s output');

const parsedOut = await call("/confirmations/parsed", post({}));
show(
  "the handler wrote a key the schema strips, and not the default",
  parsedOut,
);
checkEqual(
  '"parsed": the output on the wire — the unknown key stripped, the default applied',
  parsedOut,
  { status: 201, body: { reference: "BK-4", channel: "email" } },
);
check(
  "the planted secret is in neither the answer nor the parse",
  !JSON.stringify(parsedOut.body).includes(SECRET),
  parsedOut.body,
);

/* ------------------------------------------------------------------ */
step(
  "A thrown HttpException: a declared 409 passes through, a broken one is a 500",
);

checkEqual(
  "a declared 409 passes through unchanged",
  await call("/confirmations/conflict", post({})),
  { status: 409, body: { reason: "title taken" } },
);
const conflictBroken = await call("/confirmations/conflict-broken", post({}));
show("a 409 whose body breaks the 409 declaration", conflictBroken);
checkEqual("refused with a fresh 500", conflictBroken, {
  status: 500,
  body: {
    error: "Response validation failed",
    issues: [
      {
        target: "body",
        message: "Invalid input: expected string, received number",
        path: "reason",
        key: "409",
        mediaType: "application/json",
      },
    ],
  },
});

/* ------------------------------------------------------------------ */
step("A plain @Res() route: the before-write hook checks the final response");

checkEqual(
  "res.status(206).json(valid) passes as written",
  await call("/confirmations/manual"),
  { status: 206, body: { reference: "BK-4", seats: 1 } },
);
const manualBroken = await call("/confirmations/manual-broken");
show("res.status(200).json(bad)", manualBroken);
checkEqual(
  "refused with a fresh 500: the 200 never reaches the client",
  manualBroken,
  {
    status: 500,
    body: {
      error: "Response validation failed",
      issues: [
        {
          target: "body",
          message: "Invalid input: expected number, received string",
          path: "seats",
          key: "200",
          mediaType: "application/json",
        },
      ],
    },
  },
);

/* ------------------------------------------------------------------ */
step("@Sse(): each event checked against the sse() declaration");

/** Reads a whole event stream (the route's observable completes). */
async function streamText(
  path: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${url}${path}`);
  return { status: response.status, body: await response.text() };
}

const ticks = await streamText("/ticks");
show("GET /ticks", ticks);
checkEqual("a valid event reaches the client", ticks, {
  status: 200,
  body: '\nevent: tick\nid: 1\ndata: {"n":1}\n\n',
});

const firstBroken = await call("/ticks/first-broken");
show(
  "a bad first event, refused before the headers are committed",
  firstBroken,
);
checkEqual("a 500 through the filters, the event never sent", firstBroken, {
  status: 500,
  body: {
    error: "Response validation failed",
    issues: [
      {
        target: "body",
        message: "Invalid value (unrecognized_keys)",
        path: "tick.data",
        key: "200",
        mediaType: "text/event-stream",
      },
    ],
  },
});
check(
  "the 500 never quotes the planted secret",
  !JSON.stringify(firstBroken.body).includes(SECRET),
  firstBroken.body,
);

const ticksBroken = await streamText("/ticks/broken");
show("a bad event after the commit", ticksBroken);
checkEqual("the valid event passed", ticksBroken.status, 200);
check(
  "the refused one became Nest's event: error frame (its data is Nest's own — 'Internal server error' on 12.2, the scrubbed refusal message before it — never the value)",
  ticksBroken.body.includes('event: tick\nid: 1\ndata: {"n":1}') &&
    ticksBroken.body.includes("event: error") &&
    !ticksBroken.body.includes(SECRET),
  ticksBroken,
);
check(
  "the refused event itself never reached the client",
  !ticksBroken.body.includes(SECRET) && !ticksBroken.body.includes('"n":2'),
  ticksBroken,
);

for (const app of apps) {
  await app.close();
}

summary();
