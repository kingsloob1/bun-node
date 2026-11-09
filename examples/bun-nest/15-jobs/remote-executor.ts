/**
 * A remote executor on a Nest application, asserted: `BunRemoteExecutorModule`
 * and `@RemoteHandler`, called with signed requests through the adapter's
 * `fetch()`, so no port is bound.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/remote-executor.ts
 * ```
 *
 * A remote executor is an HTTP endpoint a bun-jobs worker elsewhere calls to
 * run jobs here. `BunRemoteExecutorModule.forRoot({ path, secret })` mounts it
 * on the adapter at `path`, with `path/healthz` and `path/readyz` under it, and
 * collects the handlers from every provider's `@RemoteHandler(name)` methods.
 * Handlers run through the same pipeline as `@Process`, under the context type
 * `"bun-jobs"`. (§12.2 of the plan has no row for it; this is the one example.)
 *
 * The request is a JSON envelope, and **the signature covers the exact bytes
 * sent**: the example signs the body with `signEnvelope` as a caller would. It
 * checks:
 *
 * - A signed invoke runs the handler, through DI (`Greeter`) and parameter
 *   decorators (`@JobData`, `@JobId`, `@JobSignal`), and the outcome is
 *   `completed` with its result.
 * - **The signature is the authentication, and it fails closed.** The same
 *   envelope unsigned, or signed with the wrong secret, is a 401, and the
 *   handler does not run (counted).
 * - A guard's denial ends the job as `failed-fatal` (a retry asks the same
 *   guard the same question), and so does a pipe that refuses the data, where
 *   a thrown error is plain `failed`, which is retried.
 * - A name nobody handles is the executor's `handler-not-found`.
 * - The health routes answer, and an ordinary controller on the same adapter
 *   is untouched.
 *
 * The route is mounted below Nest's router, so global prefixes and controller
 * guards do not apply to it: `@UseGuards` applies to each handler.
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { RemoteContext, RemoteJob } from "@kingsleyweb/bun-jobs/remote";
import { signEnvelope } from "@kingsleyweb/bun-jobs/remote";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import {
  BunRemoteExecutorModule,
  JobData,
  JobId,
  JobSignal,
  RemoteHandler,
} from "@kingsleyweb/bun-nest/jobs";
import {
  Controller,
  Injectable,
  Module,
  Post,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import "reflect-metadata";

/** The executor's secret: at least 32 bytes. */
const SECRET = "example-secret-0123456789abcdefghij";

/** A provider a handler depends on. */
@Injectable()
class Greeter {
  greet(name: string) {
    return `hello ${name}`;
  }
}

/** How many times each handler's body ran, so a refusal is provably not a run. */
const ran: string[] = [];

@Injectable()
class Handlers {
  constructor(private readonly greeter: Greeter) {}

  /** Called as `(job, ctx)`, with the executor's own types. */
  @RemoteHandler("plain")
  plain(job: RemoteJob<{ name: string }>, ctx: RemoteContext) {
    ran.push("plain");
    return {
      greeting: this.greeter.greet(job.data.name),
      attempt: ctx.attempt,
    };
  }

  /** Reads the job with the same parameter decorators `@Process` takes. */
  @RemoteHandler("decorated")
  decorated(
    @JobData("name") name: string,
    @JobId() id: string,
    @JobSignal() signal: AbortSignal,
  ) {
    ran.push("decorated");
    return { name, id, aborted: signal.aborted };
  }

  /** A guard says no: the body must not run. */
  @RemoteHandler("denied")
  @UseGuards({ canActivate: () => false })
  denied() {
    ran.push("denied");
  }

  /** A pipe refuses the data: the body must not run. */
  @RemoteHandler("validated")
  validated(@JobData({ schema: z.object({ to: z.string() }) }) data: unknown) {
    ran.push("validated");
    return data;
  }

  /** A plain error: retried, so `failed` rather than `failed-fatal`. */
  @RemoteHandler("boom")
  boom(): never {
    ran.push("boom");
    throw new Error("boom");
  }
}

/** A controller of the application's own, beside the executor. */
@Controller("other")
class Other {
  @Post()
  run() {
    return { other: true };
  }
}

@Module({
  imports: [
    BunRemoteExecutorModule.forRoot({ path: "/executor", secret: SECRET }),
  ],
  providers: [Greeter, Handlers],
  controllers: [Other],
})
class AppModule {}

/** One job of an invoke. */
function job(id: string, name: string, data: unknown = null) {
  return {
    id,
    name,
    data,
    attempt: 1,
    idempotencyKey: `ns:q:${id}:1`,
    fence: `token-${id}:1000`,
    delivery: 1,
  };
}

/** The outcome of one job as the executor answers it. */
interface Outcome {
  /** `"result"` or `"fail"`. */
  op: string;
  /** `"completed"`, `"failed"`, `"failed-fatal"` or `"handler-not-found"`. */
  status: string;
  /** The handler's result, when completed. */
  result?: unknown;
}

let counter = 0;

/** Posts one job as a caller would, signed unless told otherwise. */
async function invoke(
  adapter: BunHttpAdapter,
  sent: ReturnType<typeof job>,
  { signed = true, secret = SECRET } = {},
) {
  counter += 1;
  const now = Date.now();
  const envelope = {
    v: 1,
    op: "invoke",
    id: `inv_${counter}`,
    now,
    deadlineAt: now + 30_000,
    namespace: "ns",
    queue: "q",
    worker: { id: "worker-1", key: "svc.q" },
    jobs: [sent],
  };
  const body = JSON.stringify(envelope);
  const response = await adapter.fetch("/executor", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "bun-jobs-protocol": "1",
      "bun-jobs-id": envelope.id,
      ...(signed
        ? {
            "bun-jobs-signature": await signEnvelope(body, {
              direction: "request",
              secret,
            }),
          }
        : {}),
    },
  });
  const text = await response.text();
  const parsed = text.startsWith("{")
    ? (JSON.parse(text) as { outcomes?: Outcome[] })
    : null;
  return { status: response.status, outcome: parsed?.outcomes?.[0] };
}

title("BunRemoteExecutorModule and @RemoteHandler");

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, {
  logger: false,
  abortOnError: false,
});
await app.init();

try {
  step("A signed invoke runs the handler");

  const plain = await invoke(adapter, job("job_1", "plain", { name: "ada" }));
  checkEqual("status", plain.status, 200);
  check(
    "completed, with the handler's result through DI",
    plain.outcome?.status === "completed" &&
      Bun.deepEquals(plain.outcome.result, {
        greeting: "hello ada",
        attempt: 1,
      }),
    plain.outcome,
  );

  const decorated = await invoke(
    adapter,
    job("job_2", "decorated", { name: "grace" }),
  );
  checkEqual(
    "parameter decorators read the remote job",
    decorated.outcome?.result,
    {
      name: "grace",
      id: "job_2",
      aborted: false,
    },
  );

  step("The signature is the authentication");

  const before = ran.length;
  const unsigned = await invoke(adapter, job("job_3", "plain", { name: "x" }), {
    signed: false,
  });
  const wrongKey = await invoke(adapter, job("job_4", "plain", { name: "x" }), {
    secret: "wrong-secret-0123456789abcdefghi",
  });
  checkEqual("unsigned: 401", unsigned.status, 401);
  checkEqual("signed with the wrong secret: 401", wrongKey.status, 401);
  checkEqual("and neither ran the handler", ran.length, before);

  step("How a job ends");

  const denied = await invoke(adapter, job("job_5", "denied"));
  checkEqual(
    "a guard's denial is fatal, and the body did not run",
    [denied.outcome?.status, ran.includes("denied")],
    ["failed-fatal", false],
  );
  const invalid = await invoke(adapter, job("job_6", "validated", { to: 42 }));
  checkEqual(
    "a pipe refusing the data is fatal too",
    [invalid.outcome?.status, ran.includes("validated")],
    ["failed-fatal", false],
  );
  const valid = await invoke(adapter, job("job_7", "validated", { to: "ada" }));
  checkEqual(
    "and the same pipe passes good data",
    valid.outcome?.status,
    "completed",
  );
  const boom = await invoke(adapter, job("job_8", "boom"));
  checkEqual(
    "a thrown error is `failed`, to be retried",
    boom.outcome?.status,
    "failed",
  );
  const nobody = await invoke(adapter, job("job_9", "nope"));
  checkEqual(
    "a name nobody handles",
    nobody.outcome?.status,
    "handler-not-found",
  );

  step("Beside the rest of the application");

  show("healthz", (await adapter.fetch("/executor/healthz")).status);
  checkEqual("healthz", (await adapter.fetch("/executor/healthz")).status, 200);
  checkEqual("readyz", (await adapter.fetch("/executor/readyz")).status, 200);
  const other = await adapter.fetch("/other", { method: "POST" });
  checkEqual(
    "an ordinary controller is untouched",
    [other.status, await other.json()],
    [201, { other: true }],
  );
} finally {
  await app.close();
}

summary();
