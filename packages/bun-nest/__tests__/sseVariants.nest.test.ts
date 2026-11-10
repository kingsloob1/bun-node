/**
 * `@Sse()` under `@Validate` with an event declared by bun-common's
 * `sseVariants()` (bun-validate V11): each event is checked against the
 * variants whose `when` holds, `when` asked with the parts `@Validate`
 * parsed. The leak (data only an excluded variant matches) reaches the
 * client as Nest's value-free `event: error`; the negative control is the
 * same stream for a request the variant applies to, which is sent whole.
 */
import type { INestApplication, MessageEvent } from "@nestjs/common";
import { Controller, Module, Sse } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Observable } from "rxjs";
import { z } from "zod";
import { sse, sseVariants } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, Validate, ValidationExceptionFilter } from "../lib";
import "reflect-metadata";

/** A value the refusal must never quote. */
const SECRET = "hunter2-the-admin-only-value";

const Ticks = sse({
  tick: sseVariants({
    admin: {
      when: (valid) =>
        (valid.headers as Record<string, unknown> | undefined)?.["x-admin"] ===
        "1",
      data: z.strictObject({ n: z.number(), secret: z.string() }),
    },
    user: { data: z.strictObject({ n: z.number() }) },
  }),
});

@Controller()
class TicksController {
  @Validate({
    headers: z.object({ "x-admin": z.literal("1").optional() }),
    responses: { 200: { content: { "text/event-stream": Ticks } } },
    responseValidation: "error",
  })
  @Sse("ticks")
  ticks(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ type: "tick", data: { n: 1 } });
      // Asynchronous, so the first event (and the headers) is written first.
      setTimeout(() => {
        subscriber.next({ type: "tick", data: { n: 2, secret: SECRET } });
        setTimeout(() => subscriber.complete(), 5);
      }, 5);
    });
  }
}

@Module({ controllers: [TicksController] })
class TicksModule {}

let app: INestApplication;
let adapter: BunHttpAdapter;

beforeAll(async () => {
  adapter = new BunHttpAdapter(0);
  app = await NestFactory.create(TicksModule, adapter, { logger: false });
  app.useGlobalFilters(new ValidationExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("@Sse() with an sseVariants() event", () => {
  it("sends both events where the admin variant applies (the control)", async () => {
    const res = await adapter.fetch("/ticks", {
      headers: { "x-admin": "1" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"n":1}');
    expect(text).toContain(SECRET);
    expect(text).not.toContain("event: error");
  });

  it("refuses the admin-only event where it does not apply, value-free", async () => {
    const res = await adapter.fetch("/ticks");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"n":1}');
    expect(text).toContain("event: error");
    expect(text).not.toContain(SECRET);
  });
});
