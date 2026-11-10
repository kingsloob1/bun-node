/**
 * A broadcast channel behind NestJS's `@Sse()` on `BunHttpAdapter`:
 * bun-common's `createSseChannel()` served through `channelObservable()`,
 * and through `@Res()` with `channel.subscribe(req, res)`.
 *
 * ```bash
 * bun 02-http-adapter/sse-channel.ts
 * ```
 *
 * Worth knowing:
 *
 * - `channelObservable(channel, { lastEventId, signal, topics })` is the
 *   `Observable<MessageEvent>` an `@Sse()` handler returns. Each client gets
 *   the channel's initial state (or, reconnecting with a `Last-Event-ID` the
 *   channel holds, what it missed), then live events. It leaves the channel
 *   when Nest unsubscribes (the client left) or `@SseSignal()` aborts (Nest
 *   11.2.0 and later; this example passes it where Nest has it).
 * - `channel.send()` from anywhere (a service, a job) reaches every client.
 * - Nest numbers events that carry no `id`, so an initial-state event
 *   arrives as `id: 1`; with `replay`, the channel's own ids pass through.
 * - Nest formats each event per subscriber. `@Res() res` with
 *   `channel.subscribe(req, res)` opens bun-common's `res.sse()` instead and
 *   queues the channel's encoded bytes as they are: one encode per event,
 *   whatever the number of clients.
 * - Every client below is served over a socket; `adapter.fetch()` behaves the
 *   same (bun-nest's `sseChannel.nest.test.ts`).
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import { createSseChannel, readSse } from "@kingsleyweb/bun-common/sse";
import { BunHttpAdapter, channelObservable } from "@kingsleyweb/bun-nest";
import * as common from "@nestjs/common";
import {
  Controller,
  Get,
  Headers,
  Module,
  Req,
  Res,
  Sse,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import "reflect-metadata";

title("A broadcast channel behind @Sse()");

/** `@SseSignal()` where this Nest has it (11.2.0 and later); a no-op before. */
const SseSignal =
  ((common as unknown as Record<string, unknown>).SseSignal as
    (() => ParameterDecorator) | undefined) ?? (() => () => undefined);

let price = 100;
const prices = createSseChannel({
  initial: () => [{ event: "snapshot", data: { price } }],
  replay: 20,
});

@Controller("prices")
class PricesController {
  @Sse()
  stream(
    @Headers("last-event-id") lastEventId?: string,
    @SseSignal() signal?: AbortSignal,
  ): Observable<MessageEvent> {
    return channelObservable(prices, { lastEventId, signal });
  }

  /** The byte path: one encode per event for every client. */
  @Get("bytes")
  bytes(@Req() req: BunRequest, @Res() res: BunResponse): void {
    prices.subscribe(req, res);
  }
}

@Module({ controllers: [PricesController] })
class AppModule {}

const app = await NestFactory.create(AppModule, new BunHttpAdapter(0), {
  logger: false,
});
await app.listen(0, "127.0.0.1");
const url = await app.getUrl();

/** The next `count` events of a response, as `[name, data, id]`, and a way to leave. */
function client(response: Response) {
  const iterator = readSse(response.body!)[Symbol.asyncIterator]();
  return {
    async next(count: number): Promise<[string, string, string][]> {
      const out: [string, string, string][] = [];
      while (out.length < count) {
        const item = await iterator.next();
        if (item.done) break;
        if (item.value.kind === "event") {
          out.push([item.value.event, item.value.data, item.value.id]);
        }
      }
      return out;
    },
    async leave(): Promise<void> {
      await iterator.return?.();
    },
  };
}

/* ------------------------------------------------------------------ */
step("@Sse() with channelObservable(): the snapshot, then live events");

const nest = client(await fetch(`${url}/prices`));
const bytes = client(await fetch(`${url}/prices/bytes`));
await waitFor("both subscribed", () => prices.size === 2);
const [[snapshotName, snapshotData, snapshotId]] = await nest.next(1);
checkEqual(
  "@Sse(): the snapshot first, numbered by Nest",
  [snapshotName, snapshotData, snapshotId],
  ["snapshot", '{"price":100}', "1"],
);
checkEqual("@Res(): the same snapshot, no id", await bytes.next(1), [
  ["snapshot", '{"price":100}', ""],
]);

price = 101;
checkEqual(
  "one send() reaches both",
  prices.send({ event: "tick", data: { price } }),
  2,
);
const [tick] = await nest.next(1);
show("@Sse() got", tick);
checkEqual(
  "…the channel's id passes through Nest",
  (await bytes.next(1))[0]?.[2],
  tick?.[2],
);

/* ------------------------------------------------------------------ */
step("Reconnecting with Last-Event-ID");

await nest.leave();
await waitFor("the @Sse() client gone", () => prices.size === 1);
price = 102;
prices.send({ event: "tick", data: { price } });
const again = client(
  await fetch(`${url}/prices`, {
    headers: { "Last-Event-ID": tick?.[2] ?? "" },
  }),
);
checkEqual(
  "what it missed, and no snapshot",
  (await again.next(1)).map(([name, data]) => [name, data]),
  [["tick", '{"price":102}']],
);
await again.leave();
await bytes.leave();
await waitFor("every client gone", () => prices.size === 0);

prices.close();
await app.close();
summary();
