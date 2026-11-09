/**
 * Nest guards in front of the jobs management API, asserted:
 * `BunJobsApiModule` over `BunJobsModule`'s own context (no `jobs` passed),
 * `guardsAuthorize` with a role guard, and `jobsApiContextOf` telling the
 * guard what is being decided.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/api-guards.ts
 * ```
 *
 * The API's routes are a router mounted on the adapter, so Nest guards do not
 * run for them on their own. `guardsAuthorize(moduleRef, guards, { policy })`
 * builds the API's `authorize` from your guards, which then cover every HTTP
 * request, the socket's upgrade and each of its channels. (`06-jobs-ui/mount.ts`
 * is the same value serving the UI.) What is checked, over the adapter's
 * `fetch()` (no port) and, for the socket, a real client on port 0:
 *
 * - **The module takes the context.** `BunJobsApiModule.forRootAsync` is given
 *   no `jobs`: the API lists the queue `BunJobsModule`'s context holds.
 * - **A role guard, per role.** The guard reads the role a `Reflector`
 *   decorator puts on a `Policy` method (`read` for what changes nothing,
 *   `mutate` for what does): a reader gets 200 on a list and 403 on a pause, an
 *   admin 200 on both, a stranger 403, and no role at all 401 with the guard's
 *   own message. The problem's `code` is the API's `FORBIDDEN` or
 *   `UNAUTHORIZED`. A denied pause is checked by what it **stopped**: the
 *   queue is not paused.
 * - **`jobsApiContextOf`** says what is being decided, so a guard can go
 *   past roles: here a rule only an admin may touch the `payroll` queue.
 * - **It fails closed.** A guard that throws an ordinary error denies with a
 *   403 whose body holds none of the error's text.
 * - **The negative control**: a guard that always allows lets the stranger
 *   through. The checks above can fail.
 * - **The socket.** A stranger and an anonymous caller are refused at the
 *   upgrade, and a reader's subscription to `queue/payroll` comes back in the
 *   ack's `rejected` while `queue/emails` is allowed.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { BunRequest } from "@kingsleyweb/bun-common";
import { noopLogger } from "@kingsleyweb/bun-common";
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BunJobsApiModule,
  BunJobsModule,
  getBunJobsToken,
  guardsAuthorize,
  jobsApiContextOf,
} from "@kingsleyweb/bun-nest/jobs";
import {
  Inject,
  Injectable,
  Module,
  UnauthorizedException,
} from "@nestjs/common";
import { ModuleRef, NestFactory, Reflector } from "@nestjs/core";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { check, checkEqual, summary } from "../shared/check";
import { step, title } from "../shared/console";
import "reflect-metadata";

/** Where the API is mounted. */
const BASE = "/admin/jobs";

/** The roles a policy method allows. */
const Roles = Reflector.createDecorator<string[]>();

/** Stands in for the API's routes: `read` for what changes nothing, `mutate` for what does. */
class Policy {
  @Roles(["reader", "admin"])
  read() {}

  @Roles(["admin"])
  mutate() {}
}

/** Reads the caller's role from a header, and decides by the route and the queue. */
@Injectable()
class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const role = context
      .switchToHttp()
      .getRequest<BunRequest>()
      .getHeader("x-role");
    if (role === null) {
      throw new UnauthorizedException("Sign in first");
    }
    // What is being decided: the action, the queue, the transport.
    if (jobsApiContextOf(context)?.queue === "payroll" && role !== "admin") {
      return false;
    }
    return (this.reflector.get(Roles, context.getHandler()) ?? []).includes(
      role,
    );
  }
}

/** An application with the API on `BunJobsModule`'s context, guarded as told. */
async function boot(
  guards: (moduleRef: ModuleRef) => Parameters<typeof guardsAuthorize>[1],
  providers: (new (...args: never[]) => unknown)[] = [RolesGuard],
) {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: `examples-nest-api-guards-${crypto.randomUUID().slice(0, 8)}`,
        driver: { type: "memory" },
        publishEvents: true,
        logger: false,
      }),
      // No `jobs`: it takes `BunJobsModule`'s context.
      BunJobsApiModule.forRootAsync({
        inject: [ModuleRef],
        useFactory: (moduleRef: ModuleRef) => ({
          basePath: BASE,
          authorize: guardsAuthorize(moduleRef, guards(moduleRef), {
            policy: Policy,
            // A guard's own failure is logged here, never sent to the caller.
            logger: noopLogger,
          }),
        }),
      }),
    ],
    providers,
  })
  class AppModule {}

  const adapter = new BunHttpAdapter();
  const app = (await NestFactory.create(AppModule, adapter, {
    logger: false,
    abortOnError: false,
  })) as INestApplication;
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  // The module mounts the API in `onModuleInit`, so init first: `fetch()` needs it.
  await app.init();
  const jobs = app.get<BunJobs>(getBunJobsToken(), { strict: false });
  const emails = jobs.queue("emails");
  await emails.add("welcome", {});
  await jobs.queue("payroll").add("run", {});
  return { app, adapter, emails };
}

/** One request through the adapter's real pipeline, no port. */
async function call(
  { adapter }: Awaited<ReturnType<typeof boot>>,
  method: "GET" | "POST",
  path: string,
  role?: string,
) {
  const response = await adapter.fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(role === undefined ? {} : { "x-role": role }),
    },
    ...(method === "GET" ? {} : { body: "{}" }),
  });
  const text = await response.text();
  const body = (text.startsWith("{") ? JSON.parse(text) : {}) as {
    code?: string;
    detail?: string;
  };
  return { status: response.status, body, text };
}

/** The few fields of a socket frame this example reads. */
interface Frame {
  /** `"hello"`, `"ack"`, `"event"`, ... */
  type: string;
  /** The channels an `ack` accepted. */
  channels: string[];
  /** The channels an `ack` refused, with the problem's code. */
  rejected?: { channel: string; code: string }[];
}

title("guardsAuthorize in front of BunJobsApiModule");

/* ------------------------------------------------------------------ */
step("A role guard: 200, 403 and 401 per role");

{
  const booted = await boot(() => [RolesGuard]);
  try {
    const list = await call(booted, "GET", "/queues", "reader");
    checkEqual("a reader lists queues", list.status, 200);
    check(
      "and the API sees BunJobsModule's queue, though no `jobs` was given",
      list.text.includes('"emails"'),
      list.text.slice(0, 200),
    );
    checkEqual(
      "an admin lists queues",
      (await call(booted, "GET", "/queues", "admin")).status,
      200,
    );

    const stranger = await call(booted, "GET", "/queues", "stranger");
    checkEqual(
      "a stranger: 403, FORBIDDEN",
      [stranger.status, stranger.body.code],
      [403, "FORBIDDEN"],
    );
    const anonymous = await call(booted, "GET", "/queues");
    checkEqual(
      "no role at all: 401, UNAUTHORIZED, with the guard's message",
      [anonymous.status, anonymous.body.code, anonymous.body.detail],
      [401, "UNAUTHORIZED", "Sign in first"],
    );

    const readerPause = await call(
      booted,
      "POST",
      "/queues/emails/pause",
      "reader",
    );
    checkEqual("a reader may not pause: 403", readerPause.status, 403);
    checkEqual(
      "and what it tried to do did not happen",
      await booted.emails.isPaused(),
      false,
    );
    const adminPause = await call(
      booted,
      "POST",
      "/queues/emails/pause",
      "admin",
    );
    checkEqual("an admin pauses", adminPause.status, 200);
    checkEqual("and it is paused", await booted.emails.isPaused(), true);

    step("jobsApiContextOf: what is being decided, beyond the role");

    const reader = await call(booted, "GET", "/queues/payroll", "reader");
    checkEqual(
      "a reader may list queues but not open the payroll queue",
      reader.status,
      403,
    );
    const admin = await call(booted, "GET", "/queues/payroll", "admin");
    checkEqual("the admin may", admin.status, 200);
  } finally {
    await booted.app.close();
  }
}

/* ------------------------------------------------------------------ */
step("It fails closed; and a guard that allows everyone is the control");

{
  const throwing = await boot(() => [
    {
      canActivate() {
        throw new Error("secret: the auth service is down");
      },
    },
  ]);
  try {
    const answer = await call(throwing, "GET", "/queues", "admin");
    checkEqual(
      "a guard that throws an ordinary error denies: 403",
      answer.status,
      403,
    );
    check(
      "and nothing of its message reaches the caller",
      !answer.text.includes("secret"),
      answer.text,
    );
  } finally {
    await throwing.app.close();
  }

  const allowAll = await boot(() => [{ canActivate: () => true }]);
  try {
    const answer = await call(allowAll, "GET", "/queues", "stranger");
    checkEqual(
      "control: a guard that always allows lets the stranger through",
      answer.status,
      200,
    );
  } finally {
    await allowAll.app.close();
  }
}

/* ------------------------------------------------------------------ */
step("The socket: the upgrade, then each channel");

{
  const booted = await boot(() => [RolesGuard]);
  try {
    await booted.app.listen(0);
    const url = `ws://127.0.0.1:${booted.adapter.listeningPort}${BASE}/ws`;

    /** Opens the socket as `role`; resolves the socket, or `"refused"`. */
    const open = (role?: string) =>
      new Promise<WebSocket | "refused">((resolve) => {
        const socket = new WebSocket(url, {
          headers: role === undefined ? {} : { "x-role": role },
        });
        socket.addEventListener("error", () => resolve("refused"));
        socket.addEventListener("message", (event) => {
          if ((JSON.parse(String(event.data)) as Frame).type === "hello") {
            resolve(socket);
          }
        });
      });

    checkEqual("a stranger cannot connect", await open("stranger"), "refused");
    checkEqual("nor an anonymous caller", await open(), "refused");

    const reader = await open("reader");
    if (reader === "refused") throw new Error("the reader could not connect");
    const ack = await new Promise<Frame>((resolve) => {
      reader.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === "ack") resolve(frame);
      });
      reader.send(
        JSON.stringify({
          op: "subscribe",
          id: "one",
          channels: ["queue/emails", "queue/payroll"],
        }),
      );
    });
    reader.close();
    checkEqual("a reader gets the channel the guard allows", ack.channels, [
      "queue/emails",
    ]);
    checkEqual(
      "and the payroll channel comes back rejected",
      ack.rejected?.map((entry) => [entry.channel, entry.code]),
      [["queue/payroll", "FORBIDDEN"]],
    );
  } finally {
    await booted.app.close();
  }
}

summary();
