/**
 * `@RemoteHandler` and `BunRemoteExecutorModule` (nest-jobs-decorators PR-n7): a remote executor on
 * a real Nest application, signed requests going through `BunHttpAdapter` without a socket. The
 * signature covers the exact bytes sent, and the adapter reads the body first, so the first thing
 * these prove is that the bytes survive it, on each of the adapter's body modes.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type { LoggerService, Type } from "@nestjs/common";
import type { RemoteContext, RemoteJob } from "@kingsleyweb/bun-jobs/remote";
import { ConfigError } from "@kingsleyweb/bun-common";
import { signEnvelope } from "@kingsleyweb/bun-jobs/remote";
import {
  Controller,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
  Scope,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory, REQUEST } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunRemoteExecutorModule,
  JobAttempt,
  JobData,
  JobId,
  JobLogger,
  JobLoggingInterceptor,
  JobName,
  JobProgress,
  JobSignal,
  RemoteHandler,
} from "../lib/jobs/index";
import "reflect-metadata";

/** The executor's secret: at least 32 bytes. */
const SECRET = "test-secret-0123456789abcdefghij";

/** Applications to close after each test. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

let counter = 0;

/** One job of an invoke. */
function job(name: string, data: unknown = null) {
  counter += 1;
  const id = `job_${counter}`;
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

/** An invoke envelope. */
function invoke(jobs: ReturnType<typeof job>[]) {
  counter += 1;
  const now = Date.now();
  return {
    v: 1,
    op: "invoke",
    id: `inv_${counter}`,
    now,
    deadlineAt: now + 30_000,
    namespace: "ns",
    queue: "q",
    worker: { id: "worker-1", key: "svc.q" },
    jobs,
  };
}

/** A module class with the given metadata. */
function moduleOf(metadata: Parameters<typeof Module>[0]): Type<unknown> {
  class AppModule {}
  Module(metadata)(AppModule);
  return AppModule;
}

/** Boots an app on the adapter, closed afterwards. */
async function bootHttp(
  module: Type<unknown>,
  adapter = new BunHttpAdapter(30000),
  options: { bodyParser?: boolean } = {},
) {
  const app = await NestFactory.create(module, adapter, {
    logger: false,
    abortOnError: false,
    ...options,
  });
  cleanups.push(() => app.close());
  await app.init();
  return { app, adapter };
}

/** Posts an envelope, signed unless told otherwise, and reads the answer. */
async function post(
  adapter: BunHttpAdapter,
  envelope: unknown,
  { signed = true, secret = SECRET, path = "/executor" } = {},
) {
  const body = JSON.stringify(envelope);
  const response = await adapter.fetch(path, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "bun-jobs-protocol": "1",
      "bun-jobs-id": (envelope as { id: string }).id,
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
  return {
    status: response.status,
    // A refusal's body is a problem document, or empty.
    body: (text === "" || !text.startsWith("{") ? null : JSON.parse(text)) as {
      outcomes?: {
        op: string;
        status: string;
        result?: unknown;
        error?: { message?: string; code?: string };
      }[];
      code?: string;
    } | null,
  };
}

/** A provider with a handler. */
@Injectable()
class Greeter {
  greet(name: unknown) {
    return `hello ${String(name)}`;
  }
}

@Injectable()
class Handlers {
  constructor(@Inject(Greeter) readonly greeter: Greeter) {}

  @RemoteHandler("plain")
  plain(job: RemoteJob<{ name: string }>, ctx: RemoteContext) {
    return {
      greeting: this.greeter.greet(job.data.name),
      attempt: ctx.attempt,
      signal: ctx.signal instanceof AbortSignal,
    };
  }

  @RemoteHandler("decorated")
  async decorated(
    @JobData("name") name: string,
    @JobId() id: string,
    @JobName() jobName: string,
    @JobAttempt() attempt: number,
    @JobSignal() signal: AbortSignal,
    @JobProgress() progress: (value: number) => Promise<void>,
    @JobLogger() logger: { info: (line: string) => void },
  ) {
    await progress(50);
    logger.info("logged");
    return { name, id, jobName, attempt, aborted: signal.aborted };
  }

  @RemoteHandler("validated")
  validated(@JobData({ schema: z.object({ to: z.string() }) }) data: unknown) {
    return data;
  }

  @RemoteHandler("logged")
  @UseInterceptors(JobLoggingInterceptor)
  logged() {
    return "logged";
  }

  @RemoteHandler("boom")
  boom() {
    throw new Error("boom");
  }
}

/** The module's imports and providers for the handlers above. */
const appMetadata = {
  imports: [
    BunRemoteExecutorModule.forRoot({ path: "/executor", secret: SECRET }),
  ],
  providers: [Greeter, Handlers],
};

describe("a signed request through the module", () => {
  for (const [mode, make, options] of [
    ["the adapter's defaults", () => new BunHttpAdapter(30000), {}],
    [
      "deferBody",
      () => new BunHttpAdapter(30000, { request: { deferBody: true } }),
      {},
    ],
    [
      "parseBody: false",
      () => new BunHttpAdapter(30000, { request: { parseBody: false } }),
      {},
    ],
    [
      "bodyParser: false",
      () => new BunHttpAdapter(30000),
      { bodyParser: false },
    ],
  ] as const) {
    it(`verifies and runs, on ${mode}`, async () => {
      const { adapter } = await bootHttp(
        moduleOf(appMetadata),
        make(),
        options,
      );
      const answer = await post(
        adapter,
        invoke([job("plain", { name: "ada" })]),
      );
      expect(answer.status).toBe(200);
      expect(answer.body?.outcomes?.[0]).toMatchObject({
        op: "result",
        status: "completed",
        result: { greeting: "hello ada", attempt: 1, signal: true },
      });
    });
  }

  it("negative control: an unsigned request, and one signed with the wrong key, are 401", async () => {
    const { adapter } = await bootHttp(moduleOf(appMetadata));
    const envelope = invoke([job("plain", { name: "ada" })]);
    expect((await post(adapter, envelope, { signed: false })).status).toBe(401);
    expect(
      (
        await post(adapter, envelope, {
          secret: "wrong-secret-0123456789abcdefghi",
        })
      ).status,
    ).toBe(401);
  });

  it("with no bytes kept, answers 500 and logs the cause, rather than a false 401", async () => {
    const errors: string[] = [];
    const logger: LoggerService = {
      log: () => {},
      warn: () => {},
      error: (message: unknown) => {
        errors.push(String(message));
      },
    };
    cleanups.push(() => Logger.overrideLogger(false));
    const adapter = new BunHttpAdapter(30000, {
      request: { retainBuffer: false },
    });
    const app = await NestFactory.create(moduleOf(appMetadata), adapter, {
      logger,
      abortOnError: false,
    });
    cleanups.push(() => app.close());
    await app.init();

    const answer = await post(adapter, invoke([job("plain", { name: "ada" })]));
    expect(answer.status).toBe(500);
    expect(errors.join("\n")).toContain("kept no bytes (retainBuffer: false)");
  });

  it("answers its health routes under the path, and leaves other routes alone", async () => {
    @Controller("other")
    class Other {
      @Post()
      run() {
        return { other: true };
      }
    }

    const { adapter } = await bootHttp(
      moduleOf({ ...appMetadata, controllers: [Other] }),
    );
    expect((await adapter.fetch("/executor/healthz")).status).toBe(200);
    expect((await adapter.fetch("/executor/readyz")).status).toBe(200);
    expect((await adapter.fetch("/other", { method: "POST" })).status).toBe(
      201,
    );
  });

  it("forRootAsync takes the secret from a factory", async () => {
    class Config {
      readonly secret = SECRET;
    }
    const ConfigModule = moduleOf({ providers: [Config], exports: [Config] });

    const { adapter } = await bootHttp(
      moduleOf({
        imports: [
          BunRemoteExecutorModule.forRootAsync({
            imports: [ConfigModule],
            inject: [Config],
            useFactory: (config: Config) => ({
              path: "/executor",
              secret: config.secret,
            }),
          }),
        ],
        providers: [Greeter, Handlers],
      }),
    );
    const answer = await post(adapter, invoke([job("plain", { name: "b" })]));
    expect(answer.body?.outcomes?.[0]?.status).toBe("completed");
  });
});

describe("a handler", () => {
  it("reads every parameter decorator from a remote job", async () => {
    const { adapter } = await bootHttp(moduleOf(appMetadata));
    const sent = job("decorated", { name: "ada" });
    const answer = await post(adapter, invoke([sent]));
    expect(answer.body?.outcomes?.[0]?.result).toEqual({
      name: "ada",
      id: sent.id,
      jobName: "decorated",
      attempt: 1,
      aborted: false,
    });
  });

  it("runs JobLoggingInterceptor, which reads the logger a remote context lacks", async () => {
    const { adapter } = await bootHttp(moduleOf(appMetadata));
    const answer = await post(adapter, invoke([job("logged")]));
    expect(answer.body?.outcomes?.[0]?.result).toBe("logged");
  });

  it("a guard's denial and a failed pipe are fatal, where a thrown error retries", async () => {
    @Injectable()
    class Denied {
      @RemoteHandler("denied")
      @UseGuards({ canActivate: () => false })
      denied() {}
    }

    const { adapter } = await bootHttp(
      moduleOf({
        ...appMetadata,
        providers: [...appMetadata.providers, Denied],
      }),
    );
    const answer = await post(adapter, invoke([job("denied")]));
    expect(answer.body?.outcomes?.[0]).toMatchObject({
      op: "fail",
      status: "failed-fatal",
    });

    const invalid = await post(adapter, invoke([job("validated", { to: 42 })]));
    expect(invalid.body?.outcomes?.[0]).toMatchObject({
      op: "fail",
      status: "failed-fatal",
    });

    const thrown = await post(adapter, invoke([job("boom")]));
    expect(thrown.body?.outcomes?.[0]).toMatchObject({
      op: "fail",
      status: "failed",
    });
  });

  it("a name nobody handles is the executor's handler-not-found", async () => {
    const { adapter } = await bootHttp(moduleOf(appMetadata));
    const answer = await post(adapter, invoke([job("nope")]));
    expect(answer.body?.outcomes?.[0]).toMatchObject({
      op: "fail",
      status: "handler-not-found",
    });
  });

  it("a request-scoped handler gets a fresh instance, with REQUEST the remote job", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class Scoped {
      constructor(@Inject(REQUEST) readonly request: RemoteJob) {}

      @RemoteHandler("scoped")
      run() {
        return this.request.name;
      }
    }

    const { adapter } = await bootHttp(
      moduleOf({
        imports: appMetadata.imports,
        providers: [Scoped],
      }),
    );
    const answer = await post(adapter, invoke([job("scoped")]));
    expect(answer.body?.outcomes?.[0]?.result).toBe("scoped");
  });
});

describe("the checks at bootstrap", () => {
  it("refuses two handlers for one name", async () => {
    @Injectable()
    class One {
      @RemoteHandler("same")
      a() {}
    }
    @Injectable()
    class Two {
      @RemoteHandler("same")
      b() {}
    }

    let caught: unknown;
    try {
      await bootHttp(moduleOf({ ...appMetadata, providers: [One, Two] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String(caught)).toContain(
      'two @RemoteHandler methods for job "same", One.a and Two.b',
    );
  });

  it("refuses a parameter no decorator fills", async () => {
    @Injectable()
    class Half {
      @RemoteHandler("half")
      half(@JobData() data: unknown, other: unknown) {
        return [data, other];
      }
    }

    let caught: unknown;
    try {
      await bootHttp(moduleOf({ ...appMetadata, providers: [Half] }));
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("Half.half: parameter 1 has no decorator");
  });

  it("needs an HTTP adapter", async () => {
    let caught: unknown;
    try {
      const app = await NestFactory.createApplicationContext(
        moduleOf(appMetadata),
        { logger: false, abortOnError: false },
      );
      await app.close();
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("needs an HTTP adapter to mount on");
  });
});
