/**
 * A Nest application on bun-nest with one echo gateway, for
 * `websocketDeepPayload.nest.test.ts`, which runs it as a child process: an
 * error that escapes to the event loop ends this process, which is what the
 * test watches for. It prints `PORT <n>` once listening and runs until
 * killed. Run it from the package directory: Bun reads the decorator options
 * from the working directory's `tsconfig.json`.
 *
 * `reflect-metadata` is imported last per the import-sort rule; it still
 * executes before the gateway class body (and its decorators) runs.
 */
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { BunHttpAdapter } from "../../../lib";
import "reflect-metadata";

@WebSocketGateway()
class EchoGateway {
  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }
}

@Module({ providers: [EchoGateway] })
class AppModule {}

async function main(): Promise<void> {
  const adapter = new BunHttpAdapter();
  const app = await NestFactory.create(AppModule, adapter, {
    logger: ["error"],
  });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  await app.listen(0, "127.0.0.1");
  process.stdout.write(`PORT ${adapter.listeningPort}\n`);
}

void main();
