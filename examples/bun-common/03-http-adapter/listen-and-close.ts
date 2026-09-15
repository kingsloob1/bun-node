/**
 * Listening and closing — every `listen()` overload, the address getters,
 * `setListenOptions()`, the `listening` / `close` events, and what `close()`
 * releases.
 *
 * ```bash
 * bun 03-http-adapter/listen-and-close.ts
 * ```
 *
 * - `listen(port)`, `listen(port, callback)`, `listen(port, hostname)` and
 *   `listen(port, hostname, callback)` all resolve with the `Bun.serve` server,
 *   and call the callback with it.
 * - The hostname is anything `Bun.serve` accepts — an IP literal,
 *   `"localhost"`, a name — and defaults to `127.0.0.1`.
 * - A busy port is an error: `listen()` rejects rather than binding somewhere
 *   else, as `node:http` does.
 * - `listen()` binds TCP only; there is no unix-socket form.
 * - `close()` force-closes (`server.stop(true)`), so a keep-alive connection
 *   cannot keep answering from a stopped server. Routes and the error and
 *   not-found handlers survive it, so the adapter can listen again as it was.
 */
import type { BunServer, WebSocketClientData } from "@kingsleyweb/bun-common";
import { BunHttpAdapter, noopLogger } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Listening and closing");

const adapter = new BunHttpAdapter();
adapter.get("/", (_req, res) => res.send("hello"));
adapter.setNotFoundHandler((_req, res) => {
  res.status(404).send("custom not found");
});

const events: string[] = [];
// `eventEmitter` is an untyped EventEmitter, so the payload is named here.
adapter.eventEmitter.on(
  "listening",
  (server: BunServer<WebSocketClientData>) => {
    events.push(`listening on ${server.port}`);
  },
);
adapter.eventEmitter.on("close", () => {
  events.push("close");
});

/* ------------------------------------------------------------------ */
step("listen(0): an OS-assigned port");

show("before — isListening", adapter.isListening);
show("before — init()", (await adapter.init()) ?? "undefined");

const server = await adapter.listen(0);
show("resolved with the Bun server, on port", server.port);
show(
  "listeningHost:listeningPort",
  `${adapter.listeningHost}:${adapter.listeningPort}`,
);
show("url", adapter.url);
show("getListenAddress()", (await adapter.getListenAddress()).href);
show("address()", adapter.address());
show("isListening, listening", [adapter.isListening, adapter.listening]);
show(
  "server, getBunServer() and init() are the same server",
  adapter.server === server &&
    adapter.getBunServer() === server &&
    (await adapter.init()) === server,
);
show("events so far", events);

const hello = await fetch(adapter.url);
show("GET /", `${hello.status} ${await hello.text()}`);

/* ------------------------------------------------------------------ */
step("listen() on the address it already has is a no-op");

const again = await adapter.listen(
  adapter.listeningPort,
  "127.0.0.1",
  (same) => {
    show("the callback still runs, with the running server", same === server);
  },
);
show("the same server came back", again === server);
show("…and no second listening event", events.length);

/* ------------------------------------------------------------------ */
step("listen(port, callback) and listen(port, hostname)");

const withCallback = new BunHttpAdapter();
let handedTo: BunServer<WebSocketClientData> | undefined;
await withCallback.listen(0, (listening) => {
  handedTo = listening;
});
show("the callback was handed the server", handedTo === withCallback.server);

const byName = new BunHttpAdapter();
await byName.listen(0, "localhost");
show('asked for "localhost", bound', byName.listeningHost);

/* ------------------------------------------------------------------ */
step("A busy port is an error");

const blocker = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => new Response("someone else"),
});
// A quiet logger: the adapter logs the bind failure before rejecting.
const displaced = new BunHttpAdapter(0, { logger: noopLogger });
try {
  await displaced.listen(blocker.port!, "127.0.0.1");
  show(`asked for ${blocker.port}, bound`, displaced.listeningPort);
} catch (error) {
  show(`asked for ${blocker.port}: rejected`, (error as Error).message);
}
await blocker.stop(true);

/* ------------------------------------------------------------------ */
step("setListenOptions(): port, hostname and Bun.serve options together");

const tuned = new BunHttpAdapter();
tuned.get("/", (_req, res) => res.send("tuned"));
await tuned.setListenOptions({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 5,
});
const tunedResponse = await fetch(tuned.url);
show(`GET ${tuned.url}`, await tunedResponse.text());

/* ------------------------------------------------------------------ */
step("nodeHttpServer(): a node:http-shaped view of the adapter");

// For code written against node's http.Server — `on`/`once` reach the
// adapter's eventEmitter, and other properties read through to the adapter.
const nodeView = adapter.nodeHttpServer();
show("the same proxy every call", nodeView === adapter.initNodeHttpServer());
show("listening, read through it", nodeView.listening);
nodeView.once("close", () => {
  events.push("close (heard through nodeHttpServer())");
});

/* ------------------------------------------------------------------ */
step("close()");

const oldUrl = adapter.url;
// A response read to the end leaves its keep-alive connection pooled.
await (await fetch(oldUrl)).text();

await adapter.close();
show("isListening", adapter.isListening);
show("events", events);

try {
  const stale = await fetch(oldUrl);
  show("the old address still answered", stale.status);
} catch (error) {
  show("the old address refuses connections", (error as Error).message);
}

const afterClose = await adapter.fetch("/missing");
show(
  "routes and the not-found handler survive close()",
  `${afterClose.status} "${await afterClose.text()}"`,
);

await adapter.listen(0);
show("listening again, on a new port", adapter.listeningPort);

for (const open of [adapter, withCallback, byName, displaced, tuned]) {
  await open.close();
}
show(
  "all closed",
  [adapter, withCallback, byName, displaced, tuned].every(
    (a) => !a.isListening,
  ),
);
