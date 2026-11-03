/**
 * The channel generator's fixture contracts (typed-client `websocket.md`
 * §3.1, §12, PR-W2): the browser-safe half both sides import. `channels.ts`
 * serves them; `channels.gen.ts` is what `bun-client generate --module
 * channels.ts` writes from its AsyncAPI document, and
 * `__tests__/channel.type-test.ts` checks the generated `Channels` entries
 * `Equal` to these contracts inferred.
 *
 * JSON-expressible schemas only (no coercion, no `z.date()`), so the two
 * agree exactly: what JSON Schema drops is TC §5.3's, pinned elsewhere.
 */
import { channelContract } from "@kingsleyweb/bun-common/contract";
import { z } from "zod";

/** A chat room: path params, a query, a data-less message, replies, a custom id field and a subprotocol. */
export const room = channelContract({
  path: "/rooms/:room",
  request: {
    params: z.object({ room: z.string().regex(/^[a-z]+$/) }),
    query: z.object({
      name: z.string(),
      lang: z.enum(["en", "fr"]).optional(),
    }),
  },
  receives: {
    say: z.object({
      text: z.string().min(1),
      tags: z.array(z.string()).optional(),
    }),
    typing: null,
    join: z.object({
      as: z.object({ name: z.string(), age: z.number().int().nullable() }),
    }),
  },
  sends: {
    said: z.object({
      by: z.string(),
      text: z.string(),
      level: z.enum(["info", "warn"]),
    }),
    joined: z.object({ count: z.number() }),
    left: null,
  },
  replies: { say: "said", join: "joined" },
  envelope: { idField: "rid" },
  subprotocol: "room.v1",
  meta: { name: "room", description: "A chat room." },
});

/** A channel with no params and no replies. */
export const ticker = channelContract({
  path: "/ticker",
  receives: { watch: z.object({ symbols: z.array(z.string()) }) },
  sends: { tick: z.object({ symbol: z.string(), price: z.number() }) },
});
