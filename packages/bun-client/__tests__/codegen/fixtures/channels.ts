/**
 * The channel generator's fixture app (typed-client `websocket.md` §3,
 * PR-W2): the contracts of `channels.contract.ts` served with
 * `defineChannel(contract)`, plus one HTTP route. `bun-client generate
 * --module channels.ts` writes `channels.gen.ts` (and with `--zod`,
 * `channels.zod.gen.ts`) from its documents.
 */
import {
  BunRouter,
  BunWebSocket,
  defineChannel,
} from "@kingsleyweb/bun-common";
import { room, ticker } from "./channels.contract";

const router = new BunRouter();
// Generation never binds: a socket with no server.
router.setBunWebSocket(
  new BunWebSocket({ newInstance: false, getServer: () => undefined, router }),
);
const roomChannel = defineChannel(room);
router.ws(
  roomChannel.path,
  roomChannel.checks(),
  roomChannel.handler({}),
  roomChannel.options(),
);
const tickerChannel = defineChannel(ticker);
router.ws(
  tickerChannel.path,
  tickerChannel.checks(),
  tickerChannel.handler({}),
  tickerChannel.options(),
);
router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

export default router;
