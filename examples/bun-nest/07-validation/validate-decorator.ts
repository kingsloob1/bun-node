/**
 * BunValidate's `@Validate` decorator, the request side (V7a), asserted: one
 * decorator checking a route's request parts (`params`, `query`, `headers`,
 * `cookies`, `signedCookies`, `body`) with Standard Schemas before the
 * handler and before Nest's pipes, the parsed outputs written back in place
 * and recorded on the request's `valid` view, `@Validated(part)` and its six
 * aliases reading it, class- and method-level `@Validate` merging per part,
 * and the Nest 12 skip rule composing with `@Body({ schema })`.
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
 */
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import type { INestApplication, PipeTransform, Type } from "@nestjs/common";
import { signCookie } from "@kingsleyweb/bun-common";
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
} from "@kingsleyweb/bun-nest";
import * as nestCommon from "@nestjs/common";
import {
  Body,
  Controller,
  Headers,
  Module,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
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

@Module({ controllers: [BookingsController, OrdersController] })
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

for (const app of apps) {
  await app.close();
}

summary();
