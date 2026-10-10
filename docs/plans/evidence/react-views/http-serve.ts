// Spike 3: React SSR through bun-common's real adapter (BunHttpAdapter,
// BunResponse.send, compression()), over a socket.
//
//   NODE_ENV=production bun http-serve.ts            # TTFB, HEAD, errors (client + child server)
//   NODE_ENV=production bun http-serve.ts --serve    # just the server, prints its port (for oha)
//
// The client runs in this process; the server in a child, so the two never
// share an event loop.
import type { BunRequest, BunResponse, NextFunction } from "../../../../packages/bun-common/lib/index.ts";
import { createElement as h, Suspense, use } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { BunHttpAdapter, compression, createLogger } from "../../../../packages/bun-common/lib/index.ts";
import { CatalogDocument, makeItems, slowRecommendations } from "./views/catalog.js";

const items = makeItems(200);
const DELAY = 50;

if (process.argv.includes("--serve")) {
  const counters = { started: 0, completed: 0, cancelled: 0 };
  const adapter = new BunHttpAdapter(0, { logger: createLogger({ level: "error" }) });

  // Counts whether the body stream was read to the end or cancelled.
  const counted = (stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    counters.started++;
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          counters.completed++;
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel(reason) {
        counters.cancelled++;
        return reader.cancel(reason);
      },
    });
  };

  const page = (suspense: boolean) =>
    h(CatalogDocument, {
      title: "Catalogue",
      items,
      recommendations: suspense ? slowRecommendations(DELAY) : undefined,
    });

  for (const prefix of ["", "/gz"]) {
    if (prefix === "/gz") adapter.use("/gz", compression());
    adapter.get(`${prefix}/string`, (_req: BunRequest, res: BunResponse) => {
      res.type("html").send(`<!DOCTYPE html>${renderToString(page(false))}`);
    });
    adapter.get(`${prefix}/stream`, async (_req: BunRequest, res: BunResponse) => {
      res.type("html").send(counted(await renderToReadableStream(page(false))));
    });
    adapter.get(`${prefix}/stream-suspense`, async (_req: BunRequest, res: BunResponse) => {
      res.type("html").send(counted(await renderToReadableStream(page(true))));
    });
    adapter.get(`${prefix}/buffered-suspense`, async (_req: BunRequest, res: BunResponse) => {
      const stream = await renderToReadableStream(page(true));
      await stream.allReady;
      res.type("html").send(await new Response(stream).text());
    });
    // The same stream, piped through a flush after every React chunk.
    adapter.get(`${prefix}/stream-suspense-flush`, async (_req: BunRequest, res: BunResponse) => {
      const source = await renderToReadableStream(page(true));
      const flushing = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            queueMicrotask(() => res.flush());
          },
        }),
      );
      res.type("html").send(flushing);
    });
  }

  // The Express engine contract on bun-common: an engine function
  // (path, options, callback) that imports the view by path and renders it
  // to a string, called the way res.render would call it.
  const viewPath = new URL("./views/catalog.js", import.meta.url).pathname;
  const engine = (path: string, options: Record<string, unknown>, callback: (err: Error | null, html?: string) => void) => {
    import(path)
      .then((mod) => callback(null, `<!DOCTYPE html>${renderToString(h(mod.CatalogDocument, options))}`))
      .catch(callback);
  };
  adapter.get("/engine", (_req: BunRequest, res: BunResponse, next: NextFunction) => {
    engine(viewPath, { title: "Catalogue", items }, (err, html) => (err ? next(err) : res.type("html").send(html!)));
  });

  // Errors.
  function Boom(): never {
    throw new Error("boom in the shell");
  }
  adapter.get("/shell-error", async (_req: BunRequest, res: BunResponse) => {
    // onError is passed so React does not console.error the shell failure itself.
    res.type("html").send(await renderToReadableStream(h("html", null, h("body", null, h(Boom))), { onError: () => {} }));
  });
  function LateBoom({ p }: { p: Promise<unknown> }): never {
    use(p);
    throw new Error("late boom");
  }
  adapter.get("/late-boundary-error", async (_req: BunRequest, res: BunResponse) => {
    res.type("html").send(
      await renderToReadableStream(
        h("html", null, h("body", null, h("p", null, "shell"), h(Suspense, { fallback: h("p", null, "late fallback") }, h(LateBoom, { p: slowRecommendations(20) })))),
        { onError: () => {} },
      ),
    );
  });
  adapter.get("/hard-stream-error", async (_req: BunRequest, res: BunResponse) => {
    const source = await renderToReadableStream(page(false));
    // The first 1000 bytes go out, then the body stream errors.
    const failing = source.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        // Awaiting in transform holds the close back, so the error lands first.
        async transform(chunk, controller) {
          controller.enqueue(chunk.slice(0, 1000));
          await Bun.sleep(20);
          throw new Error("stream broke after headers");
        },
      }),
    );
    res.type("html").send(failing);
  });
  adapter.get("/counters", (_req: BunRequest, res: BunResponse) => {
    res.json(counters);
  });
  adapter.use(((err: unknown, _req: BunRequest, res: BunResponse, _next: NextFunction) => {
    if (res.headersSent) return;
    res.status(500).type("html").send(`<!DOCTYPE html><p>error handler: ${String(err)}</p>`);
  }) as never);

  await adapter.listen(0, "127.0.0.1");
  console.log(`PORT ${adapter.listeningPort}`);
  process.on("SIGTERM", () => process.exit(0));
} else {
  const child = Bun.spawn([process.execPath, import.meta.path, "--serve"], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  let out = "";
  while (!/PORT \d+/.test(out)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`server exited: ${out}`);
    out += new TextDecoder().decode(value);
  }
  const base = `http://127.0.0.1:${/PORT (\d+)/.exec(out)![1]}`;
  console.log(`bun ${Bun.version}, NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}, load ${(await import("node:os")).loadavg().map((n) => n.toFixed(1)).join(" ")}`);

  async function timed(path: string, init: RequestInit & { decompress?: boolean } = {}) {
    const t0 = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("stalled: no end of body within 2 s")), 2000);
    const response = await fetch(base + path, { ...init, decompress: false, signal: deadline.signal } as RequestInit);
    const headers = performance.now() - t0;
    let first = Number.NaN;
    let bytes = 0;
    let firstChunk = "";
    let error: string | undefined;
    try {
      const body = response.body?.getReader();
      for (;;) {
        if (!body) break;
        const { done, value } = await body.read();
        if (done) break;
        if (Number.isNaN(first)) {
          first = performance.now() - t0;
          firstChunk = new TextDecoder().decode(value.slice(0, 64));
        }
        bytes += value.byteLength;
      }
    } catch (e) {
      error = String(e);
    }
    clearTimeout(timer);
    return { status: response.status, encoding: response.headers.get("content-encoding"), headers, first, last: performance.now() - t0, bytes, firstChunk, error };
  }

  const median = (list: number[]) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)]!;
  const paths = [
    "/string",
    "/stream",
    "/buffered-suspense",
    "/stream-suspense",
    "/stream-suspense-flush",
  ];
  console.log(`\n## TTFB over a socket (median of 15, ms; a stalled path is tried twice). Suspense section waits ${DELAY} ms.`);
  console.log("path | accept-encoding | status | content-encoding | headers | first byte | last byte | bytes on the wire");
  for (const gz of [false, true]) {
    for (const path of paths) {
      const full = (gz ? "/gz" : "") + path;
      const init = { headers: { "accept-encoding": gz ? "gzip" : "identity" } };
      const probe = await timed(full, init);
      const n = probe.error ? 2 : 15;
      if (!probe.error) for (let i = 0; i < 3; i++) await timed(full, init);
      const runs = [probe];
      for (let i = 1; i < n; i++) runs.push(await timed(full, init));
      const r = runs[0]!;
      const stalled = runs.filter((x) => x.error !== undefined).length;
      console.log(
        `${full} | ${gz ? "gzip" : "identity"} | ${r.status} | ${r.encoding ?? "-"} | ${median(runs.map((x) => x.headers)).toFixed(1)} | ${median(runs.map((x) => x.first)).toFixed(1)} | ${stalled ? `STALLED ${stalled}/${runs.length} (${r.bytes} bytes arrived)` : median(runs.map((x) => x.last)).toFixed(1)} | ${stalled ? "-" : r.bytes}`,
      );
    }
  }

  console.log("\n## HEAD on a streamed page");
  const before = await (await fetch(`${base}/counters`)).json();
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${base}/stream`, { method: "HEAD" });
    await r.arrayBuffer();
  }
  await Bun.sleep(300);
  const after = (await (await fetch(`${base}/counters`)).json()) as typeof before;
  console.log(`5 HEAD requests: renders started ${after.started - before.started}, streams read to the end ${after.completed - before.completed}, cancelled ${after.cancelled - before.cancelled}`);
  const head = await fetch(`${base}/stream`, { method: "HEAD" });
  console.log(`HEAD status ${head.status}, content-type ${head.headers.get("content-type")}, content-length ${head.headers.get("content-length")}, transfer-encoding ${head.headers.get("transfer-encoding")}`);

  console.log("\n## Errors");
  for (const path of ["/shell-error", "/late-boundary-error", "/hard-stream-error"]) {
    const r = await timed(path);
    const text = await (await fetch(base + path)).text().catch((e) => `READ FAILED: ${String(e)}`);
    console.log(`${path}: status ${r.status}, bytes ${r.bytes}, client read error ${r.error ?? "none"}, ends with </html> ${text.trimEnd().endsWith("</html>")}, body starts ${JSON.stringify(text.slice(0, 80))}`);
  }

  child.kill("SIGTERM");
  await child.exited;
}
