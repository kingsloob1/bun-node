/**
 * A body the adapter could not decode, in a Nest app: refused before any
 * guard by default, or routed to a controller that opted in, so its guard
 * runs before anything is said about the body.
 *
 * ```bash
 * bun 02-http-adapter/undecodable-bodies.ts
 * ```
 *
 * Worth knowing:
 *
 * - By default the adapter refuses a body it could not decode (here, JSON
 *   that does not parse) before routing: Nest's exception layer answers its
 *   own `400`, and no guard or controller runs.
 * - `new BunHttpAdapter(0, { router: { acceptUndecodableBody: true } })` opts
 *   every controller in. The request is routed with `req.body` unset and the
 *   refusal on `req.bodyDecodingError`, which a controller reads through
 *   `@Req()`; guards run first, so a caller they refuse gets `403`.
 * - A bun-common `BunRouter` built with `acceptUndecodableBody: true` and
 *   mounted with `adapter.use()` opts in only its own routes: a controller
 *   beside it keeps the early refusal.
 * - A body over its cap is still a `413` before any guard, whatever the
 *   setting.
 * - Which route decides when several could, and the per-route
 *   `acceptUndecodableBody()` marker for a bun-common route:
 *   `examples/bun-common/04-request/undecodable-bodies.ts`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { BunRouter } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

title("Undecodable bodies in a Nest app");

/** Calls of the guard and the controller. */
const calls = { guard: 0, handler: 0 };

/** Allows a request carrying `x-allow: 1`; Nest answers 403 otherwise. */
@Injectable()
class AllowHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    calls.guard++;
    const req = context.switchToHttp().getRequest<BunRequest>();
    return req.getHeader("x-allow") === "1";
  }
}

@Controller("queues")
@UseGuards(AllowHeaderGuard)
class QueuesController {
  /** Answers its own 400, naming the refusal, for a body that did not decode. */
  @Post("pause")
  @HttpCode(200)
  pause(@Req() req: BunRequest, @Body() body: unknown) {
    calls.handler++;
    const refused = req.bodyDecodingError as
      | (Error & { status: number; type?: string })
      | undefined;
    if (refused) {
      throw new BadRequestException({
        code: "INVALID_JSON",
        status: refused.status,
        type: refused.type,
        body: body ?? "unset",
      });
    }
    return { paused: true, body };
  }
}

@Module({ controllers: [QueuesController], providers: [AllowHeaderGuard] })
class AppModule {}

/** A JSON POST: `{` (does not parse) unless `body` is given; `allow` sets `x-allow`. */
function post(allow: boolean, body = "{"): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(allow ? { "x-allow": "1" } : {}),
    },
    body,
  };
}

/** `[status, JSON body]` of a response. */
async function json(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

/** Every app made here, closed at the end. */
const apps: INestApplication[] = [];

/** A served Nest app over `adapter`. */
async function serve(adapter: BunHttpAdapter): Promise<void> {
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  apps.push(app);
  await app.listen(0);
}

/**
 * Nest's answer to the adapter's early refusal, its parser message left out:
 * `"Nest's 400"`, or the status and body when the answer is anything else
 * (the route's own `code`, say).
 */
async function nestRefusal(response: Response): Promise<unknown> {
  const body = (await response.json()) as Record<string, unknown>;
  const { message, ...rest } = body;
  return response.status === 400 &&
    typeof message === "string" &&
    Bun.deepEquals(rest, { error: "Bad Request", statusCode: 400 })
    ? "Nest's 400"
    : [response.status, body];
}

/* ------------------------------------------------------------------ */
step("By default: refused before the guard, with Nest's 400");

const plain = new BunHttpAdapter();
await serve(plain);
const plainBefore = { ...calls };
checkEqual(
  "allowed or not, the bad JSON is Nest's 400 and the guard never runs",
  [
    await nestRefusal(await plain.fetch("/queues/pause", post(true))),
    await nestRefusal(await plain.fetch("/queues/pause", post(false))),
    calls,
  ],
  ["Nest's 400", "Nest's 400", plainBefore],
);

/* ------------------------------------------------------------------ */
step(
  "router: { acceptUndecodableBody: true }: the guard first, then the controller",
);

const optedIn = new BunHttpAdapter(0, {
  router: { acceptUndecodableBody: true },
});
await serve(optedIn);

/** The controller's own 400, built from `req.bodyDecodingError`. */
const controllerRefusal = {
  code: "INVALID_JSON",
  status: 400,
  type: "entity.parse.failed",
  body: "unset",
};
const optedBefore = { ...calls };
checkEqual(
  "allowed: the controller reads req.bodyDecodingError through @Req() and answers its own 400, served and through fetch()",
  [
    await json(await fetch(`${optedIn.url}/queues/pause`, post(true))),
    await json(await optedIn.fetch("/queues/pause", post(true))),
  ],
  [
    [400, controllerRefusal],
    [400, controllerRefusal],
  ],
);
const deniedStatus = (await optedIn.fetch("/queues/pause", post(false))).status;
checkEqual(
  "denied: the guard's 403; over the three requests the guard ran 3 times, the controller only for the 2 allowed",
  [
    deniedStatus,
    calls.guard - optedBefore.guard,
    calls.handler - optedBefore.handler,
  ],
  [403, 3, 2],
);
checkEqual(
  "a body that decodes is unaffected",
  await json(await optedIn.fetch("/queues/pause", post(true, '{"a":1}'))),
  [200, { paused: true, body: { a: 1 } }],
);

/* ------------------------------------------------------------------ */
step("A bun-common router mounted with the option: only its routes opt in");

/** Calls of the mounted router's authorize middleware. */
let authorized = 0;
const api = new BunRouter({ acceptUndecodableBody: true });
api.use((req, res, next) => {
  authorized++;
  if (req.getHeader("x-allow") !== "1") {
    res.status(403).json({ code: "FORBIDDEN" });
    return;
  }
  next();
});
api.post("/q/pause", (req, res) => {
  res
    .status(400)
    .json({ code: "INVALID_JSON", status: req.bodyDecodingError?.status });
});
const mounted = new BunHttpAdapter();
mounted.use("/api", api);
await serve(mounted);
const mountedBefore = { ...calls };
checkEqual(
  "the mounted router authorizes, then answers its own 400; the controller beside it is refused with Nest's 400",
  [
    await json(await mounted.fetch("/api/q/pause", post(true))),
    await json(await mounted.fetch("/api/q/pause", post(false))),
    authorized,
    await nestRefusal(await mounted.fetch("/queues/pause", post(true))),
    calls,
  ],
  [
    [400, { code: "INVALID_JSON", status: 400 }],
    [403, { code: "FORBIDDEN" }],
    2,
    "Nest's 400",
    mountedBefore,
  ],
);

/* ------------------------------------------------------------------ */
step("A body over its cap: 413 before the guard, whatever the setting");

const capped = new BunHttpAdapter(0, {
  router: { acceptUndecodableBody: true },
  request: { parseBody: { maxContentLength: 16 } },
});
await serve(capped);
const cappedBefore = { ...calls };
checkEqual(
  "opted in, a 64-byte body over a 16-byte cap: 413, the guard never ran",
  [
    (await capped.fetch("/queues/pause", post(true, `{${"x".repeat(64)}`)))
      .status,
    calls,
  ],
  [413, cappedBefore],
);

await Promise.all(apps.map((app) => app.close()));
summary();
