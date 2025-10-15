import type { BunServer } from "../../lib/index";
import { BunHttpAdapter } from "../../lib/index";

const httpAdapter = new BunHttpAdapter(30000);
httpAdapter.registerParserMiddleware(undefined, true); // Register body parsing middleware
httpAdapter.post("/test", async (req, res) => {
  return res.json(req.body as Record<string, unknown>);
});

httpAdapter.eventEmitter.on("listening", (server: BunServer) => {
  console.log(`Server is listening on =====> `, {
    hostname: server.hostname,
    port: server.port,
  });
});

// eslint-disable-next-line antfu/no-top-level-await
await httpAdapter.listen(10000);
