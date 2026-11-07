/**
 * The shared maps: the one browser-safe module both halves import. The
 * gateway passes these schemas to its decorators (`@ValidateMessage(Say, {
 * ack: SayAck })`, `@Emits(chatEmits)`, `TypedSocket<typeof chatEmits>`); a
 * client in the same repository opens `chat` with `codec: "bun-nest"` and is
 * typed and checked by the very schemas the gateway checks with. It imports
 * zod and the contract core, never the gateway. A helper, not an example.
 *
 * The ack is a sent type of its own (`"say ack"`, the name
 * `gatewayAsyncApi()` gives it, so a generated map agrees), and `replies`
 * maps the event to it: `request("say", …)` resolves with the ack.
 */
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

/** `say`'s payload (client → server). */
export const Say = z.object({ text: z.string().min(1) });

/** `say`'s ack: what the handler returns, checked against it. */
export const SayAck = z.object({ ok: z.boolean(), length: z.number().int() });

/** The gateway's server → client events: `@Emits` and `TypedSocket` take this map. */
export const chatEmits = {
  said: z.object({ by: z.string(), text: z.string() }),
  typing: null,
} as const;

/** The channel as the client reads it: the gateway's path, both sides, the ack as a reply. */
export const chat = channelContract({
  path: "/chat",
  receives: { say: Say, typing: null },
  sends: { ...chatEmits, "say ack": SayAck },
  replies: { say: "say ack" },
});
