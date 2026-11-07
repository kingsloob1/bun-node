/**
 * The Nest app the `12-typed-client` examples share: a controller with
 * `@Validate`, `@Describe` and `@Invalidates`, a gateway on the shared maps,
 * and optionally `DevTypesModule` and bun-common's `liveInvalidation()`. A
 * helper, not an example: `run-all.ts` skips this folder.
 *
 * Its default export documents the app with no server left running, which is
 * what `bun-client generate --module` reads; `api.gen.ts` and
 * `api.zod.gen.ts` beside it are committed output of (from
 * `examples/bun-nest`, because Bun reads the decorator options from the
 * working directory's `tsconfig.json`, oven-sh/bun#28605):
 *
 * ```bash
 * bun run gen:client     # rewrite the two files
 * bun run check:client   # the same with --check: exit 1 when stale
 * ```
 *
 * (`reflect-metadata` is imported last because the import sorter puts
 * side-effect imports there; it still loads before any decorator runs.)
 */
import type { DynamicModule, INestApplication } from "@nestjs/common";
import type { TypedSocket } from "@kingsleyweb/bun-nest";
import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseFilters,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { liveInvalidation } from "@kingsleyweb/bun-common/live";
import {
  BunHttpAdapter,
  Describe,
  DevTypesModule,
  Emits,
  gatewayAsyncApi,
  Invalidates,
  Validate,
  ValidateMessage,
  ValidationExceptionFilter,
} from "@kingsleyweb/bun-nest";
import { z } from "zod";
import { chatEmits, Say, SayAck } from "./chat.shared";
import "reflect-metadata";

/** A user, as the API answers it. */
export const User = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: "User" });

/** The error body a declared error status carries; `.describe({ errors })` narrows `code`. */
export const Problem = z
  .object({ title: z.string(), code: z.string() })
  .meta({ id: "Problem" });

const IdParams = z.object({ id: z.string() });
const NewUser = z.object({ name: z.string().min(1) });

/** The users, and the requests that reached a handler (`"VERB /path"`), shared by every app in the process. */
export const store = {
  users: new Map<string, { id: string; name: string }>(),
  hits: [] as string[],
  said: [] as string[],
  /** Resets the store to Ada and Grace. */
  reset(): void {
    store.users.clear();
    store.users.set("1", { id: "1", name: "Ada" });
    store.users.set("2", { id: "2", name: "Grace" });
    store.hits.length = 0;
    store.said.length = 0;
  },
};
store.reset();

@Controller("users")
export class UsersController {
  @Get()
  @Validate({ responses: { 200: z.array(User) } })
  @Describe({
    summary: "List the users",
    operationId: "listUsers",
    cache: { tags: ["users"] },
  })
  list() {
    store.hits.push("GET /users");
    return [...store.users.values()];
  }

  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
  @Describe({
    summary: "Read one user",
    operationId: "getUser",
    errors: ["NOT_FOUND"], // x-bun-errors: the client's error codes
    cache: { tags: ["user:{id}", "users"] }, // x-bun-cache: what the client files the result under
  })
  one(@Param("id") id: string) {
    store.hits.push(`GET /users/${id}`);
    const user = store.users.get(id);
    if (user === undefined)
      throw new NotFoundException({ title: "No such user", code: "NOT_FOUND" });
    return user;
  }

  @Post()
  @Validate({ body: NewUser, responses: { 201: User } })
  @Describe({
    summary: "Create a user",
    operationId: "createUser",
    cache: { invalidates: ["users"] },
  })
  create(@Body() body: { name: string }) {
    store.hits.push("POST /users");
    const user = { id: String(store.users.size + 1), name: body.name };
    store.users.set(user.id, user);
    return user;
  }

  @Patch(":id")
  @Validate({
    params: IdParams,
    body: NewUser,
    responses: { 200: User, 404: Problem },
  })
  @Describe({
    summary: "Rename a user",
    operationId: "renameUser",
    errors: ["NOT_FOUND"],
  })
  // Published to the live channel when the handler succeeds; the templates are
  // also documented as the route's `cache.invalidates`, so the client's own
  // query layer invalidates them on the call.
  @Invalidates("user:{id}", "users")
  rename(@Param("id") id: string, @Body() body: { name: string }) {
    store.hits.push(`PATCH /users/${id}`);
    const user = store.users.get(id);
    if (user === undefined)
      throw new NotFoundException({ title: "No such user", code: "NOT_FOUND" });
    user.name = body.name;
    return user;
  }
}

@WebSocketGateway({ path: "/chat" })
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)
export class ChatGateway {
  /** Acks with the text's length and pushes a `said` event to the sender. */
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })
  say(
    @MessageBody() msg: { text: string },
    @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
  ) {
    store.said.push(msg.text);
    socket.emit("said", { by: "gateway", text: msg.text });
    return { ok: true, length: msg.text.length };
  }

  /** A data-less event, answered with a data-less push. */
  @SubscribeMessage("typing")
  typing(@ConnectedSocket() socket: TypedSocket<typeof chatEmits>) {
    socket.emit("typing");
  }
}

/** What {@link createApp} can mount. */
export interface AppOptions {
  /** `DevTypesModule.forRoot(...)`'s options: the dev type sync, mounted when given. */
  devTypes?: Parameters<typeof DevTypesModule.forRoot>[0];
  /** Mounts bun-common's `liveInvalidation()` on the adapter first, so `@Invalidates` reaches clients. */
  live?: boolean;
}

/** Builds the app on bun-nest's adapters, not listening yet. */
export async function createApp(
  options: AppOptions = {},
): Promise<{ app: INestApplication; adapter: BunHttpAdapter }> {
  const imports: DynamicModule[] =
    options.devTypes === undefined
      ? []
      : [DevTypesModule.forRoot(options.devTypes)];
  @Module({ imports, controllers: [UsersController], providers: [ChatGateway] })
  class AppModule {}

  const adapter = new BunHttpAdapter(0);
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  // Mounted first: its route source only sees the requests that reach it.
  if (options.live === true) {
    app.use(
      liveInvalidation(adapter.getInstance(), {
        authorize: (_req, _res, next) => next(),
      }),
    );
  }
  return { app, adapter };
}

/** The app's documents, for `bun-client generate --module` (no server is left running). */
export default async function documents(): Promise<{
  openapi: object;
  asyncapi: object;
}> {
  const { app, adapter } = await createApp();
  await app.init();
  try {
    const info = { title: "Users", version: "1.0.0" };
    return {
      openapi: generateOpenApi(adapter.instance, info).document,
      asyncapi: gatewayAsyncApi(app, info).document,
    };
  } finally {
    await app.close();
  }
}
