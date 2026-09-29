/**
 * The prototype end to end, on its own: routes behind `use()` middleware, an
 * error handler, a param route, and a route added after `listen()` — served
 * by Bun's native table (asserted via `nativeStats`), answering exactly what
 * the stock adapter answers through `fetch()`.
 *
 *   BNR_NATIVE=1 bun test docs/plans/evidence/bun-native-routes/prototype/tests/sanity.test.ts
 */
import type { RouterErrorMiddlewareHandler } from "../../../../../../packages/bun-common/lib/types/general";
import net from "node:net";
import { afterAll, expect, it } from "bun:test";
import { BunHttpAdapter as Stock } from "../../../../../../packages/bun-common/lib/BunHttpAdapter";
import { withNativeRoutes } from "../adapter";
import { nativeStats } from "../native-routes";

const Proto = withNativeRoutes(Stock);

function register(app: InstanceType<typeof Stock>) {
  app.use((req, _res, next) => {
    (req as unknown as { trail: string[] }).trail = ["global"];
    next();
  });
  app.use("/api", (req, _res, next) => {
    (req as unknown as { trail: string[] }).trail.push("api");
    next();
  });
  app.get("/api/users/:id", (req, res) => {
    res.json({ id: req.params.id, trail: (req as unknown as { trail: string[] }).trail });
  });
  app.get("/api", (_req, res) => {
    res.send("api-root");
  });
  app.get("/api/users/new", (_req, res) => {
    res.json({ new: true });
  });
  app.get("/boom", () => {
    throw Object.assign(new Error("boom"), { status: 418 });
  });
  app.use(((err, _req, res, _next) => {
    res.status((err as { status?: number }).status ?? 500).json({ caught: (err as Error).message });
  }) satisfies RouterErrorMiddlewareHandler);
  app.get("/skip/:id", (_req, _res, next) => next("route"));
  app.get("/skip/:id", (req, res) => {
    res.send(`second:${req.params.id}`);
  });
}

const native = new Proto(0, {});
native.nativeRoutesEnabled = true;
register(native);
const stock = new Stock(0, {});
register(stock);
const server = await native.listen(0);
afterAll(() => native.close());

const probes = [
  "/api/users/42",
  "/api/users/new",
  "/api/users/a%20b",
  "/api/users/%zz",
  "/api/users/42/",
  "/API/users/42",
  "/boom",
  "/skip/7",
  "/api/users/../users/5",
  "/nope",
];

it.each(probes)("GET %s answers as the stock adapter does", async (path) => {
  const served = await fetch(`${server.url.origin}${path}`);
  const expected = await stock.fetch(path);
  expect(served.status).toBe(expected.status);
  expect(await served.text()).toBe(await expected.text());
});

it("served the matching requests through native routes", () => {
  // /api/users/42, /new, a%20b, %zz, /boom, /skip/7 are native-routed; the
  // trailing slash, the upper case, the dot segments and /nope reach fetch.
  expect(nativeStats.native).toBeGreaterThanOrEqual(6);
});

it("a route added after listen() is served, then moved into the native table", async () => {
  const before = nativeStats.reloads;
  native.get("/late/:x", (req, res) => {
    res.send(`late:${req.params.x}`);
  });
  const first = await fetch(`${server.url.origin}/late/1`);
  expect(await first.text()).toBe("late:1");
  await Bun.sleep(120);
  expect(nativeStats.reloads).toBe(before + 1);
  const nativeBefore = nativeStats.native;
  const second = await fetch(`${server.url.origin}/late/2`);
  expect(await second.text()).toBe("late:2");
  expect(nativeStats.native).toBe(nativeBefore + 1);
});

/** One raw request, path sent byte for byte (a `fetch()` client would normalise it). */
function raw(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
}

it("a dot segment Bun routes to /api/users/:id is answered for the normalised path", async () => {
  // Bun routes raw `/api/users/..` to the `/api/users/:p0` key (id ".."), but
  // `req.url` is `/api/` — which `/api` matches, and `/api` is not in that
  // key's candidates. The shape guard sends it down the full pipeline.
  const fallbacks = nativeStats.guardFallback;
  const response = await raw(server.port!, "/api/users/..");
  expect(response.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
  expect(response.endsWith("api-root")).toBe(true);
  expect(nativeStats.guardFallback).toBe(fallbacks + 1);
});
