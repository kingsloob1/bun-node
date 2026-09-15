/**
 * Sending a response — status, every body type `send()` takes, JSON, headers,
 * redirects' building blocks and content negotiation.
 *
 * ```bash
 * bun 05-response/sending.ts
 * ```
 *
 * Worth knowing before reading it:
 *
 * - The first body wins: once a response is produced `headersSent` is true
 *   and a later `send()` is ignored.
 * - `res.type()` takes a full media type. Unlike Express it does not expand a
 *   shorthand (`res.type("json")` sets the header to the literal `json`).
 * - `res.sendStatus(code)` writes the code as the body, but does **not** set
 *   the status — call `res.status(code)` too.
 * - `res.end()` takes text or bytes, as Node's `end(chunk)`: an object throws
 *   `ERR_INVALID_ARG_TYPE` — send it with `json()` instead.
 * - There is no `res.jsonp()`.
 * - `res.format()` needs a `default` handler: when nothing in `Accept`
 *   matches and there is none, no response is produced.
 * - `res.location("back")` reads the `Referrer` header only, not the usual
 *   `Referer` spelling.
 */
import type { BunResponseBody } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { BunResponse, BunRouter } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Sending a response");

const router = new BunRouter();

/** Fetches `path` and answers status, content type and body text. */
async function peek(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; type: string | null; body: string }> {
  const response = await router.fetch(path, init);
  return {
    status: response.status,
    type: response.headers.get("Content-Type"),
    body: await response.text(),
  };
}

/* ------------------------------------------------------------------ */
step("status, statusCode, statusText, sendStatus");

router.get("/created", (_req, res) => {
  res.status(201).statusText("Created").send("made it");
});
router.get("/teapot", (_req, res) => {
  res.statusCode = 418;
  res.send(`statusCode reads back as ${res.statusCode}`);
});
router.get("/gone", (_req, res) => {
  res.status(410).sendStatus(410);
});

show("status(201).statusText('Created')", await peek("/created"));
show("statusCode = 418", await peek("/teapot"));
show("status(410).sendStatus(410)", await peek("/gone"));

/* ------------------------------------------------------------------ */
step("send(): every body type");

const bodies: Record<string, () => BunResponseBody> = {
  string: () => "hello",
  object: () => ({ hello: "world" }),
  array: () => [1, 2, 3],
  number: () => 42,
  null: () => null,
  Buffer: () => Buffer.from("bytes"),
  "typed array window": () => new Uint8Array([0, 104, 105, 0]).subarray(1, 3),
  ArrayBuffer: () => new TextEncoder().encode("array buffer").buffer,
  Blob: () => new Blob(["<b>blob</b>"], { type: "text/html" }),
  FormData: () => {
    const form = new FormData();
    form.append("field", "value");
    return form;
  },
  URLSearchParams: () => new URLSearchParams({ q: "bun", page: "2" }),
  ReadableStream: () => {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("from a web stream"));
        controller.close();
      },
    });
  },
  "Node Readable": () => Readable.from(["from ", "a node ", "stream"]),
  "async generator function": () => {
    return async function* generate() {
      yield "yielded ";
      yield "chunks";
    };
  },
  Response: () => new Response("a native Response", { status: 202 }),
};

for (const [name, make] of Object.entries(bodies)) {
  router.get(`/body/${encodeURIComponent(name)}`, (_req, res) => {
    res.send(make());
  });
}

for (const name of Object.keys(bodies)) {
  const result = await peek(`/body/${encodeURIComponent(name)}`);
  show(name, {
    ...result,
    body:
      result.body.length > 60 ? `${result.body.slice(0, 60)}…` : result.body,
  });
}

router.get("/body/bun-response", (req, res) => {
  // Another BunResponse, already produced, is passed through.
  const inner = new BunResponse(req).status(203);
  inner.json({ from: "inner BunResponse" });
  res.send(inner);
});
show("BunResponse", await peek("/body/bun-response"));

/* ------------------------------------------------------------------ */
step("204, 205 and 304 lose their body; the first send wins");

router.get("/no-content", (_req, res) => {
  res.status(204).type("text/plain").send("ignored");
});
router.get("/reset", (_req, res) => {
  res.status(205).send("ignored");
});
router.get("/twice", (_req, res) => {
  res.send("first");
  res.send("second");
  res.set("X-Headers-Sent", String(res.headersSent));
});

show("204", await peek("/no-content"));
show("205", await peek("/reset"));
show("send twice", await peek("/twice"));

/* ------------------------------------------------------------------ */
step("json(), end(), type()/contentType(), option(), writeHead()");

router.get("/json", (_req, res) => {
  res.status(200).json({ ok: true, at: "json()" });
});
router.get("/end", async (_req, res) => {
  await res.end("ended with a body");
});
router.get("/type", (_req, res) => {
  res.contentType("application/xml").send("<ok/>");
});
router.get("/option", (_req, res) => {
  res.option({ status: 207, statusText: "Multi-Status" }).send("via option()");
});
router.get("/write-head", (_req, res) => {
  res.writeHead(202, "Accepted", { "X-Queue": "reports" }).send("queued");
});
router.get("/write-head-status", (_req, res) => {
  // Node's `writeHead(statusCode[, statusMessage][, headers])`: the status alone.
  res.writeHead(404).send("status only");
});
router.get("/end-object", (_req, res) => {
  // `end()` takes text or bytes, as Node's `end(chunk)`; an object throws
  // (`Reflect.apply`: plain JS can pass what the types rule out).
  try {
    Reflect.apply(res.end, res, [{ not: "a chunk" }]);
  } catch (error) {
    res.status(500).json({
      thrown: error instanceof Error ? error.name : String(error),
      code: error instanceof Error && "code" in error ? error.code : null,
    });
  }
});

for (const path of [
  "/json",
  "/end",
  "/type",
  "/option",
  "/write-head",
  "/write-head-status",
  "/end-object",
]) {
  show(path, await peek(path));
}

/* ------------------------------------------------------------------ */
step("Headers: set, append, setHeaders, get, has, remove, getHeaders");

// As Node's `OutgoingMessage`, `Set-Cookie` reads back as an array of its
// lines — from `getHeader`, `get` and `getHeaders()` alike — so a line whose
// `Expires` holds a comma is never split. Every other header is one string.
router.get("/headers", (_req, res) => {
  res.cookie("theme", "dark");
  res.cookie("legacy", "", { expires: new Date(0) });
  res.appendHeader("Set-Cookie", "raw=1; Path=/");
  res.set("X-One", "1");
  res.header("X-Two", "2");
  res.setHeader("X-Many", ["a", "b"]);
  res.set("X-Many", "c", false); // replace = false appends
  res.append("X-Many", "d");
  res.appendHeader("X-Many", ["e"]);
  res.setHeaders({ "X-From-Record": "yes", "X-List": ["x", "y"] });
  res.setHeaders(["X-From-Line: yes"]);
  res.setHeaders(new Map([["X-From-Map", "yes"]]));
  res.setHeaders(new Headers({ "X-From-Headers": "yes" }));
  res.set("X-Doomed", "soon");
  res.removeHeader("X-Doomed");

  res.json({
    get: res.get("X-Many"),
    getDefault: res.get("X-Absent", "fallback"),
    getHeader: res.getHeader("X-One"),
    setCookieLines: res.getHeader("Set-Cookie"),
    hasDoomed: res.hasHeader("X-Doomed"),
    names: res.getHeaderNames(),
    headers: res.getHeaders(),
  });
});

show("GET /headers", await (await router.fetch("/headers")).json());

/* ------------------------------------------------------------------ */
step("location(), links(), vary()");

router.get("/nav", (_req, res) => {
  res
    .location("/search?q=two words")
    .links({ next: "/page/3", prev: "/page/1" })
    .links({ last: "/page/9" })
    .vary("Accept")
    .vary(["Accept-Language", "accept"])
    .send("see headers");
});
router.get("/back", (_req, res) => {
  res.location("back").sendStatus(302);
});

const nav = await router.fetch("/nav");
show("Location / Link / Vary", {
  location: nav.headers.get("Location"),
  link: nav.headers.get("Link"),
  vary: nav.headers.get("Vary"),
});
show(
  "location('back') with Referrer",
  (await router.fetch("/back", { headers: { Referrer: "/cart" } })).headers.get(
    "Location",
  ),
);
show(
  "…with no Referrer",
  (await router.fetch("/back")).headers.get("Location"),
);

/* ------------------------------------------------------------------ */
step("format(): pick a representation from Accept");

router.get("/greeting", (_req, res) => {
  res.format({
    "text/html": (_q, r) => r.send("<p>hello</p>"),
    json: (_q, r) => r.json({ greeting: "hello" }),
    default: (_q, r) => r.status(406).send("not acceptable"),
  });
});

for (const accept of ["text/html", "application/json", "image/png"]) {
  show(
    `Accept: ${accept}`,
    await peek("/greeting", { headers: { Accept: accept } }),
  );
}

/* ------------------------------------------------------------------ */
step("getBody(), getNativeResponse(), settledResponse — for logging");

router.get("/logged", (_req, res) => {
  res.on("finish", () => {
    show("finish listener sees", {
      status: res.statusCode,
      body: res.getBody(),
      settled: res.settledResponse instanceof Response,
      options: res.nativeResponseOptions?.status,
    });
  });
  res.status(201).json({ id: 7 });
});
await router.fetch("/logged");
