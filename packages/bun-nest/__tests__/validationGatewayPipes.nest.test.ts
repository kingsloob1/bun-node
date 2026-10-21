/**
 * `StandardValidationModule.gatewayPipes()`: a gateway gets exactly the
 * pipes it needs on the installed Nest. On Nest 12 global pipes reach
 * gateways, so it gets none (the module's global pipe validates once); on
 * Nest 11 they do not, so it gets `StandardValidationPipe`'s class, which
 * Nest builds with the module's `forRoot()` options.
 *
 * The app imports `StandardValidationModule.forRoot({ messages: "generic" })`
 * and validates a transforming schema (`at`: a string in, a `Date` out),
 * which a second run would refuse (its input is then a `Date`). The negative
 * control is a gateway with a plain `@UsePipes(StandardValidationPipe)`: on
 * Nest 12 it runs the schema twice and refuses every valid message.
 *
 * The file runs on Nest 12 (the lock) and in the nest-matrix's Nest 11
 * columns. Which major it is on is read from the capability the helper
 * reads, `SocketModule.getContextCreator`'s parameters, never a version.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { WsTestClient } from "./helpers";
import { Module, UseFilters, UsePipes } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SocketModule } from "@nestjs/websockets/socket-module.js";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  BunHttpAdapter,
  SchemaDto,
  StandardValidationException,
  StandardValidationModule,
  StandardValidationPipe,
  ValidationExceptionFilter,
} from "../lib";
import { MessageEventTypes } from "../lib/BunWebSocketAdapter";
import { connectWs } from "./helpers";
import "reflect-metadata";

const { EVENT } = MessageEventTypes;

/** Whether Nest applies global pipes to gateways (Nest 12): the helper's capability. */
const GLOBAL_PIPES_REACH_GATEWAYS =
  (
    SocketModule.prototype as unknown as {
      getContextCreator: (...args: unknown[]) => unknown;
    }
  ).getContextCreator.length >= 2;

/** A string in, a `Date` out: a second run of the schema refuses the `Date`. */
const Stamp = z.object({ at: z.string().transform((s) => new Date(s)) });
class StampDto extends SchemaDto(Stamp) {}

/** The handler, shared by both gateways. */
class StampHandlers {
  @SubscribeMessage("stamp")
  stamp(@MessageBody() msg: StampDto) {
    return {
      event: "stamp",
      data: { isDate: msg.at instanceof Date, iso: msg.at.toISOString() },
    };
  }
}

@WebSocketGateway({ path: "/helper" })
@UsePipes(...StandardValidationModule.gatewayPipes())
@UseFilters(ValidationExceptionFilter)
class HelperGateway extends StampHandlers {}

@WebSocketGateway({ path: "/plain" })
@UsePipes(StandardValidationPipe)
@UseFilters(ValidationExceptionFilter)
class PlainGateway extends StampHandlers {}

@Module({
  imports: [StandardValidationModule.forRoot({ messages: "generic" })],
  providers: [HelperGateway, PlainGateway],
})
class AppModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const httpAdapter = new BunHttpAdapter(0);
  app = await NestFactory.create(AppModule, httpAdapter, { logger: false });
  app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
  await app.listen(0);
  base = `ws://127.0.0.1:${httpAdapter.listeningPort}`;
});

afterAll(async () => {
  await app?.close();
});

/**
 * Sends one event and resolves with the first frame after it that answers
 * it or is an `exception` (frames already received do not count).
 */
async function reply(
  client: WsTestClient,
  event: string,
  data: unknown,
): Promise<unknown> {
  const before = client.received.length;
  client.send({ type: EVENT, namespace: "/", data: [event, data] });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const frame = client.received
      .slice(before)
      .map((raw) => JSON.parse(raw) as { data?: unknown[] })
      .find((m) => m.data?.[0] === event || m.data?.[0] === "exception");
    if (frame) return frame.data;
    await Bun.sleep(5);
  }
  throw new Error(`no reply to ${event}`);
}

const ISO = "2026-01-02T03:04:05.000Z";

describe("StandardValidationModule.gatewayPipes()", () => {
  let helper: WsTestClient;
  let plain: WsTestClient;
  beforeAll(async () => {
    helper = await connectWs(`${base}/helper`);
    plain = await connectWs(`${base}/plain`);
  });
  afterAll(async () => {
    await helper?.close();
    await plain?.close();
  });

  it(`gives ${GLOBAL_PIPES_REACH_GATEWAYS ? "no pipe (Nest 12: the global pipe reaches gateways)" : "the pipe's class (Nest 11)"}`, () => {
    expect(StandardValidationModule.gatewayPipes()).toEqual(
      GLOBAL_PIPES_REACH_GATEWAYS ? [] : [StandardValidationPipe],
    );
  });

  it("a transforming schema validates once: a valid message reaches the handler as the output", async () => {
    expect(await reply(helper, "stamp", { at: ISO })).toEqual([
      "stamp",
      { isDate: true, iso: ISO },
    ]);
  });

  it("a refused message is refused once, with forRoot()'s messages: 'generic'", async () => {
    expect(await reply(helper, "stamp", { at: 1 })).toEqual([
      "exception",
      {
        status: 400,
        code: "VALIDATION",
        issues: [
          {
            target: "body",
            message: "Invalid value (invalid_type)",
            path: "at",
          },
        ],
      },
    ]);
  });

  it(`control: a plain @UsePipes(StandardValidationPipe) ${GLOBAL_PIPES_REACH_GATEWAYS ? "runs the schema twice and refuses a valid message (Nest 12)" : "is the one run (Nest 11)"}`, async () => {
    const answered = (await reply(plain, "stamp", { at: ISO })) as [
      string,
      Record<string, unknown>,
    ];
    if (GLOBAL_PIPES_REACH_GATEWAYS) {
      // The second run's input is the first's output, a Date.
      expect(answered[0]).toBe("exception");
      expect(answered[1].issues).toEqual([
        {
          target: "body",
          message: "Invalid value (invalid_type)",
          path: "at",
        },
      ]);
    } else {
      expect(answered).toEqual(["stamp", { isDate: true, iso: ISO }]);
    }
  });
});

describe("a StandardValidationPipe Nest builds gets forRoot()'s options (both majors)", () => {
  /** A module providing the pipe's class, as `@UsePipes(StandardValidationPipe)` makes Nest do. */
  @Module({ providers: [StandardValidationPipe] })
  class Consumer {}

  /** Builds the pipe through Nest's injector, under `imports`. */
  async function built(imports: unknown[]): Promise<StandardValidationPipe> {
    @Module({ imports: [...(imports as never[]), Consumer] })
    class Root {}
    const context = await NestFactory.createApplicationContext(Root, {
      logger: false,
    });
    try {
      return context.get(StandardValidationPipe, { strict: false });
    } finally {
      await context.close();
    }
  }

  /** The message the pipe gives a refused `StampDto`. */
  function messageOf(pipe: StandardValidationPipe): string {
    try {
      pipe.transform({ at: 1 }, { type: "body", metatype: StampDto });
    } catch (error) {
      return (error as StandardValidationException).issues[0].message;
    }
    throw new Error("not refused");
  }

  it("with the module's forRoot({ messages: 'generic' }), from another module (it is global)", async () => {
    const pipe = await built([
      StandardValidationModule.forRoot({ messages: "generic" }),
    ]);
    expect(messageOf(pipe)).toBe("Invalid value (invalid_type)");
  });

  it("control: without the module, the default scrub (the vendor's message)", async () => {
    const pipe = await built([]);
    expect(messageOf(pipe)).toBe(
      "Invalid input: expected string, received number",
    );
  });
});
