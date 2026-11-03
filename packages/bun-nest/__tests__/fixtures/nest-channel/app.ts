/**
 * The gateway the `"bun-nest"` codec is tested against
 * (`__tests__/channelClient.nest.test.ts`, typed-client `websocket.md` §11,
 * PR-W3), its schemas taken from the shared maps (`./chat.shared.ts`, NTR
 * §7).
 *
 * Its default export documents the app with no server, so the client's
 * generator reads it as a module; `chat.gen.ts` and `chat.zod.gen.ts` are
 * what it writes, regenerated from the bun-nest package directory with:
 *
 * ```bash
 * bun ../bun-client/lib/codegen/cli.ts generate --module __tests__/fixtures/nest-channel/app.ts --out __tests__/fixtures/nest-channel/chat.gen.ts --zod __tests__/fixtures/nest-channel/chat.zod.gen.ts
 * ```
 *
 * (from bun-nest's directory: Bun reads the decorator options from the
 * working directory's `tsconfig.json`, oven-sh/bun#28605).
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { TypedSocket } from "../../../lib";
import { Buffer } from "node:buffer";
import { Module, UseFilters } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import {
  BunHttpAdapter,
  Emits,
  gatewayAsyncApi,
  ValidateMessage,
  ValidationExceptionFilter,
} from "../../../lib";
import { chatEmits, Say, SayAck } from "./chat.shared";
import "reflect-metadata";

/** The `say` texts the gateway handled, in order. */
export const said: string[] = [];

/** A chat gateway: an acked event, a data-less one, a failing one and bytes. */
@WebSocketGateway({ path: "/chat" })
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)
export class ChatGateway {
  /** Acks with the text's length; `slow…` answers after 60 ms, `late` after 400 ms. */
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  async say(
    @MessageBody() msg: { text: string },
    @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
  ) {
    said.push(msg.text);
    if (msg.text.startsWith("slow")) await Bun.sleep(60);
    if (msg.text === "late") await Bun.sleep(400);
    socket.emit("said", { by: "gateway", text: msg.text });
    return { ok: true, length: msg.text.length };
  }

  /** Echoes a data-less `typing` event. */
  @SubscribeMessage("typing")
  typing(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    socket.emit("typing");
  }

  /** Throws a `WsException`: Nest's `exception` event. */
  @SubscribeMessage("fail")
  fail() {
    throw new WsException("refused by the gateway");
  }

  /** Answers bytes with the bytes reversed (a `BINARY_EVENT` each way); anything else is refused. */
  @SubscribeMessage("upload")
  upload(@MessageBody() bytes: unknown) {
    if (!(bytes instanceof Uint8Array)) throw new WsException("not bytes");
    return { event: "uploaded", data: Buffer.from([...bytes].reverse()) };
  }
}

/** The app module. */
@Module({ providers: [ChatGateway] })
class ChatModule {}

/** Builds the app on bun-nest's adapters (not listening yet). */
export async function createChatApp(): Promise<{
  app: INestApplication;
  adapter: BunHttpAdapter;
}> {
  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(ChatModule, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  return { app, adapter };
}

/** The app's documents, for `bun-client generate --module` (no server is left running). */
export default async function documents(): Promise<{
  openapi: object;
  asyncapi: object;
}> {
  const { app, adapter } = await createChatApp();
  await app.init();
  try {
    const info = { title: "Chat", version: "1.0.0" };
    return {
      openapi: generateOpenApi(adapter.instance, info).document,
      asyncapi: gatewayAsyncApi(app, info).document,
    };
  } finally {
    await app.close();
  }
}
