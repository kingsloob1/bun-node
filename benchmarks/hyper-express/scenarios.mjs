/**
 * hyper-express on the route set of `../scenarios/servers.ts`, for `../wrk.ts`:
 *
 *   node scenarios.mjs     (or: bun scenarios.mjs — uWebSockets.js does not
 *                           load under Bun; see README.md)
 *
 * Binds a free port and prints `READY <port>`.
 */
import { createServer } from "node:net";
import process from "node:process";
import HyperExpress from "hyper-express";

const ROUTES = Number(process.env.ROUTES ?? 1000);
const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "access-control-allow-origin": "*",
  vary: "Origin",
};

const bump = (req) => {
  req.hits = (req.hits ?? 0) + 1;
};

const app = new HyperExpress.Server();
for (let i = 0; i < 3; i++) {
  app.use("/mw", (req, _res, next) => {
    bump(req);
    next();
  });
}
app.get("/static", (_req, res) => res.send("ok"));
app.get("/user/:id", (req, res) => res.send(req.path_parameters.id));
app.get("/assets/*", (_req, res) => res.send("ok"));
app.get("/mw/hit", (req, res) => res.send(`mw:${req.hits}`));
app.post("/json", async (req, res) => {
  const body = await req.json();
  res.json({ ok: true, n: body.n });
});
app.get("/async", async (_req, res) => {
  await null;
  res.send("ok");
});
app.get("/headers", (_req, res) => {
  for (const [name, value] of Object.entries(HEADERS)) res.header(name, value);
  res.send("ok");
});
for (let i = 0; i < ROUTES; i++) {
  app.get(`/r${i}/:id`, (req, res) =>
    res.send(`r${i}:${req.path_parameters.id}`),
  );
}

// uWebSockets.js cannot report the port it bound for 0: take a free one.
const port = await new Promise((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = probe.address();
    probe.close(() => resolve(free));
  });
});
await app.listen(port);
process.stdout.write(`READY ${port}\n`);
