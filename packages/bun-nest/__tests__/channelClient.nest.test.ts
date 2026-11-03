/**
 * bun-client's `"bun-nest"` codec (typed-client `websocket.md` §11, §12,
 * PR-W3) against a real gateway (`./fixtures/nest-channel/app.ts`) on
 * bun-nest's adapters, port 0, the client and the server in one process.
 *
 * - **Generated**: the map `bun-client generate` writes from the gateway's
 *   `gatewayAsyncApi()` document (`chat.gen.ts`, golden) types `request()`
 *   by `@ValidateMessage`'s `ack` schema, the operation's reply; a live ack
 *   is checked against that type (under `bun test --check`) and, at run
 *   time, by the generated zod (`chat.zod.gen.ts`).
 * - **Shared maps** (NTR §7): the client opens the very `channelContract()`
 *   whose schemas the gateway's decorators take (`chat.shared.ts`).
 * - The wire: a request is an `EVENT` with an id answered by the gateway's
 *   `ACK`, matched by id (control: two requests answered out of order); a
 *   data-less event; pushes (`@Emits`); bytes both ways (`BINARY_EVENT`); a
 *   refused payload (`ValidationExceptionFilter`'s `exception`) on
 *   `$error`; a `WsException` as the `exception` push; an ack arriving after
 *   its request timed out, ignored.
 *
 * `reflect-metadata` is imported last per the import-sort rule.
 */
import type { INestApplication } from "@nestjs/common";
import type { Channels } from "./fixtures/nest-channel/chat.gen";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createClient, ValidationError } from "@kingsleyweb/bun-client";
import {
  channel,
  ChannelError,
  RequestTimeoutError,
} from "@kingsleyweb/bun-client/channel";
import { generateRoutes, loadDocuments } from "@kingsleyweb/bun-client/codegen";
import { z } from "zod";
import documents, { createChatApp, said } from "./fixtures/nest-channel/app";
import { chat } from "./fixtures/nest-channel/chat.shared";
import { channels } from "./fixtures/nest-channel/chat.gen";
import "reflect-metadata";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

const FIXTURES = join(import.meta.dir, "fixtures", "nest-channel");

/** Polls `predicate` until true, or fails after `timeoutMs`. */
async function until(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

let app: INestApplication;
let port: number;

beforeAll(async () => {
  const built = await createChatApp();
  app = built.app;
  await app.listen(0);
  port = Number(built.adapter.listeningPort);
});

afterAll(async () => {
  await app?.close();
});

const handles: { close: () => void }[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  said.length = 0;
});

/** Keeps `handle` for the cleanup. */
function kept<C extends { close: () => void }>(handle: C): C {
  handles.push(handle);
  return handle;
}

/** A client of the gateway, its warnings collected; `zod` loads the generated schemas. */
function clientOf(zod = false) {
  const warnings: string[] = [];
  const api = createClient({
    baseUrl: `http://127.0.0.1:${port}`,
    mode: "development",
    logger: {
      warn: (message: unknown) => void warnings.push(String(message)),
      error: (...args: unknown[]) => void warnings.push(args.join(" ")),
      debug: () => {},
    },
    ...(zod
      ? { schemas: () => import("./fixtures/nest-channel/chat.zod.gen") }
      : {}),
  });
  return { api, warnings };
}

describe('the "bun-nest" codec: a generated map', () => {
  it("the golden is what the generator writes from gatewayAsyncApi()", async () => {
    const loaded = await loadDocuments({ module: join(FIXTURES, "app.ts") });
    const result = generateRoutes(loaded.openapi, {
      asyncapi: loaded.asyncapi!,
      documentWarnings: loaded.warnings,
      zod: { routesModule: "./chat.gen" },
    });
    expect(result.code).toBe(
      await Bun.file(join(FIXTURES, "chat.gen.ts")).text(),
    );
    expect(result.zod!.code).toBe(
      await Bun.file(join(FIXTURES, "chat.zod.gen.ts")).text(),
    );
    expect(result.channels).toBe(1);
    expect(result.warnings).toEqual([]);
    // The documents are the app's own: the module boots and closes it.
    const { asyncapi } = await documents();
    expect(Object.keys((asyncapi as { channels: object }).channels)).toEqual([
      "chat",
    ]);
  });

  it("request() resolves with the gateway's ack, typed and checked by the generated schemas", async () => {
    const { api, warnings } = clientOf(true);
    // No `codec` option: the descriptor names `"bun-nest"`.
    const room = kept(channel(api, channels["/chat"]));
    const ack = await room.request("say", { text: "hello" });
    type Ack = Channels["/chat"]["sends"]["say ack"];
    type _ack = Expect<Equal<typeof ack, Ack>>;
    type _shape = Expect<Equal<Ack, { ok: boolean; length: number }>>;
    expect(ack).toEqual({ ok: true, length: 5 });
    expect(said).toEqual(["hello"]);
    expect(warnings).toEqual([]);
  });

  it("the ack goes through the receive checks (control: a stricter BYO schema refuses it)", async () => {
    const { api } = clientOf(true);
    const room = kept(
      channel(api, channels["/chat"], {
        validate: {
          receive: {
            "say ack": {
              custom: z.looseObject({ length: z.number().max(3) }),
            },
          },
          onFailure: { receive: "throw" },
        },
      }),
    );
    const refused = await room
      .request("say", { text: "hello" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as ValidationError).direction).toBe("receive");
    expect(await room.request("say", { text: "hi" })).toEqual({
      ok: true,
      length: 2,
    });
  });

  it("each request resolves with the ack of its own id (control: answered out of order)", async () => {
    const { api } = clientOf(true);
    const room = kept(channel(api, channels["/chat"]));
    const order: string[] = [];
    const slow = room
      .request("say", { text: "slow one" })
      .then((ack) => void order.push(`slow:${ack.length}`));
    const fast = room
      .request("say", { text: "fast" })
      .then((ack) => void order.push(`fast:${ack.length}`));
    await Promise.all([slow, fast]);
    expect(order).toEqual(["fast:4", "slow:8"]);
  });

  it("pushes: an @Emits event with data, a data-less one", async () => {
    const { api, warnings } = clientOf(true);
    const room = kept(channel(api, channels["/chat"]));
    const pushes: unknown[] = [];
    room.on("said", (data) => void pushes.push(data));
    room.on("typing", (data) => void pushes.push(["typing", data]));
    room.send("typing");
    await room.request("say", { text: "yo" });
    await until(() => pushes.length === 2);
    expect(pushes).toEqual([
      ["typing", undefined],
      { by: "gateway", text: "yo" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("a WsException is the `exception` push, typed by the document", async () => {
    const { api } = clientOf(true);
    const room = kept(channel(api, channels["/chat"]));
    const seen: { status: "error"; message: string }[] = [];
    room.on("exception", (data) => void seen.push(data));
    room.send("fail");
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({
      status: "error",
      message: "refused by the gateway",
    });
  });

  it("a payload the gateway refuses is a ChannelError on $error; the request, never acked, times out", async () => {
    const { api } = clientOf(true);
    const room = kept(channel(api, channels["/chat"]));
    const errors: unknown[] = [];
    room.on("$error", (error) => void errors.push(error));
    const outcome = await room
      .request("say", { text: "" }, { validate: false, timeout: 300 })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(RequestTimeoutError);
    expect(errors).toHaveLength(1);
    const error = errors[0] as ChannelError;
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.code).toBe("VALIDATION");
    expect(error.status).toBe(400);
    expect(error.issues).toEqual([
      expect.objectContaining({ target: "payload", path: "text" }),
    ]);
    expect(said).toEqual([]);
  });

  it("an ack arriving after its request timed out is ignored", async () => {
    const { api, warnings } = clientOf(true);
    const room = kept(channel(api, channels["/chat"]));
    const pushes: unknown[] = [];
    room.on("said", (data) => void pushes.push(data));
    const late = await room
      .request("say", { text: "late" }, { timeout: 50 })
      .catch((error: unknown) => error);
    expect(late).toBeInstanceOf(RequestTimeoutError);
    // The gateway's push comes just before its (now unmatched) ack.
    await until(() => pushes.length === 1);
    await Bun.sleep(30);
    expect(await room.request("say", { text: "next" })).toEqual({
      ok: true,
      length: 4,
    });
    expect(warnings).toEqual([]);
  });
});

describe('the "bun-nest" codec: the shared maps (NTR §7)', () => {
  it("the client opens the contract the gateway's decorators take", async () => {
    const { api, warnings } = clientOf();
    const room = kept(channel(api, chat, { codec: "bun-nest" }));
    const ack = await room.request("say", { text: "shared" });
    type _ack = Expect<Equal<typeof ack, { ok: boolean; length: number }>>;
    expect(ack).toEqual({ ok: true, length: 6 });
    // The gateway's own schema refuses what the client's refuses.
    expect(() => room.send("say", { text: "" })).toThrow(ValidationError);
    expect(warnings).toEqual([]);
  });

  it("bytes travel as BINARY_EVENTs both ways", async () => {
    const { api, warnings } = clientOf();
    const room = kept(channel(api, chat, { codec: "bun-nest" }));
    const received: Uint8Array[] = [];
    room.on("uploaded", (data) => void received.push(data as Uint8Array));
    room.send("upload", new Uint8Array([1, 2, 3, 250]));
    await until(() => received.length === 1);
    expect(received[0]).toBeInstanceOf(Uint8Array);
    expect([...received[0]]).toEqual([250, 3, 2, 1]);
    expect(warnings).toEqual([]);
  });
});
