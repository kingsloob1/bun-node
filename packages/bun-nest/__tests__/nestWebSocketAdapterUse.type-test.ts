/**
 * Compile-time assertions that the adapters hand straight to NestJS with no
 * cast: `NestFactory.create()` takes a `BunHttpAdapter`,
 * `app.useWebSocketAdapter()` takes its `webSocketAdapter` or a
 * `BunWebSocketAdapter` built beside it, and the router's installed
 * `BunWebSocket` compares against the adapter that replaced it. Examples and
 * tests once wrote `as never` at every one of these sites. The adapter types
 * never needed it; what the casts hid was `getInstance()` inheriting NestJS's
 * `getInstance<T = any>()`, so the comparison was against `any` and checked
 * nothing. It now returns the `BunRouter`. Checked by `tsc`, not `bun test`;
 * runtime coverage is in `httpAdapter.test.ts` and the `*.nest.test.ts` suites.
 */
import type { BunRouter } from "@kingsleyweb/bun-common";
import type { INestApplication } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunWebSocketAdapter } from "../lib/BunWebSocketAdapter";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** Client data a typed adapter declares, to check the generic path too. */
interface Session {
  /** The room the client joined. */
  room: string;
}

@Module({})
class AppModule {}

/** Never called: the body only has to typecheck. */
export async function _useAdapters(swap: boolean) {
  const adapter = new BunHttpAdapter();
  // `NestFactory.create()` takes the HTTP adapter as is.
  const app: INestApplication = await NestFactory.create(AppModule, adapter, {
    logger: false,
  });

  // The HTTP adapter's own WebSocket adapter.
  app.useWebSocketAdapter(adapter.webSocketAdapter);

  // One built beside it, on the shared server or a port of its own.
  const swapped = new BunWebSocketAdapter({ httpAdapter: adapter });
  app.useWebSocketAdapter(swapped);
  app.useWebSocketAdapter(
    new BunWebSocketAdapter({
      httpAdapter: adapter,
      newInstance: true,
      listen: { port: 0 },
    }),
  );

  // Either one, chosen at runtime.
  app.useWebSocketAdapter(swap ? swapped : adapter.webSocketAdapter);

  // `getInstance()` is the router, not NestJS's default `any`; an explicit
  // type argument still asserts another type.
  const _instanceValue = adapter.getInstance();
  type _instance = Expect<Equal<typeof _instanceValue, BunRouter>>;
  const _explicit: { custom: true } = adapter.getInstance<{ custom: true }>();

  // The installed BunWebSocket compares against the adapter that replaced it.
  const _replaced: boolean =
    adapter.getInstance().getBunWebsocket() === swapped;

  // A typed adapter's generics do not get in the way.
  const typed = new BunHttpAdapter<Session>();
  const typedApp = await NestFactory.create(AppModule, typed);
  typedApp.useWebSocketAdapter(typed.webSocketAdapter);
  typedApp.useWebSocketAdapter(
    new BunWebSocketAdapter<Session>({ httpAdapter: typed }),
  );

  // --- negative controls: each line must be an error --------------------

  // Not a WebSocket adapter: no `create`, `bindClientConnect`, ...
  // @ts-expect-error a plain object is not a Nest WebSocketAdapter
  app.useWebSocketAdapter({ close: () => undefined });

  // The HTTP adapter is not its WebSocket adapter.
  // @ts-expect-error BunHttpAdapter is not a Nest WebSocketAdapter
  app.useWebSocketAdapter(adapter);

  // A comparison with no overlap is still caught.
  // @ts-expect-error a BunWebSocket and a string never compare equal
  const _never: boolean = adapter.getInstance().getBunWebsocket() === "ws";

  // `getInstance()` no longer accepts calls the router does not have.
  // @ts-expect-error BunRouter has no `notARouterMethod`
  adapter.getInstance().notARouterMethod();

  return { _replaced, _explicit, _never };
}
