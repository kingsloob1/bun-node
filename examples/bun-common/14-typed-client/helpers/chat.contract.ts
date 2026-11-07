/**
 * The chat channel's contract: a browser-safe module (zod and the contract
 * core, nothing of a server) that the server passes to `defineChannel()` and
 * the client to `channel()`. A helper, not an example.
 */
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

/** A line of chat. */
export const Line = z.object({ by: z.string(), text: z.string() });

/** The room's contract: both sides keyed by the message `type`, one part, `data`. */
export const chat = channelContract({
  path: "/rooms/:room",
  // Client → server. `typing` carries no data.
  receives: {
    say: z.object({ text: z.string().min(1).max(200) }),
    typing: null,
  },
  // Server → client.
  sends: { said: Line, someoneTyping: z.object({ by: z.string() }) },
  // `say` is answered with `said`, echoing the request's id.
  replies: { say: "said" },
});
