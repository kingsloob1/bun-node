/**
 * A boot refusal, asserted: a class guard on a `useFactory` processor stops
 * the application with a `ConfigError`, rather than running the job unguarded.
 *
 * ```bash
 * cd examples/bun-nest && bun 15-jobs/boot-refusal.ts
 * ```
 *
 * Nest finds the class given to `@UseGuards(Guard)` by scanning the module's
 * `providers: [Class]`. A provider made by `useFactory` or `useValue` is
 * scanned for nothing, so the guard class would never be instantiated and,
 * left alone, **the job would run with no guard at all** (on Nest 11 and 12).
 * `BunJobsModule` therefore refuses to boot, naming the method and the guard.
 *
 * The refusal is checked first, then two ways out, each a control that boots
 * and runs a job:
 *
 * - register the processor as a plain class provider (the guard runs);
 * - give `@UseGuards` an instance instead of a class (the guard runs, on
 *   every Nest).
 *
 * Decorators on parameters need the working directory's `tsconfig.json`
 * (oven-sh/bun#28605): run this from `examples/bun-nest`.
 */
import type { CanActivate, Type } from "@nestjs/common";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { BunQueue } from "@kingsleyweb/bun-jobs";
import {
  BunJobsModule,
  getQueueToken,
  JobForbiddenError,
  Process,
  Processor,
} from "@kingsleyweb/bun-nest/jobs";
import { Injectable, Module, UseGuards } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";
import { watchQueue } from "./helpers/outcomes";
import "reflect-metadata";

/** Handler bodies that ran: if the guard is bypassed, this shows it. */
const ran: string[] = [];

/** A guard that always denies. */
@Injectable()
class Deny implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** A processor whose guard is a class, to be registered three ways. */
@Processor("work")
@UseGuards(Deny)
class ClassGuarded {
  @Process("run")
  run() {
    ran.push("ClassGuarded");
    return "ran";
  }
}

/** The same processor, its guard given as an instance. */
@Processor("work")
@UseGuards(new Deny())
class InstanceGuarded {
  @Process("run")
  run() {
    ran.push("InstanceGuarded");
    return "ran";
  }
}

/** A module around `providers`, on a fresh memory context. */
function appWith(providers: Type<unknown>[] | object[]): Type<unknown> {
  @Module({
    imports: [
      BunJobsModule.forRoot({
        namespace: "examples-nest-refusal",
        driver: { type: "memory" },
      }),
      BunJobsModule.registerQueue({ name: "work" }),
    ],
    providers: providers as never[],
  })
  class AppModule {}
  return AppModule;
}

/** Boots `module`, returning the error it failed with, if any. */
async function boot(module: Type<unknown>) {
  try {
    return {
      app: await NestFactory.createApplicationContext(module, {
        logger: false,
        abortOnError: false,
      }),
    };
  } catch (error) {
    return { error };
  }
}

/** Adds one job to `work` and returns how it ended. */
async function runOne(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
) {
  const watcher = watchQueue(app, "work");
  const queue = app.get<BunQueue>(getQueueToken("work"), { strict: false });
  const job = await queue.add("run", {}, { attempts: 3 });
  return watcher.outcome(job.id);
}

title("Boot refusal: a class guard on a useFactory processor");

/* ------------------------------------------------------------------ */
step("The refusal");

const refused = await boot(
  appWith([{ provide: "PROCESSOR", useFactory: () => new ClassGuarded() }]),
);
check("boot failed", refused.error !== undefined && refused.app === undefined);
check("with a ConfigError", refused.error instanceof ConfigError);
const message = (refused.error as Error | undefined)?.message ?? "";
show("message", message);
check(
  "naming the method and the guard",
  message.includes("ClassGuarded.run: Nest would silently not run Deny"),
);
check("and nothing ran", ran.length === 0);

/* ------------------------------------------------------------------ */
step("Control: a plain class provider boots, and the guard denies");

const plain = await boot(appWith([ClassGuarded]));
check("boots", plain.app !== undefined);
if (plain.app) {
  const outcome = await runOne(plain.app);
  checkEqual("the guard denied the job", outcome.state, "dead");
  check("as JobForbiddenError", outcome.error instanceof JobForbiddenError);
  await plain.app.close();
}

/* ------------------------------------------------------------------ */
step("Control: a factory's processor is fine with an instance guard");

const instance = await boot(
  appWith([{ provide: "PROCESSOR", useFactory: () => new InstanceGuarded() }]),
);
check("boots", instance.app !== undefined);
if (instance.app) {
  const outcome = await runOne(instance.app);
  checkEqual("the guard denied the job", outcome.state, "dead");
  await instance.app.close();
}
checkEqual("no handler body ran in any of the three", ran, []);

summary();
