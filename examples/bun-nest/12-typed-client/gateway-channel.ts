/**
 * A gateway's typed channel — a Nest `@WebSocketGateway` with
 * `@ValidateMessage` and `@Emits`, and bun-client's `channel()` with
 * `codec: "bun-nest"` speaking the adapter's socket.io-style packets. The
 * client is typed two ways: from the descriptor `bun-client generate` writes
 * from the gateway's AsyncAPI document, and, in a monorepo, from the same
 * shared maps the decorators take. Each step is asserted.
 *
 * ```bash
 * bun 12-typed-client/gateway-channel.ts   # from examples/bun-nest
 * ```
 *
 * - **`request()` resolves with the handler's ack**, typed by
 *   `@ValidateMessage(Say, { ack: SayAck })`'s `ack` schema (a sent type of
 *   its own, `"say ack"`, which `replies` maps `say` to). `send()` is an
 *   `EVENT`; a gateway `@Emits` event arrives as a typed push.
 * - **The generated descriptor** (`channels["/chat"]` in `helpers/api.gen.ts`)
 *   names its codec, so `channel(api, channels["/chat"])` needs no option;
 *   the generated zod module is the client's `schemas`.
 * - **The shared contract** (`helpers/chat.shared.ts`: zod and the contract
 *   core, never the gateway) is what the gateway's decorators and the client
 *   both import, so neither can drift from the other.
 * - **A refused payload**: the client's checks refuse it before the write; with
 *   them off, the gateway's `ValidationExceptionFilter` answers an `exception`
 *   event, which the client raises as a `ChannelError` on `$error`.
 */
import { createClient, ValidationError } from "@kingsleyweb/bun-client";
import { channel } from "@kingsleyweb/bun-client/channel";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { createApp, store } from "./helpers/app";
import { channels } from "./helpers/api.gen";
import type { Channels } from "./helpers/api.gen";
import { chat } from "./helpers/chat.shared";
import "reflect-metadata";

title("A gateway's typed channel (the bun-nest codec)");

store.reset();
const { app, adapter } = await createApp();
await app.listen(0);
const api = createClient({
  baseUrl: `http://127.0.0.1:${adapter.listeningPort}`,
  mode: "development",
  // The generated zod module checks what the descriptor's channel sends and receives.
  schemas: () => import("./helpers/api.zod.gen"),
});

const closers: (() => void)[] = [];

try {
  /* ---------------------------------------------------------------- */
  step("From the generated descriptor: a request, its ack and a push");

  // No `codec` option: the descriptor names "bun-nest".
  const generated = channel(api, channels["/chat"]);
  closers.push(() => generated.close());
  const pushes: { by: string; text: string }[] = [];
  generated.on("said", (data) => void pushes.push(data));

  const ack = await generated.request("say", { text: "hello" });
  // The ack's type is the one the document names `say ack`.
  const typed: Channels["/chat"]["sends"]["say ack"] = ack;
  show("ack", typed);
  checkEqual("request() resolves the handler's ack, typed by SayAck", ack, {
    ok: true,
    length: 5,
  });
  await waitFor("the @Emits push", () => pushes.length === 1);
  checkEqual("the gateway's `said` event arrived as a typed push", pushes, [
    { by: "gateway", text: "hello" },
  ]);
  checkEqual("the handler ran once", store.said, ["hello"]);

  /* ---------------------------------------------------------------- */
  step("From the shared maps: the very schemas the gateway's decorators take");

  const shared = channel(api, chat, {
    codec: "bun-nest",
    query: { as: "shared" },
  });
  closers.push(() => shared.close());
  const sharedAck = await shared.request("say", { text: "monorepo" });
  checkEqual("the same ack through the shared contract", sharedAck, {
    ok: true,
    length: 8,
  });

  const typing: string[] = [];
  shared.on("typing", () => void typing.push("typing"));
  shared.send("typing"); // a data-less event
  await waitFor("the data-less push", () => typing.length === 1);
  checkEqual("a data-less event round trips", typing, ["typing"]);

  /* ---------------------------------------------------------------- */
  step("A payload the contract refuses");

  const before = store.said.length;
  let refused: unknown;
  try {
    shared.send("say", { text: "" });
  } catch (error) {
    refused = error;
  }
  check(
    "the client refuses it before the write (ValidationError)",
    refused instanceof ValidationError,
    refused,
  );
  await Bun.sleep(50);
  checkEqual("the gateway received nothing", store.said.length, before);

  // With the client's checks off, the gateway's own @ValidateMessage refuses it.
  const unchecked = channel(api, chat, {
    codec: "bun-nest",
    query: { as: "unchecked" },
    validate: false,
  });
  closers.push(() => unchecked.close());
  const errors: { code?: string; status?: number }[] = [];
  unchecked.on(
    "$error",
    (error) => void errors.push(error as { code?: string; status?: number }),
  );
  unchecked.send("say", { text: "" });
  await waitFor("the gateway's exception event", () => errors.length === 1);
  show("$error", { code: errors[0]?.code, status: errors[0]?.status });
  checkEqual(
    "the gateway's VALIDATION exception reached $error",
    [errors[0]?.code, errors[0]?.status],
    ["VALIDATION", 400],
  );
  checkEqual("and the handler still did not run", store.said.length, before);

  /* ---------------------------------------------------------------- */
  step("The type-level half");

  const refusedByTypes = async (): Promise<void> => {
    // @ts-expect-error -- "shout" is not an event the gateway handles
    generated.send("shout", { text: "hi" });
    // @ts-expect-error -- `text` is a string
    await generated.request("say", { text: 7 });
    // @ts-expect-error -- `typing` has no ack in `replies`, so it cannot be requested
    await shared.request("typing");
    // @ts-expect-error -- a `said` push is { by, text }, not a number
    generated.on("said", (data: number) => void data);
  };
  void refusedByTypes;
  show("four refusals at compile time (see the source)");
} finally {
  for (const close of closers) close();
  await app.close();
}

summary();
