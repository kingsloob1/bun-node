/**
 * `reply()`, `end()` and `isHeadersSent()` as `@nestjs/platform-express` 12
 * has them: any non-nil status applied and checked as Express 5's
 * `res.status` checks it (nestjs/nest e03cf5c86), an open stream ended, and
 * the headers-sent state read without waiting for, or producing, anything.
 * The Express answers themselves are compared in `expressCompat.nest.test.ts`.
 */
import { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { testServer } from "./helpers";

async function freshResponse(): Promise<BunResponse> {
  const req = await BunRequest.init(
    new Request("http://localhost/x"),
    testServer,
    { parseBody: false },
  );
  return new BunResponse(req);
}

/** Nest 12 (its core's `mapException`), where `reply()` applies every non-nil status. */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

describe.skipIf(!NEST_12)(
  "BunHttpAdapter.reply: the status, on Nest 12",
  () => {
    const adapter = new BunHttpAdapter();

    it("throws Express 5's TypeError for a non-integer, NaN included", async () => {
      for (const code of [Number.NaN, 200.5]) {
        const res = await freshResponse();
        expect(() => adapter.reply(res, "x", code)).toThrow(
          new TypeError(
            `Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`,
          ),
        );
        expect(res.headersSent).toBe(false);
      }
    });

    it("throws Express 5's RangeError outside 100–999, 0 included", async () => {
      for (const code of [0, 99, 1000]) {
        const res = await freshResponse();
        expect(() => adapter.reply(res, "x", code)).toThrow(
          new RangeError(
            `Invalid status code: ${code}. Status code must be greater than 99 and less than 1000.`,
          ),
        );
        expect(res.headersSent).toBe(false);
      }
    });

    it("applies a valid one, and keeps the status set before for undefined or null", async () => {
      const applied = await freshResponse();
      adapter.reply(applied, "x", 201);
      expect((await applied.getNativeResponse()).status).toBe(201);

      for (const code of [undefined, null]) {
        const kept = await freshResponse();
        kept.status(203);
        adapter.reply(kept, "x", code as unknown as number);
        expect((await kept.getNativeResponse()).status).toBe(203);
      }
    });
  },
);

describe.skipIf(NEST_12)("BunHttpAdapter.reply: the status, on Nest 11", () => {
  const adapter = new BunHttpAdapter();

  it("skips a falsy status, as Nest 11's platform-express does", async () => {
    for (const code of [0, Number.NaN]) {
      const res = await freshResponse();
      res.status(203);
      adapter.reply(res, "x", code);
      expect((await res.getNativeResponse()).status).toBe(203);
    }
  });
});

describe("BunHttpAdapter.end", () => {
  const adapter = new BunHttpAdapter();

  it("ends an open stream with the message as its last chunk", async () => {
    const res = await freshResponse();
    res.write("a");
    await adapter.end(res, "b");
    const native = await res.getNativeResponse();
    expect(await native.text()).toBe("ab");
  });

  it("sends a response not yet sent, and leaves a sent one alone", async () => {
    const res = await freshResponse();
    await adapter.end(res, "only");
    expect(await (await res.getNativeResponse()).text()).toBe("only");

    const sent = await freshResponse();
    sent.send("first");
    await adapter.end(sent, "second");
    expect(await (await sent.getNativeResponse()).text()).toBe("first");
  });
});

describe("BunHttpAdapter.isHeadersSent", () => {
  const adapter = new BunHttpAdapter();

  it("reads the state: false before, true once sent or a stream opened", async () => {
    const res = await freshResponse();
    expect(adapter.isHeadersSent(res)).toBe(false);
    res.send("x");
    expect(adapter.isHeadersSent(res)).toBe(true);

    const streamed = await freshResponse();
    streamed.write("a");
    expect(adapter.isHeadersSent(streamed)).toBe(true);
    await streamed.end();
  });

  it("starts no response wait: no 'Request Timedout' later with HTTP_REQUEST_TIMEOUT set", async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);
    Bun.env.HTTP_REQUEST_TIMEOUT = "20";
    try {
      const res = await freshResponse();
      expect(adapter.isHeadersSent(res)).toBe(false);
      await Bun.sleep(60);
    } finally {
      delete Bun.env.HTTP_REQUEST_TIMEOUT;
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections.map(String)).toEqual([]);
  });
});
