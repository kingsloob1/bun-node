/**
 * hyper-express (uWebSockets.js) for ../bench.ts: the same logical routes as
 * every other entry, run as its own process under Node.js or Bun:
 *
 *   node server.mjs <port> <middlewareCount>
 *   bun server.mjs <port> <middlewareCount>
 *
 * Prints `listening <port>` once it accepts connections.
 */
import process from "node:process";
import HyperExpress from "hyper-express";

const port = Number(process.argv[2] ?? 0);
const middlewareCount = Number(process.argv[3] ?? 5);

const app = new HyperExpress.Server();

app.get("/ping", (_req, res) => res.send("ok"));
app.get("/user/:id", (req, res) => res.send(req.path_parameters.id));
app.get("/api/v1/users/:userId/books/:bookId", (req, res) =>
  res.send(`${req.path_parameters.userId}/${req.path_parameters.bookId}`),
);
app.get("/assets/*", (_req, res) => res.send("ok"));

const middlewares = Array.from(
  { length: middlewareCount },
  () => (_req, _res, next) => next(),
);
app.get("/chain", ...middlewares, (_req, res) => res.send("ok"));

app.set_not_found_handler((_req, res) => res.status(404).send("not found"));

await app.listen(port);
process.stdout.write(`listening ${port}\n`);

const stop = () => {
  app.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
