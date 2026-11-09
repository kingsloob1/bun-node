/**
 * `BunJobsModule` (nest-jobs-decorators PR-n1): the context and its queues
 * under a real Nest application, on a real bun-jobs driver, with nothing
 * mocked between the two.
 *
 * `reflect-metadata` is imported last, as the other suites do.
 */
import type { BunQueue, Job } from "@kingsleyweb/bun-jobs";
import type {
  INestApplicationContext,
  LoggerService,
  Type,
} from "@nestjs/common";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue as BunQueueClass,
  JobDataValidationError,
  JobsClosedError,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import {
  Controller,
  Inject,
  Injectable,
  Logger,
  Module,
  Post,
} from "@nestjs/common";
import {
  PARAMTYPES_METADATA,
  ROUTE_ARGS_METADATA,
  SCOPE_OPTIONS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants.js";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import {
  BunJobsModule,
  DefineJob,
  getBunJobsToken,
  getQueueToken,
  InjectBunJobs,
  InjectQueue,
  Process,
  Processor,
  QueueToken,
} from "../lib/jobs/index";
import {
  NEST_PARAMTYPES_METADATA,
  NEST_ROUTE_ARGS_METADATA,
  NEST_SCOPE_OPTIONS_METADATA,
  NEST_SELF_DECLARED_DEPS_METADATA,
} from "../lib/jobs/metadata";
import { getBunJobsOptionsToken } from "../lib/jobs/tokens";
import "reflect-metadata";

/** Applications to close after each test, and anything else to undo. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A namespace no other test has. */
function namespace(): string {
  return `nest-jobs-${crypto.randomUUID().slice(0, 8)}`;
}

/** The options a test's context is built with: unique, on the memory driver. */
function contextOptions() {
  return { namespace: namespace(), driver: { type: "memory" as const } };
}

/** Boots an application context; a failure rejects rather than aborting. */
async function boot(
  module: Type<unknown>,
  logger: LoggerService | false = false,
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(module, {
    logger,
    abortOnError: false,
  });
  cleanups.push(() => app.close());
  return app;
}

/** The message of the `ConfigError` a failing boot gives. */
async function bootProblem(module: Type<unknown>): Promise<string> {
  let caught: unknown;
  try {
    const app = await NestFactory.createApplicationContext(module, {
      logger: false,
      abortOnError: false,
    });
    await app.close();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  return (caught as ConfigError).message;
}

/** A module class with the given metadata, by name, so messages can name it. */
function moduleNamed(name: string, metadata: Parameters<typeof Module>[0]) {
  const made = { [name]: class {} }[name]!;
  Module(metadata)(made);
  return made;
}

describe("forRoot and forRootAsync", () => {
  it("forRoot builds one context, under the class and the token", async () => {
    const options = contextOptions();

    @Injectable()
    class Service {
      constructor(
        readonly plain: BunJobs,
        @InjectBunJobs() readonly decorated: BunJobs,
      ) {}
    }

    @Module({
      imports: [BunJobsModule.forRoot(options)],
      providers: [Service],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const service = app.get(Service);

    expect(service.plain).toBeInstanceOf(BunJobs);
    expect(service.plain.namespace).toBe(options.namespace);
    expect(service.decorated).toBe(service.plain);
    expect(app.get<BunJobs>(getBunJobsToken())).toBe(service.plain);
    expect(app.get<BunJobs>(BunJobs)).toBe(service.plain);
  });

  it("forRootAsync useFactory injects what it was told to, from its imports", async () => {
    const options = contextOptions();

    class Config {
      readonly namespace = options.namespace;
    }
    const ConfigModule = moduleNamed("ConfigModule", {
      providers: [Config],
      exports: [Config],
    });

    @Module({
      imports: [
        BunJobsModule.forRootAsync({
          imports: [ConfigModule],
          inject: [Config],
          useFactory: async (config: Config) => ({
            namespace: config.namespace,
            driver: options.driver,
          }),
        }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get<BunJobs>(BunJobs).namespace).toBe(options.namespace);
  });

  it("forRootAsync useClass builds the options class", async () => {
    const options = contextOptions();

    class OptionsClass {
      createBunJobsOptions() {
        return options;
      }
    }

    @Module({
      imports: [BunJobsModule.forRootAsync({ useClass: OptionsClass })],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get<BunJobs>(BunJobs).namespace).toBe(options.namespace);
  });

  it("forRootAsync useExisting uses a provider its imports reach, without building another", async () => {
    const options = contextOptions();
    let built = 0;

    class OptionsClass {
      constructor() {
        built += 1;
      }

      createBunJobsOptions() {
        return options;
      }
    }
    const OptionsModule = moduleNamed("OptionsModule", {
      providers: [OptionsClass],
      exports: [OptionsClass],
    });

    @Module({
      imports: [
        BunJobsModule.forRootAsync({
          imports: [OptionsModule],
          useExisting: OptionsClass,
        }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get<BunJobs>(BunJobs).namespace).toBe(options.namespace);
    expect(built).toBe(1);
  });

  it("forRootAsync with none of the three is a ConfigError at the call", () => {
    expect(() => BunJobsModule.forRootAsync({})).toThrow(
      "give useFactory, useClass or useExisting",
    );
    expect(() => BunJobsModule.forRootAsync({})).toThrow(ConfigError);
  });

  it("the options are provided under a registered symbol", async () => {
    const options = contextOptions();

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...options, isGlobal: true }),
        BunJobsModule.forRoot({ ...contextOptions(), name: "other" }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(getBunJobsOptionsToken()).toBe(
      Symbol.for("@kingsleyweb/bun-nest/jobs:options"),
    );
    expect(app.get(getBunJobsOptionsToken())).toMatchObject({
      namespace: options.namespace,
    });
    // The module's own options never reach the context's.
    expect(app.get(getBunJobsOptionsToken())).not.toHaveProperty("isGlobal");
    expect(app.get(getBunJobsOptionsToken("other"))).not.toHaveProperty("name");
  });

  it("refuses a context name no token could hold", () => {
    expect(() =>
      BunJobsModule.forRoot({ ...contextOptions(), name: "a:b" }),
    ).toThrow(ConfigError);
  });

  it("two forRoots for one context are a ConfigError, and two names are fine", async () => {
    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.forRoot(contextOptions()),
      ],
    })
    class Twice {}
    expect(await bootProblem(Twice)).toContain(
      "default context is provided by 2 forRoot()/forRootAsync() calls",
    );

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
      ],
    })
    class Named {}
    await boot(Named);
  });
});

describe("isGlobal", () => {
  /** A provider that injects the default context. */
  @Injectable()
  class NeedsContext {
    constructor(readonly jobs: BunJobs) {}
  }

  it("is global by default: a feature module needs nothing but itself", async () => {
    const Feature = moduleNamed("Feature", { providers: [NeedsContext] });

    @Module({ imports: [BunJobsModule.forRoot(contextOptions()), Feature] })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get(NeedsContext, { strict: false }).jobs).toBeInstanceOf(
      BunJobs,
    );
  });

  it("isGlobal: false is really local", async () => {
    const local = BunJobsModule.forRoot({
      ...contextOptions(),
      isGlobal: false,
    });
    const Feature = moduleNamed("Feature", { providers: [NeedsContext] });

    @Module({ imports: [local, Feature] })
    class Unreachable {}

    let error: unknown;
    try {
      await boot(Unreachable);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("can't resolve dependencies");

    // The control: the same module, imported where it is needed, resolves.
    const local2 = BunJobsModule.forRoot({
      ...contextOptions(),
      isGlobal: false,
    });
    const Importing = moduleNamed("Importing", {
      imports: [local2],
      providers: [NeedsContext],
    });
    const app = await boot(Importing);
    expect(app.get(NeedsContext).jobs).toBeInstanceOf(BunJobs);
  });

  it("a queue reaches a local context through registerQueueAsync({ imports })", async () => {
    const options = contextOptions();
    const local = BunJobsModule.forRoot({ ...options, isGlobal: false });

    @Module({
      imports: [
        local,
        BunJobsModule.registerQueueAsync({
          name: "emails",
          imports: [local],
          useFactory: () => ({}),
        }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const queue = app.get<BunQueue>(getQueueToken("emails"), { strict: false });
    expect(queue.namespace).toBe(options.namespace);
  });

  it("a queue with no context it can see says so", async () => {
    @Module({ imports: [BunJobsModule.registerQueue({ name: "emails" })] })
    class NoContext {}

    expect(await bootProblem(NoContext)).toContain(
      'queue "emails" is registered, but this module cannot see BunJobsModule.forRoot()',
    );

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "emails", context: "billing" }),
      ],
    })
    class WrongContext {}

    expect(await bootProblem(WrongContext)).toContain(
      'cannot see BunJobsModule.forRoot({ name: "billing" })',
    );
  });
});

describe("building or borrowing the context", () => {
  it("a built context closes on app.close(), with its driver", async () => {
    @Module({ imports: [BunJobsModule.forRoot(contextOptions())] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const jobs = app.get<BunJobs>(BunJobs);
    const close = spyOn(jobs.driver, "close");
    jobs.queue("still-open");

    await app.close();

    expect(close).toHaveBeenCalledTimes(1);
    expect(() => jobs.queue("late")).toThrow(JobsClosedError);
  });

  it("a borrowed context stays the application's", async () => {
    const jobs = new BunJobs({
      namespace: namespace(),
      driver: new MemoryDriver(),
    });
    cleanups.push(() => jobs.close());
    const close = spyOn(jobs.driver, "close");

    @Module({ imports: [BunJobsModule.forRoot({ jobs })] })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    expect(app.get<BunJobs>(BunJobs)).toBe(jobs);

    await app.close();

    expect(close).not.toHaveBeenCalled();
    await jobs.queue("late").add("x", {});
    expect((await jobs.queue("late").count()).waiting).toBe(1);
  });

  it("queues stay open through onModuleDestroy, for a last enqueue", async () => {
    let added: Job | undefined;

    @Injectable()
    class Closing {
      constructor(@InjectQueue("emails") readonly queue: BunQueue) {}

      async onModuleDestroy() {
        added = await this.queue.add("account-closed", {});
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "emails" }),
      ],
      providers: [Closing],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    await app.close();
    expect(added?.name).toBe("account-closed");
  });

  it("a controller on the HTTP adapter adds a job through an injected queue", async () => {
    @Controller("signup")
    class Signup {
      constructor(@InjectQueue("emails") readonly queue: BunQueue) {}

      @Post()
      async signup() {
        const job = await this.queue.add("welcome", { to: "ada@example.com" });
        return { id: job.id };
      }
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "emails" }),
      ],
      controllers: [Signup],
    })
    class AppModule {}

    const adapter = new BunHttpAdapter(30000);
    const app = await NestFactory.create(AppModule, adapter, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const response = await adapter.fetch("/signup", { method: "POST" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const queue = app.get<BunQueue>(getQueueToken("emails"), {
      strict: false,
    });
    expect((await queue.getJob(id))?.data).toEqual({ to: "ada@example.com" });
  });
});

describe("registerQueue", () => {
  const Email = z.object({ to: z.string() });

  /** A feature module registering `emails`, and a service injecting it. */
  function feature(
    name: string,
    registration: Parameters<typeof BunJobsModule.registerQueue>[0],
  ) {
    class Service {
      constructor(readonly queue: BunQueue) {}
    }
    Inject(getQueueToken("emails"))(Service, undefined, 0);
    return {
      Service,
      Module: moduleNamed(name, {
        imports: [BunJobsModule.registerQueue(registration)],
        providers: [Service],
      }),
    };
  }

  it("two feature modules get one queue, and its schema, whichever Nest builds first", async () => {
    for (const bareFirst of [true, false]) {
      const bare = feature("Bare", { name: "emails" });
      const withSchema = feature("WithSchema", {
        name: "emails",
        options: { schema: { data: Email } },
      });
      const features = bareFirst
        ? [bare.Module, withSchema.Module]
        : [withSchema.Module, bare.Module];

      const AppModule = moduleNamed("AppModule", {
        imports: [BunJobsModule.forRoot(contextOptions()), ...features],
      });
      const app = await boot(AppModule);

      const one = app.get(bare.Service, { strict: false }).queue;
      const other = app.get(withSchema.Service, { strict: false }).queue;
      expect(one).toBe(other);
      expect(one).toBeInstanceOf(BunQueueClass);

      await one.add("welcome", { to: "ada@example.com" });
      await expect(one.add("welcome", { to: 42 })).rejects.toBeInstanceOf(
        JobDataValidationError,
      );
    }
  });

  it("no bun-jobs warning about ignored options comes from a clean registration", async () => {
    const warnings: string[] = [];
    const sink: LoggerService = {
      log: () => {},
      error: () => {},
      warn: (message: unknown) => {
        warnings.push(String(message));
      },
    };
    cleanups.push(() => Logger.overrideLogger(false));
    const options = { defaultJobOptions: { attempts: 3 } };

    const AppModule = moduleNamed("AppModule", {
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({ name: "emails" }),
        feature("One", { name: "emails", options }).Module,
        feature("Two", {
          name: "emails",
          options: { defaultJobOptions: { attempts: 3 } },
        }).Module,
      ],
    });
    await boot(AppModule, sink);

    expect(warnings.filter((line) => line.includes("ignored"))).toEqual([]);
  });

  it("registerQueueAsync builds the queue's options with what it injects", async () => {
    class Config {
      readonly attempts = 7;
    }
    const ConfigModule = moduleNamed("ConfigModule", {
      providers: [Config],
      exports: [Config],
    });

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueueAsync({
          name: "emails",
          imports: [ConfigModule],
          inject: [Config],
          useFactory: (config: Config) => ({
            options: { defaultJobOptions: { attempts: config.attempts } },
          }),
        }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const queue = app.get<BunQueue>(getQueueToken("emails"), { strict: false });
    const job = await queue.add("x", {});
    expect(job.opts.attempts).toBe(7);
  });

  describe("the options-conflict check", () => {
    /** An application whose named modules each register `emails` as given. */
    function appWith(
      entries: Record<
        string,
        Parameters<typeof BunJobsModule.registerQueue>[0]
      >,
    ) {
      return moduleNamed("AppModule", {
        imports: [
          BunJobsModule.forRoot(contextOptions()),
          ...Object.entries(entries).map(
            ([name, registration]) => feature(name, registration).Module,
          ),
        ],
      });
    }

    it("two registrations with different options fail the boot, naming both modules", async () => {
      const message = await bootProblem(
        appWith({
          EmailsModule: {
            name: "emails",
            options: { defaultJobOptions: { attempts: 3 } },
          },
          BillingModule: {
            name: "emails",
            options: { defaultJobOptions: { attempts: 5 } },
          },
        }),
      );
      expect(message).toContain(
        'queue "emails" in the default context is registered with different options (defaultJobOptions)',
      );
      expect(message).toContain("EmailsModule");
      expect(message).toContain("BillingModule");
    });

    it("two schemas differ by identity, however alike they read", async () => {
      const message = await bootProblem(
        appWith({
          A: { name: "emails", options: { schema: { data: z.string() } } },
          B: { name: "emails", options: { schema: { data: z.string() } } },
        }),
      );
      expect(message).toContain("different options (schema)");
    });

    it("a key one side leaves out differs", async () => {
      const message = await bootProblem(
        appWith({
          A: { name: "emails", options: { subscribe: true } },
          B: {
            name: "emails",
            options: { subscribe: true, jobDefaultsRefreshInterval: 1000 },
          },
        }),
      );
      expect(message).toContain(
        "different options (jobDefaultsRefreshInterval)",
      );
    });

    it("the same options pass, by value, and a registration with none asks for nothing", async () => {
      const schema = { data: Email };
      const app = await boot(
        appWith({
          A: {
            name: "emails",
            options: { defaultJobOptions: { attempts: 3 }, schema },
          },
          B: {
            name: "emails",
            options: { defaultJobOptions: { attempts: 3 }, schema },
          },
          C: { name: "emails" },
          D: { name: "emails", options: {} },
        }),
      );
      const queue = app.get<BunQueue>(getQueueToken("emails"), {
        strict: false,
      });
      expect((await queue.add("x", { to: "a" })).opts.attempts).toBe(3);
    });

    it("an async registration is checked too", async () => {
      const AppModule = moduleNamed("AppModule", {
        imports: [
          BunJobsModule.forRoot(contextOptions()),
          moduleNamed("SyncModule", {
            imports: [
              BunJobsModule.registerQueue({
                name: "emails",
                options: { defaultJobOptions: { attempts: 3 } },
              }),
            ],
          }),
          moduleNamed("AsyncModule", {
            imports: [
              BunJobsModule.registerQueueAsync({
                name: "emails",
                useFactory: () => ({
                  options: { defaultJobOptions: { attempts: 5 } },
                }),
              }),
            ],
          }),
        ],
      });
      const message = await bootProblem(AppModule);
      expect(message).toContain("different options (defaultJobOptions)");
      expect(message).toContain("SyncModule");
      expect(message).toContain("AsyncModule");
    });

    it("an async registration's options are never lost to a bare one that created the queue first", async () => {
      // The bare one's factory runs while the async one's awaits.
      const AppModule = moduleNamed("AppModule", {
        imports: [
          BunJobsModule.forRoot(contextOptions()),
          moduleNamed("BareModule", {
            imports: [BunJobsModule.registerQueue({ name: "emails" })],
          }),
          moduleNamed("AsyncModule", {
            imports: [
              BunJobsModule.registerQueueAsync({
                name: "emails",
                useFactory: async () => {
                  await Bun.sleep(5);
                  return { options: { defaultJobOptions: { attempts: 5 } } };
                },
              }),
            ],
          }),
        ],
      });
      const message = await bootProblem(AppModule);
      expect(message).toContain("different options (defaultJobOptions)");
      expect(message).toContain("BareModule");
      expect(message).toContain("AsyncModule");
    });

    it("every problem is listed in one ConfigError", async () => {
      const AppModule = moduleNamed("AppModule", {
        imports: [
          BunJobsModule.forRoot(contextOptions()),
          BunJobsModule.forRoot(contextOptions()),
          moduleNamed("A", {
            imports: [
              BunJobsModule.registerQueue(
                { name: "one", options: { subscribe: true } },
                { name: "two", options: { subscribe: true } },
              ),
            ],
          }),
          moduleNamed("B", {
            imports: [
              BunJobsModule.registerQueue(
                { name: "one", options: { subscribe: false } },
                { name: "two", options: { subscribe: false } },
              ),
            ],
          }),
        ],
      });
      const message = await bootProblem(AppModule);
      expect(message).toContain("3 problems at boot");
      expect(message).toContain("default context is provided by 2");
      expect(message).toContain('queue "one"');
      expect(message).toContain('queue "two"');
    });

    it("one queue name in two contexts is two queues, not a conflict", async () => {
      const AppModule = moduleNamed("AppModule", {
        imports: [
          BunJobsModule.forRoot(contextOptions()),
          BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
          BunJobsModule.registerQueue(
            { name: "emails", options: { subscribe: true } },
            {
              name: "emails",
              context: "billing",
              options: { subscribe: false },
            },
          ),
        ],
      });
      await boot(AppModule);
    });
  });
});

describe("what the types refuse, reached without them", () => {
  const Email = z.object({ to: z.string() });

  it("a bare string in registerQueue is a ConfigError naming the fix", () => {
    const register = () => BunJobsModule.registerQueue("emails" as never);
    expect(register).toThrow(ConfigError);
    expect(register).toThrow('{ name: "emails" }');
  });

  it("a token class that reads as undefined is a ConfigError saying why", () => {
    const missing = undefined as unknown as Parameters<typeof InjectQueue>[0];
    expect(() => InjectQueue(missing)).toThrow(ConfigError);
    expect(() => InjectQueue(missing)).toThrow("across an import cycle");
    expect(() => BunJobsModule.registerQueue({} as { name: string })).toThrow(
      ConfigError,
    );
    expect(() =>
      BunJobsModule.registerWorker({
        queue: missing as string,
        processor: "./p.ts",
      }),
    ).toThrow(ConfigError);
  });

  /** Options holding a schema as anything typed `any` could, past the types. */
  const options = (schema: unknown) => ({ schema }) as never;

  it("a bare schema on a queue fails the boot, sync or async, rather than validating nothing", async () => {
    for (const registration of [
      BunJobsModule.registerQueue({ name: "q", options: options(Email) }),
      BunJobsModule.registerQueueAsync({
        name: "q",
        useFactory: () => ({ options: options(Email) }),
      }),
    ]) {
      const AppModule = moduleNamed("AppModule", {
        imports: [BunJobsModule.forRoot(contextOptions()), registration],
      });
      const message = await bootProblem(AppModule);
      expect(message).toContain('queue "q": schema is { data, result }');
      expect(message).toContain("schema: { data: YourSchema }");
    }
  });

  it("the control: the same schema under `data` boots, and validates", async () => {
    const AppModule = moduleNamed("AppModule", {
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue({
          name: "q",
          options: options({ data: Email }),
        }),
      ],
    });
    const app = await boot(AppModule);
    const queue = app.get<BunQueue>(getQueueToken("q"), { strict: false });
    await expect(queue.add("x", { to: 42 })).rejects.toBeInstanceOf(
      JobDataValidationError,
    );
  });

  it("a bare schema on @Processor, @DefineJob and registerWorker fails the boot", async () => {
    @Processor("q", options(Email))
    class Bare {
      @Process()
      run() {}
    }

    @Injectable()
    class BareDefined {
      @DefineJob("x", options(Email))
      x() {}
    }

    const AppModule = moduleNamed("AppModule", {
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerWorker({
          queue: "files",
          processor: "./p.ts",
          options: options(Email),
        }),
      ],
      providers: [Bare, BareDefined],
    });
    const message = await bootProblem(AppModule);
    expect(message).toContain("Bare: schema is { data, result }");
    expect(message).toContain("BareDefined.x: schema is { data, result }");
    expect(message).toContain('registerWorker on queue "files": schema is');
  });
});

describe("named contexts", () => {
  it("qualifies every token by the context's name", async () => {
    expect(getQueueToken("emails")).toBe("bun-jobs:queue:emails");
    expect(getQueueToken("emails", "billing")).toBe(
      "bun-jobs:billing:queue:emails",
    );
    expect(getBunJobsToken()).not.toBe(getBunJobsToken("billing"));

    const shop = contextOptions();
    const billing = { ...contextOptions(), name: "billing" };

    @Injectable()
    class Service {
      constructor(
        @InjectBunJobs() readonly shopJobs: BunJobs,
        @InjectBunJobs("billing") readonly billingJobs: BunJobs,
        @InjectQueue("emails") readonly shopEmails: BunQueue,
        @InjectQueue("emails", "billing") readonly billingEmails: BunQueue,
      ) {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(shop),
        BunJobsModule.forRoot(billing),
        BunJobsModule.registerQueue(
          { name: "emails" },
          { name: "emails", context: "billing" },
        ),
      ],
      providers: [Service],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const service = app.get(Service);

    expect(service.shopJobs.namespace).toBe(shop.namespace);
    expect(service.billingJobs.namespace).toBe(billing.namespace);
    expect(service.shopEmails.namespace).toBe(shop.namespace);
    expect(service.billingEmails.namespace).toBe(billing.namespace);
    expect(service.shopEmails).not.toBe(service.billingEmails);
    // The class stands for the default context alone.
    expect(app.get<BunJobs>(BunJobs)).toBe(service.shopJobs);
  });

  it("a named context alone leaves the class unprovided", async () => {
    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), name: "billing" }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(() => app.get<BunJobs>(BunJobs)).toThrow();
    expect(app.get(getBunJobsToken("billing"))).toBeInstanceOf(BunJobs);
  });

  it("each named context closes itself", async () => {
    const billing = new BunJobs({
      namespace: namespace(),
      driver: new MemoryDriver(),
    });
    cleanups.push(() => billing.close());

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.forRoot({ jobs: billing, name: "billing" }),
      ],
    })
    class AppModule {}

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    const built = app.get<BunJobs>(BunJobs);
    await app.close();

    expect(() => built.queue("late")).toThrow(JobsClosedError);
    expect(() => billing.queue("late")).not.toThrow();
  });
});

describe("typed queue tokens", () => {
  /** A typed token for a queue of the default context. */
  @QueueToken("emails")
  abstract class EmailsQueue extends BunQueueClass<
    { to: string },
    string,
    "welcome" | "digest"
  > {}

  /** One for a named context. */
  @QueueToken("invoices", "billing")
  abstract class InvoicesQueue extends BunQueueClass<{ id: number }> {}

  it("is the token and the type at once, and hands back the real queue", async () => {
    @Injectable()
    class Service {
      constructor(
        readonly plain: EmailsQueue,
        @InjectQueue(EmailsQueue) readonly decorated: EmailsQueue,
        @InjectQueue("emails") readonly byName: BunQueue,
        @Inject(EmailsQueue) readonly byInject: EmailsQueue,
      ) {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(contextOptions()),
        BunJobsModule.registerQueue(EmailsQueue),
      ],
      providers: [Service],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const service = app.get(Service);

    expect(service.plain).toBeInstanceOf(BunQueueClass);
    expect(service.plain).not.toBeInstanceOf(EmailsQueue);
    expect(service.plain.name).toBe("emails");
    expect(service.decorated).toBe(service.plain);
    expect(service.byName as unknown).toBe(service.plain);
    expect(service.byInject).toBe(service.plain);
    const job = await service.plain.add("welcome", { to: "ada@example.com" });
    expect(job.name).toBe("welcome");
  });

  it("takes options, and a context from its decorator", async () => {
    const billing = { ...contextOptions(), name: "billing" };

    @Injectable()
    class Service {
      constructor(
        @InjectQueue(InvoicesQueue) readonly invoices: InvoicesQueue,
        @InjectQueue("invoices", "billing") readonly byName: BunQueue,
      ) {}
    }

    @Module({
      imports: [
        BunJobsModule.forRoot(billing),
        BunJobsModule.registerQueue({
          name: InvoicesQueue,
          options: { defaultJobOptions: { attempts: 9 } },
        }),
      ],
      providers: [Service],
    })
    class AppModule {}

    const app = await boot(AppModule);
    const service = app.get(Service);
    expect(service.invoices.namespace).toBe(billing.namespace);
    expect(service.byName as unknown).toBe(service.invoices);
    expect((await service.invoices.add("x", { id: 1 })).opts.attempts).toBe(9);
  });

  it("refuses a class without @QueueToken, and a context that disagrees with its token", () => {
    abstract class Unnamed extends BunQueueClass {}

    expect(() => BunJobsModule.registerQueue(Unnamed)).toThrow(
      "Unnamed has no @QueueToken(name)",
    );
    expect(() => InjectQueue(Unnamed)).toThrow(ConfigError);
    expect(() =>
      BunJobsModule.registerQueue({ name: InvoicesQueue, context: "shop" }),
    ).toThrow('but its registration says context "shop"');
  });

  it("forRoot({ token }) provides a named context class too", async () => {
    abstract class AppJobs extends BunJobs<{
      report: { data: { month: string }; result: void };
    }> {}

    @Injectable()
    class Service {
      constructor(readonly jobs: AppJobs) {}
    }

    @Module({
      imports: [BunJobsModule.forRoot({ ...contextOptions(), token: AppJobs })],
      providers: [Service],
    })
    class AppModule {}

    const app = await boot(AppModule);
    expect(app.get(Service).jobs as unknown).toBe(app.get<BunJobs>(BunJobs));
    expect(app.get(Service).jobs).not.toBeInstanceOf(AppJobs);
  });
});

describe("the logger", () => {
  /** A Nest logger that keeps what it is told. */
  function sink() {
    const lines: { level: string; message: string; context: unknown }[] = [];
    const keep =
      (level: string) =>
      (message: unknown, ...rest: unknown[]) => {
        lines.push({ level, message: String(message), context: rest.at(-1) });
      };
    const logger: LoggerService = {
      log: keep("log"),
      error: keep("error"),
      warn: keep("warn"),
      debug: keep("debug"),
      verbose: keep("verbose"),
      fatal: keep("fatal"),
    };
    return { logger, lines };
  }

  /** Makes bun-jobs log a warning through the context's logger. */
  function causeWarning(jobs: BunJobs): void {
    jobs.queue("warned", { defaultJobOptions: { attempts: 1 } });
    jobs.queue("warned", { defaultJobOptions: { attempts: 2 } });
  }

  it("bun-jobs' records reach the application's logger by default", async () => {
    const { logger, lines } = sink();
    cleanups.push(() => Logger.overrideLogger(false));

    @Module({ imports: [BunJobsModule.forRoot(contextOptions())] })
    class AppModule {}

    const app = await boot(AppModule, logger);
    causeWarning(app.get<BunJobs>(BunJobs));

    const warned = lines.find(
      (line) => line.level === "warn" && line.message.includes("ignored"),
    );
    expect(warned?.message).toContain('Queue "warned" already exists');
    expect(String(warned?.context)).toContain("BunJobs");
  });

  it("logger: false drops them, and a given logger takes them instead", async () => {
    const { logger, lines } = sink();
    cleanups.push(() => Logger.overrideLogger(false));
    const given: string[] = [];

    @Module({
      imports: [
        BunJobsModule.forRoot({ ...contextOptions(), logger: false }),
        BunJobsModule.forRoot({
          ...contextOptions(),
          name: "given",
          logger: (event) => {
            given.push(String(event.message));
          },
        }),
      ],
    })
    class AppModule {}

    const app = await boot(AppModule, logger);
    causeWarning(app.get<BunJobs>(BunJobs));
    causeWarning(app.get<BunJobs>(getBunJobsToken("given")));

    expect(lines.some((line) => line.message.includes("ignored"))).toBe(false);
    expect(given.some((line) => line.includes("ignored"))).toBe(true);
  });
});

describe("the metadata keys, by value", () => {
  it("equal Nest's constants", () => {
    expect(NEST_PARAMTYPES_METADATA).toBe(PARAMTYPES_METADATA);
    expect(NEST_SELF_DECLARED_DEPS_METADATA).toBe(SELF_DECLARED_DEPS_METADATA);
    expect(NEST_ROUTE_ARGS_METADATA).toBe(ROUTE_ARGS_METADATA);
    expect(NEST_SCOPE_OPTIONS_METADATA).toBe(SCOPE_OPTIONS_METADATA);
  });
});

describe("decorator metadata that is off (R3)", () => {
  /** Runs the fixture from a directory with the given tsconfig. */
  async function runFixture(
    tsconfig: object,
    mode: "syntax" | "by-call",
  ): Promise<string> {
    const cwd = `${tmpdir()}/bun-nest-jobs-r3-${crypto.randomUUID()}`;
    await mkdir(cwd, { recursive: true });
    cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(`${cwd}/tsconfig.json`, JSON.stringify(tsconfig));
    const fixture = `${import.meta.dir}/fixtures/jobs-decorators/app.ts`;
    const child = Bun.spawn([process.execPath, fixture, mode], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result = out.split("\n").find((line) => line.startsWith("RESULT="));
    if (result === undefined) {
      throw new Error(`the fixture printed no result: ${out}\n${err}`);
    }
    return out.slice(out.indexOf("RESULT=") + "RESULT=".length).trim();
  }

  const FLAGS_ON = {
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  };
  const FLAGS_OFF = { compilerOptions: {} };

  it("with the flags off, a dropped decorator is a ConfigError naming the cause and the class", async () => {
    const result = await runFixture(FLAGS_OFF, "syntax");
    expect(result).toStartWith("ConfigError");
    expect(result).toContain("decorator metadata is off");
    expect(result).toContain("WithSyntax");
    expect(result).toContain("oven-sh/bun#28605");
    expect(result).toContain("tsconfig.json");
  }, 30_000);

  it("the control: the same file with the flags on boots and injects", async () => {
    expect(await runFixture(FLAGS_ON, "syntax")).toBe("ok queue=q");
  }, 30_000);

  it("with the flags off and nothing dropped, the module's own wiring boots: it is applied by call", async () => {
    expect(await runFixture(FLAGS_OFF, "by-call")).toBe("ok queue=q");
  }, 30_000);
});
