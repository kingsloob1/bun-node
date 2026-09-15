/**
 * Files and streams — `sendFile()` and every `SendFileOptions` field,
 * downloads and attachments, byte ranges, streamed bodies, `write()`/`end()`
 * and server-sent events over a real socket, and redirects.
 *
 * ```bash
 * bun 05-response/files-and-streams.ts
 * ```
 *
 * Worth knowing before reading it:
 *
 * - `sendFile()` follows Express: `path` must be absolute unless `root` is
 *   given, and with `root` even an absolute `path` resolves under it.
 * - `maxAge` is milliseconds (or an `ms` string such as `"1h"`), written as
 *   `public, max-age=<seconds>`; a `Cache-Control` already set is kept.
 * - `dotfiles` (ignore → 404, deny → 403, allow) and `acceptRanges` (206 /
 *   416) are applied by `sendFile()`. The byte-range section below builds the
 *   same by hand with `req.range()`, for a body that is not a file on disk.
 * - A missing file is a 404 rather than an error.
 * - `write()` switches the response to a long-lived stream (and to
 *   `text/event-stream` headers). Start the producer without awaiting it, so
 *   the handler returns and the client can read as chunks arrive.
 * - Once a response has ended (`end()`, or any `send()`), `write()` writes
 *   nothing: it answers `false` and emits `ERR_STREAM_WRITE_AFTER_END`, as
 *   Node's `ServerResponse` does.
 * - `redirect()` builds a fresh `Response`, so headers set earlier on `res`
 *   are not carried onto it.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { BunHttpAdapter, BunRouter } from "@kingsleyweb/bun-common";
import { show, step, title, waitFor } from "../shared/console";

title("Files and streams");

const fixtures = join(import.meta.dir, "fixtures");
const router = new BunRouter();

/** The headers of interest on a file response. */
function fileHeaders(response: Response): Record<string, string | null> {
  const names = [
    "Content-Type",
    "Content-Length",
    "Content-Disposition",
    "Cache-Control",
    "Last-Modified",
    "X-Served-By",
    "Content-Range",
  ];
  return Object.fromEntries(
    names.map((name) => [name, response.headers.get(name)]),
  );
}

/* ------------------------------------------------------------------ */
step(
  "sendFile(): root, headers, maxAge, immutable, cacheControl, lastModified",
);

router.get("/report", async (_req, res) => {
  await res.sendFile("report.csv", {
    root: fixtures,
    headers: { "X-Served-By": "sendFile" },
    maxAge: 3_600_000,
    immutable: true,
    lastModified: true,
  });
});
router.get("/report/uncached", async (_req, res) => {
  res.set("Cache-Control", "max-age=60");
  await res.sendFile("report.csv", {
    root: fixtures,
    cacheControl: false,
    lastModified: false,
  });
});
router.get("/missing", async (_req, res) => {
  await res.sendFile("nope.csv", { root: fixtures });
});

const report = await router.fetch("/report");
show(`GET /report: ${report.status}`, fileHeaders(report));
show("body", await report.text());
const uncached = await router.fetch("/report/uncached");
show(
  `cacheControl: false, lastModified: false: ${uncached.status}`,
  fileHeaders(uncached),
);
show("a missing file", (await router.fetch("/missing")).status);

/* ------------------------------------------------------------------ */
step("download() and attachment()");

router.get("/download", async (_req, res) => {
  await res.download("report.csv", "sales-2031.csv", { root: fixtures }, () => {
    show("download() callback ran");
  });
});
router.get("/sendfile-download", async (_req, res) => {
  await res.sendFile("report.csv", {
    root: fixtures,
    download: true,
    filename: "via-sendFile.csv",
  });
});
router.get("/attachment", async (_req, res) => {
  res.attachment(join(fixtures, "report.csv"));
  res.send("month,orders\n");
});
router.get("/attachment/bare", async (_req, res) => {
  res.attachment();
  res.send("no filename");
});

for (const path of [
  "/download",
  "/sendfile-download",
  "/attachment",
  "/attachment/bare",
]) {
  const response = await router.fetch(path);
  show(path, fileHeaders(response));
}

/* ------------------------------------------------------------------ */
step("Byte ranges: req.range() and a sliced file");

router.get("/alphabet", (req, res) => {
  const file = Bun.file(join(fixtures, "alphabet.txt"));
  res.set("Accept-Ranges", "bytes");
  const ranges = req.range(file.size, { combine: true });

  if (ranges === undefined) {
    res.send(file);
    return;
  }
  if (
    ranges === -1 ||
    ranges === -2 ||
    ranges.type !== "bytes" ||
    ranges.length !== 1
  ) {
    // -1: unsatisfiable, -2: malformed. (Several ranges would need multipart.)
    res.status(416).set("Content-Range", `bytes */${file.size}`).send("");
    return;
  }
  const [{ start, end }] = ranges;
  res
    .status(206)
    .set("Content-Range", `bytes ${start}-${end}/${file.size}`)
    .send(file.slice(start, end + 1));
});

for (const range of [
  undefined,
  "bytes=0-4",
  "bytes=-5",
  "bytes=10-12,11-15",
  "bytes=500-600",
  "rows=1-2",
]) {
  const response = await router.fetch("/alphabet", {
    headers: range ? { Range: range } : {},
  });
  show(`Range: ${range ?? "(none)"}`, {
    status: response.status,
    contentRange: response.headers.get("Content-Range"),
    body: await response.text(),
  });
}

/* ------------------------------------------------------------------ */
step("Streaming bodies: an async generator, a Node Readable");

router.get("/stream/generator", (_req, res) => {
  res.type("text/plain").send(async function* rows() {
    for (let n = 1; n <= 3; n++) {
      yield `row ${n}\n`;
    }
  });
});
router.get("/stream/readable", (_req, res) => {
  res.type("text/plain").send(Readable.from(["alpha\n", "beta\n"]));
});

show("async generator", await (await router.fetch("/stream/generator")).text());
show("Node Readable", await (await router.fetch("/stream/readable")).text());

/* ------------------------------------------------------------------ */
step("write() and end(): a long-lived response");

router.get("/stream/write", (_req, res) => {
  void (async () => {
    for (let n = 1; n <= 3; n++) {
      res.write(`chunk ${n}\n`);
    }
    await res.end();
  })();
});

const written = await router.fetch("/stream/write");
show("headers write() applied", {
  type: written.headers.get("Content-Type"),
  cacheControl: written.headers.get("Cache-Control"),
});
show("body", await written.text());

router.get("/stream/after-end", async (_req, res) => {
  const errors: string[] = [];
  res.on("error", (error) => {
    errors.push(
      error instanceof Error && "code" in error
        ? String(error.code)
        : String(error),
    );
  });
  res.write("the only chunk\n");
  await res.end();
  // As Node: nothing is written, `false`, and an error event next tick.
  const accepted = res.write("too late\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  show("write() after end()", { accepted, errors });
});

show(
  "body after a late write",
  await (await router.fetch("/stream/after-end")).text(),
);

/* ------------------------------------------------------------------ */
step("Server-sent events over a socket, until the client leaves");

const adapter = new BunHttpAdapter(0);
let serverSawClose = false;

adapter.get("/events", (req, res) => {
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    res.write(
      `id: ${tick}\nevent: tick\ndata: ${JSON.stringify({ tick })}\n\n`,
    );
  }, 20);
  res.on("close", () => {
    clearInterval(timer);
    serverSawClose = true;
  });
  req.on("close", () => show("req close: the client went away"));
});

await adapter.listen(0);
const controller = new AbortController();
const events = await fetch(`${adapter.url}/events`, {
  signal: controller.signal,
});
show("Content-Type", events.headers.get("Content-Type"));

const reader = events.body!.getReader();
const decoder = new TextDecoder();
let received = "";
while ((received.match(/\n\n/g) ?? []).length < 3) {
  const { value, done } = await reader.read();
  if (done) {
    break;
  }
  received += decoder.decode(value);
}
show("first three events", received.trim().split("\n\n"));

controller.abort();
await reader.cancel().catch(() => {});
await waitFor("the server to see the client leave", () => serverSawClose);
show("interval cleared on res close");
await adapter.close();

/* ------------------------------------------------------------------ */
step("redirect(): statuses and a ResponseInit");

router.get("/old", (_req, res) => {
  res.redirect("http://localhost/new");
});
router.get("/moved", (_req, res) => {
  res.redirect("http://localhost/new", 301);
});
router.get("/temporary", (_req, res) => {
  res.redirect("http://localhost/new", { status: 307 });
});

for (const path of ["/old", "/moved", "/temporary"]) {
  const response = await router.fetch(path);
  show(path, {
    status: response.status,
    location: response.headers.get("Location"),
  });
}

/* ------------------------------------------------------------------ */
step("sendFile() from a temporary file");

const tmpName = `bun-common-example-${process.pid}.txt`;
const tmpPath = join(tmpdir(), tmpName);
await Bun.write(tmpPath, "written just now");
router.get("/tmp", async (_req, res) => {
  await res.sendFile(tmpName, { root: tmpdir() });
});
show("root: os.tmpdir()", await (await router.fetch("/tmp")).text());
await Bun.file(tmpPath).delete();
