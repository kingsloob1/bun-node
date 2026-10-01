/**
 * The reference semantics for an error after a streamed response's headers
 * went out: Express 5.2.1 (router 2.2.0, finalhandler 2.1.1) on Bun's
 * `node:http`. Compare with common-sse.ts case I.
 *
 *   (cd benchmarks && bun install)
 *   bun docs/plans/evidence/bun-native-routes/sse/express-after-headers.ts
 */
import type { NextFunction, Request, Response } from "express";
import type { AddressInfo } from "node:net";
import express from "../../../../../benchmarks/node_modules/express";
import { log, ms, readEvents, show } from "./lib";

async function run(label: string, withHandler: boolean, mode: "throw" | "next" | "async"): Promise<void> {
  const app = express();
  let handlerSaw = "not run";
  app.get("/e", async (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: e1\n\n");
    if (mode === "throw") throw new Error("boom");
    if (mode === "next") return next(new Error("boom"));
    await Bun.sleep(100);
    throw new Error("boom");
  });
  if (withHandler) {
    app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
      handlerSaw = `ran, headersSent=${res.headersSent}`;
      // The documented pattern: delegate to the default handler once headers are out.
      if (res.headersSent) return next(err);
      res.status(500).send("x");
    });
  }
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/e`);
  const out = await readEvents(res.body, t0, { timeoutMs: 1500 });
  log(label, `status=${res.status} ${show(out)} errorHandler=${handlerSaw} @${ms(t0)}`);
  server.closeAllConnections();
  server.close();
}

await run("express: write then throw, error handler delegates", true, "throw");
await run("express: write then next(err), error handler delegates", true, "next");
await run("express: write, await, throw (async handler)", true, "async");
await run("express: write then throw, no error handler", false, "throw");
process.exit(0);
