/**
 * An HTTP API over a queue — accept work with `202 Accepted`, report on it
 * by id. Built with `@kingsleyweb/bun-common`'s `BunHttpAdapter`.
 *
 * ```bash
 * bun 09-integrations/http-api.ts            # drives the API in-process and exits
 * bun 09-integrations/http-api.ts --listen   # serves on PORT (default 3000)
 * ```
 *
 * The shape: a request that would take too long to answer inline enqueues a
 * job and returns its id at once; the client polls a status URL (or is told
 * over a webhook or websocket). The handler stays fast however slow the work.
 *
 * Without `--listen` the example calls `adapter.fetch()`, which runs a
 * `Request` through the same pipeline `Bun.serve` would, with no socket.
 */
import process from "node:process";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a client posts to `/exports`. */
interface ExportRequest {
  /** Which table to export. */
  table: string;
  /** Output format. */
  format: "csv" | "json";
}

/** What a finished export job returns. */
interface ExportResult {
  /** Where the file was written. */
  url: string;
  /** How many rows it holds. */
  rows: number;
}

const jobs = new BunJobs({
  namespace: exampleNamespace("api"),
  driver: exampleDriver(),
});

jobs.define<ExportRequest, ExportResult>(
  "export",
  async (job) => {
    for (let chunk = 1; chunk <= 5; chunk++) {
      await Bun.sleep(40); // pretend to stream rows out
      await job.updateProgress(chunk * 20);
    }
    return {
      url: `https://files.example.com/${job.id}.${job.data.format}`,
      rows: 12_500,
    };
  },
  { attempts: 3, timeout: 60_000 },
);

const registry = jobs.queue<ExportRequest, ExportResult>("jobs");

/* ------------------------------------------------------------------ */
const adapter = new BunHttpAdapter();
adapter.registerParserMiddleware();

adapter.post("/exports", async (req, res) => {
  const body = req.body as Partial<ExportRequest> | undefined;

  if (!body?.table || (body.format !== "csv" && body.format !== "json")) {
    return res
      .status(400)
      .json({ error: "expected { table: string, format: 'csv' | 'json' }" });
  }

  const job = await jobs
    .run<ExportRequest>("export", { table: body.table, format: body.format })
    .start();

  return res
    .status(202)
    .json({ id: job.id, status: `/exports/${job.id}`, state: job.state });
});

adapter.get("/exports/:id", async (req, res) => {
  // `req.params.id` is typed from the path literal.
  const job = await registry.getJob(req.params.id);

  if (!job || job.name !== "export") {
    return res.status(404).json({ error: `no export ${req.params.id}` });
  }

  return res.json({
    id: job.id,
    state: job.state,
    progress: job.progress,
    result: job.returnValue,
    error: job.failedReason?.message ?? null,
  });
});

adapter.get("/admin/queue", async (_req, res) => {
  return res.json({
    counts: await registry.count(),
    paused: await registry.isPaused(),
  });
});

await jobs.start({ concurrency: 4, pollInterval: 25 });

/* ------------------------------------------------------------------ */
if (process.argv.includes("--listen")) {
  const port = Number(process.env.PORT ?? 3000);
  await adapter.listen(port);
  console.log(`listening on http://localhost:${port}`);
  console.log(
    `  curl -X POST localhost:${port}/exports -H 'content-type: application/json' -d '{"table":"orders","format":"csv"}'`,
  );
  console.log(`  curl localhost:${port}/exports/<id>`);

  process.once("SIGINT", async () => {
    await adapter.close();
    await jobs.close();
    process.exit(0);
  });
} else {
  title("HTTP API over a queue");

  /** Calls the API without a socket and answers with status and JSON body. */
  const call = async (path: string, init?: RequestInit) => {
    const response = await adapter.fetch(path, init);
    return { status: response.status, body: (await response.json()) as any };
  };

  step("POST /exports");
  const accepted = await call("/exports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ table: "orders", format: "csv" }),
  });
  show("response", accepted);

  step("GET /exports/:id until it is done");
  let last = "";
  await waitFor("the export to complete", async () => {
    const { body } = await call(`/exports/${accepted.body.id}`);
    const line = `${body.state} ${body.progress ?? 0}%`;
    if (line !== last) show("status", (last = line));
    return body.state === "completed";
  });
  show("final", (await call(`/exports/${accepted.body.id}`)).body);

  step("Errors");
  show(
    "invalid body",
    await call("/exports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ table: "orders", format: "xlsx" }),
    }),
  );
  show("unknown id", await call("/exports/does-not-exist"));

  step("GET /admin/queue");
  show("response", await call("/admin/queue"));

  await jobs.purge();
  await jobs.close();
}
