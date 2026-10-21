/**
 * bun-validate V6 for job handlers: bun-nest exposes no job handler yet
 * (the nest-jobs-decorators plan's, not built), so this runs a handler the
 * way that plan builds one, through Nest's `ExternalContextCreator` with a
 * parameter decorator of its own and a non-HTTP context type: the pipe's
 * output reaches the handler, a failure rejects the call with the pipe's
 * error and its issues, and the global `StandardValidationPipe` checks a
 * `SchemaDto` parameter there too. `StandardValidationModule`'s global
 * filter is registered and changes none of that (outside HTTP and gateways
 * it rethrows: its unit test is in `validation.nest.test.ts`).
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication, PipeTransform } from "@nestjs/common";
import { BadRequestException, Injectable, Module } from "@nestjs/common";
import { ExternalContextCreator, NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  BunHttpAdapter,
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationModule,
} from "../lib";
import "reflect-metadata";

/** Where the test's parameter decorator records its arguments. */
const JOB_ARGS = "test:job-args";

/** Nest's BODY paramtype (3), which the pipes are told is `"body"`. */
const JOB_DATA = 3;

/**
 * `@JobData(...pipes)`: the job's data, the first argument the handler is
 * called with, as a nest-jobs-decorators `@JobData()` would record it.
 */
function JobData(...pipes: PipeTransform[]): ParameterDecorator {
  return (target, key, index) => {
    const existing =
      (Reflect.getMetadata(JOB_ARGS, target.constructor, key!) as
        Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(
      JOB_ARGS,
      {
        ...existing,
        [`${JOB_DATA}:${index}`]: { index, data: undefined, pipes },
      },
      target.constructor,
      key!,
    );
  };
}

/** Hands the handler its job's data. */
const paramsFactory = {
  exchangeKeyForValue: (_type: number, _data: unknown, args: unknown[]) =>
    args[0],
};

const Email = z.object({ to: z.email(), retries: z.coerce.number().int() });
class EmailDto extends SchemaDto(Email) {}

@Injectable()
class EmailJobs {
  piped(@JobData(new StandardSchemaPipe(Email)) data: { retries: number }) {
    return { retries: data.retries, typeofRetries: typeof data.retries };
  }

  dto(@JobData() data: EmailDto) {
    return { retries: data.retries, typeofRetries: typeof data.retries };
  }
}

@Module({ imports: [StandardValidationModule], providers: [EmailJobs] })
class AppModule {}

let app: INestApplication;
let run: (method: "piped" | "dto", data: unknown) => Promise<unknown>;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, new BunHttpAdapter(0), {
    logger: false,
  });
  await app.init();
  const ecc = app.get(ExternalContextCreator);
  const jobs = app.get(EmailJobs);
  const handlers = {
    piped: ecc.create(
      jobs,
      // Unbound on purpose: Nest's ECC calls it with `jobs` as `this`.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      jobs.piped as (...args: unknown[]) => unknown,
      "piped",
      JOB_ARGS,
      paramsFactory,
      undefined,
      undefined,
      undefined,
      "bun-jobs",
    ),
    dto: ecc.create(
      jobs,
      // Unbound on purpose: Nest's ECC calls it with `jobs` as `this`.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      jobs.dto as (...args: unknown[]) => unknown,
      "dto",
      JOB_ARGS,
      paramsFactory,
      undefined,
      undefined,
      undefined,
      "bun-jobs",
    ),
  };
  run = (method, data) =>
    (handlers[method] as (...args: unknown[]) => Promise<unknown>)(data);
});

afterAll(async () => {
  await app?.close();
});

describe("a job handler run through ExternalContextCreator", () => {
  it("StandardSchemaPipe hands it the parsed data", async () => {
    expect(await run("piped", { to: "a@b.co", retries: "2" })).toEqual({
      retries: 2,
      typeofRetries: "number",
    });
  });

  it("a failure rejects the call with the pipe's error and its issues", async () => {
    const error = await run("piped", { to: "nope", retries: 1 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as { issues: unknown }).issues).toEqual([
      { target: "body", message: "Invalid email address", path: "to" },
    ]);
  });

  it("the global StandardValidationPipe checks a SchemaDto parameter", async () => {
    expect(await run("dto", { to: "a@b.co", retries: "5" })).toEqual({
      retries: 5,
      typeofRetries: "number",
    });
    const error = await run("dto", { to: "a@b.co" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
  });
});
