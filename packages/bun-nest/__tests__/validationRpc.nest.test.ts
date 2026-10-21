/**
 * bun-validate V6 in a microservice: `ValidationExceptionFilter` in an `rpc`
 * context, over a real TCP transport (`@nestjs/microservices`, a
 * devDependency and an optional peer), on port 0.
 *
 * Nest applies global filters to microservices, so `StandardValidationModule`
 * (`APP_FILTER`) reaches a `@MessagePattern` as `@UseFilters` does. The filter
 * answers a validation failure as Nest's `BaseRpcExceptionFilter` answers an
 * error, an Observable that errors, with the validation answer; it leaves
 * every other error as Nest answers it without the filter. Before this the
 * filter rethrew in `rpc`, and the client got no reply at all.
 *
 * The controls are the same patterns with no filter: Nest's own
 * `{ status: "error", message: "Internal server error" }`, which is also
 * what the filter must answer for an error it does not word (a refused
 * response). The file runs on Nest 12 (the lock) and in the nest-matrix's
 * Nest 11 columns; nothing here reads a version.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestMicroservice } from "@nestjs/common";
import type { ClientProxy } from "@nestjs/microservices";
import type { AddressInfo, Server } from "node:net";
import {
  ResponseValidationError,
  ValidationError,
} from "@kingsleyweb/bun-common";
import { Controller, Module, UseFilters } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxyFactory,
  MessagePattern,
  Payload,
  RpcException,
  Transport,
} from "@nestjs/microservices";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { firstValueFrom, timeout } from "rxjs";
import { z } from "zod";
import {
  SchemaDto,
  StandardSchemaPipe,
  StandardValidationModule,
  ValidationExceptionFilter,
} from "../lib";
import "reflect-metadata";

const Sum = z.object({ a: z.number() });
class SumDto extends SchemaDto(Sum) {}

/** The patterns, shared by every service below. */
class Patterns {
  @MessagePattern("sum")
  sum(@Payload(new StandardSchemaPipe(Sum)) data: { a: number }) {
    return data.a + 1;
  }

  @MessagePattern("dto")
  dto(@Payload() data: SumDto) {
    return { a: data.a, typeofA: typeof data.a };
  }

  @MessagePattern("boom")
  boom(): never {
    throw new Error("boom");
  }

  @MessagePattern("rpc-error")
  rpcError(): never {
    throw new RpcException({ code: 7, reason: "own" });
  }

  @MessagePattern("refused-response")
  refusedResponse(): never {
    throw new ResponseValidationError(
      [{ target: "body", message: "m", path: "id", key: "200" }],
      200,
    );
  }

  @MessagePattern("middleware-error")
  middlewareError(): never {
    throw new ValidationError(
      [{ target: "query", message: "m", path: "page" }],
      422,
    );
  }
}

@Controller()
class GlobalPatterns extends Patterns {}

@Controller()
@UseFilters(ValidationExceptionFilter)
class ScopedPatterns extends Patterns {}

@Module({ controllers: [GlobalPatterns] })
class Bare {}

@Module({ imports: [StandardValidationModule], controllers: [GlobalPatterns] })
class WithModule {}

@Module({ controllers: [ScopedPatterns] })
class WithUseFilters {}

/** A TCP microservice of `module` on port 0, and a client of it. */
interface Service {
  /** The microservice. */
  app: INestMicroservice;
  /** A client connected to it. */
  client: ClientProxy;
}

/** Starts `module` as a TCP microservice on an OS-assigned port, with a client. */
async function start(module: new () => object): Promise<Service> {
  const app = await NestFactory.createMicroservice(module, {
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port: 0 },
    logger: false,
  });
  await app.listen();
  const { port } = app.unwrap<Server>().address() as AddressInfo;
  const client = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port },
  });
  await client.connect();
  return { app, client };
}

/**
 * Sends `data` to `pattern`: `{ ok }` with the reply, `{ error }` with what
 * the client received as the error. No reply in 3 s is a failure of its own.
 */
async function call(
  service: Service,
  pattern: string,
  data: unknown,
): Promise<{ ok: unknown } | { error: unknown }> {
  try {
    return {
      ok: await firstValueFrom(
        service.client.send(pattern, data).pipe(timeout(3000)),
      ),
    };
  } catch (error) {
    if ((error as { name?: string }).name === "TimeoutError") {
      throw new Error(`no reply to ${pattern}`, { cause: error });
    }
    return { error };
  }
}

/** The validation answer for `{ a: "x" }`. */
const REFUSED = {
  error: {
    status: "error",
    statusCode: 400,
    code: "VALIDATION",
    message: "Validation failed",
    issues: [
      {
        target: "body",
        message: "Invalid input: expected number, received string",
        path: "a",
      },
    ],
  },
};

/** Nest's answer to an error no filter words. */
const NEST_UNKNOWN = {
  error: { status: "error", message: "Internal server error" },
};

const services: Record<"bare" | "module" | "useFilters", Service> = {} as never;

beforeAll(async () => {
  services.bare = await start(Bare);
  services.module = await start(WithModule);
  services.useFilters = await start(WithUseFilters);
});

afterAll(async () => {
  for (const service of Object.values(services)) {
    await service?.client.close();
    await service?.app.close();
  }
});

describe("ValidationExceptionFilter in a TCP microservice", () => {
  it("control: without the filter, a refused payload is Nest's Internal server error", async () => {
    expect(await call(services.bare, "sum", { a: 1 })).toEqual({ ok: 2 });
    expect(await call(services.bare, "sum", { a: "x" })).toEqual(NEST_UNKNOWN);
  });

  it("StandardValidationModule's global pipe reaches a @MessagePattern: a SchemaDto payload is checked", async () => {
    expect(await call(services.module, "dto", { a: 1 })).toEqual({
      ok: { a: 1, typeofA: "number" },
    });
    expect(await call(services.module, "dto", { a: "x" })).toEqual(REFUSED);
    // Control: without the module's pipe, the payload is not checked.
    expect(await call(services.bare, "dto", { a: "x" })).toEqual({
      ok: { a: "x", typeofA: "string" },
    });
  });

  for (const via of ["module", "useFilters"] as const) {
    const label =
      via === "module"
        ? "StandardValidationModule (APP_FILTER)"
        : "@UseFilters(ValidationExceptionFilter)";

    it(`${label}: a refused payload reaches the client as the validation answer`, async () => {
      expect(await call(services[via], "sum", { a: 1 })).toEqual({ ok: 2 });
      expect(await call(services[via], "sum", { a: "x" })).toEqual(REFUSED);
    });

    it(`${label}: a validate() middleware's ValidationError carries its own status`, async () => {
      expect(await call(services[via], "middleware-error", {})).toEqual({
        error: {
          status: "error",
          statusCode: 422,
          code: "VALIDATION",
          message: "Validation failed",
          issues: [{ target: "query", message: "m", path: "page" }],
        },
      });
    });

    it(`${label}: every other error is answered as Nest answers it without the filter`, async () => {
      for (const pattern of ["boom", "rpc-error", "refused-response"]) {
        const own = await call(services.bare, pattern, {});
        expect(await call(services[via], pattern, {})).toEqual(own);
      }
      // Including the one this filter catches but does not word: a refused
      // response is a server fault, answered (and logged) as Nest does.
      expect(await call(services[via], "refused-response", {})).toEqual(
        NEST_UNKNOWN,
      );
      expect(await call(services[via], "rpc-error", {})).toEqual({
        error: { code: 7, reason: "own" },
      });
    });
  }
});
