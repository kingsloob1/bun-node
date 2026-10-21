import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import type { NextFunction } from "../lib/types/general";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { makeResponse } from "./helpers";

/**
 * Conditional `GET` and `HEAD`, as Express 5.3.0 answers them: its
 * `res.send` asks `req.fresh` (the `fresh` package, 2.0.0), which
 *
 * - is never fresh for a status outside 2xx and 304;
 * - is never fresh with `Cache-Control: no-cache` on the request;
 * - lets `If-None-Match` take precedence over `If-Modified-Since`, which is
 *   then ignored: `*` is fresh on its own, with no `ETag` on the response,
 *   and a list is fresh when one tag matches (a list holding `*` is not);
 * - finds `If-Modified-Since` alone fresh only against a `Last-Modified`.
 *
 * `EXPECTED` is the table recorded from real Express 5.3.0 (`fresh` 2.0.0,
 * `etag` on `"weak"` and off), the same for `GET` and `HEAD`; every row is
 * checked here served, through the adapter's `fetch()` and through a bare
 * router's `fetch()`, with the `etag` option off and `"weak"`, apart from
 * the cells in {@link KNOWN}.
 */

const PAST = "Tue, 01 Jan 2019 00:00:00 GMT";

/** The handlers, as the Express probe ran them. */
const HANDLERS: Record<string, (res: BunResponse) => unknown> = {
  "send(str)": (res) => res.send("hello"),
  "json()": (res) => res.json({ a: 1 }),
  "send(Buffer)": (res) => res.send(Buffer.from("hello")),
  "sendStatus(200)": (res) => res.sendStatus(200),
  "201 send(str)": (res) => res.status(201).send("made"),
  "404 send(str)": (res) => res.status(404).send("nope"),
  "404 json()": (res) => res.status(404).json({ e: 1 }),
  "500 send(Buffer)": (res) => res.status(500).send(Buffer.from("bad")),
  "sendStatus(404)": (res) => res.sendStatus(404),
  "302 send(str)": (res) => res.status(302).send("moved"),
};

/**
 * The request headers of each column; `match` is the `ETag` the server
 * sends for `send(str)` (`"hello"`), so it matches that body (and the same
 * bytes as a `Buffer`) and no other.
 */
function columns(match: string): Record<string, Record<string, string>> {
  return {
    none: {},
    "INM *": { "if-none-match": "*" },
    "INM * + no-cache": { "if-none-match": "*", "cache-control": "no-cache" },
    "INM * + max-age=0, no-cache": {
      "if-none-match": "*",
      "cache-control": "max-age=0, no-cache",
    },
    "INM * + IMS": { "if-none-match": "*", "if-modified-since": PAST },
    "IMS only": { "if-modified-since": PAST },
    'INM "other"': { "if-none-match": '"other"' },
    "INM match": { "if-none-match": match },
    "INM match + IMS": { "if-none-match": match, "if-modified-since": PAST },
    'INM *, "x"': { "if-none-match": '*, "x"' },
  };
}

/** Column order of the rows in {@link EXPECTED}. */
const COLUMNS = Object.keys(columns(""));

/** A row with `status` in every column. */
function every(status: number): number[] {
  return COLUMNS.map(() => status);
}

/**
 * Express 5.3.0's status for each handler (row) and column, with `etag` off
 * and on: the two differ only where `If-None-Match` names the body's tag.
 */
const EXPECTED: Record<"off" | "weak", Record<string, number[]>> = {
  off: {
    "send(str)": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "json()": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "send(Buffer)": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "sendStatus(200)": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "201 send(str)": [201, 304, 201, 201, 304, 201, 201, 201, 201, 201],
    "404 send(str)": every(404),
    "404 json()": every(404),
    "500 send(Buffer)": every(500),
    "sendStatus(404)": every(404),
    "302 send(str)": every(302),
  },
  weak: {
    "send(str)": [200, 304, 200, 200, 304, 200, 200, 304, 304, 200],
    "json()": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "send(Buffer)": [200, 304, 200, 200, 304, 200, 200, 304, 304, 200],
    "sendStatus(200)": [200, 304, 200, 200, 304, 200, 200, 200, 200, 200],
    "201 send(str)": [201, 304, 201, 201, 304, 201, 201, 201, 201, 201],
    "404 send(str)": every(404),
    "404 json()": every(404),
    "500 send(Buffer)": every(500),
    "sendStatus(404)": every(404),
    "302 send(str)": every(302),
  },
};

/**
 * The cells bun-common answers differently, and why: a `GET` whose response
 * sets no header is built with no `Headers` object, and that path does not
 * read the request's headers to find `If-None-Match: *` (fresh with no
 * validator), because a served request builds them on first read. Measured
 * on every plain `GET`: +83% at the route, +6-13% served. It answers the
 * row's status instead of 304. A cell listed here that matches Express
 * fails the test, so the list cannot go stale.
 */
const KNOWN = new Set(
  ["send(str)", "json()", "201 send(str)"].flatMap((name) =>
    ["INM *", "INM * + IMS"].map((column) => `off|GET|${name}|${column}`),
  ),
);

/** One answer, reduced to what the table compares. */
interface Answer {
  /** The status code. */
  status: number;
  /** Whether an `ETag` was sent. */
  etag: boolean;
  /** Whether a `Content-Type` was sent. */
  type: boolean;
  /** The body as received. */
  body: string;
}

/** Reads `response` into an {@link Answer}. */
async function answer(response: Response): Promise<Answer> {
  return {
    status: response.status,
    etag: response.headers.has("etag"),
    type: response.headers.has("content-type"),
    body: await response.text(),
  };
}

/** The route handler for the row `name`. */
function route(name: string) {
  const handler = HANDLERS[name];
  return (_req: BunRequest, res: BunResponse) => {
    handler(res);
  };
}

/** Builds an adapter and a bare router answering every row at `/h<index>`. */
function apps(etag: "off" | "weak") {
  const adapter = new BunHttpAdapter(0, {
    etag: etag === "off" ? false : "weak",
  });
  const router = new BunRouter();
  if (etag === "weak") {
    // A bare router has no `etag` option: each response is told instead.
    router.use((_req: BunRequest, res: BunResponse, next: NextFunction) => {
      res.setEtag("weak");
      next();
    });
  }
  Object.keys(HANDLERS).forEach((name, index) => {
    adapter.all(`/h${index}`, route(name));
    router.all(`/h${index}`, route(name));
  });
  return { adapter, router };
}

describe("conditional GET and HEAD answer as Express 5.3.0 does", () => {
  for (const etag of ["off", "weak"] as const) {
    for (const method of ["GET", "HEAD"]) {
      it(`etag ${etag}, ${method}: served, adapter.fetch() and router.fetch()`, async () => {
        const { adapter, router } = apps(etag);
        const server = await adapter.listen(0);
        try {
          const first = await adapter.fetch("/h0");
          const match = first.headers.get("etag") ?? '"no-tag"';
          await first.text();
          const cols = columns(match);
          const failures: string[] = [];
          for (const [index, name] of Object.keys(HANDLERS).entries()) {
            for (const [col, column] of COLUMNS.entries()) {
              const headers = cols[column];
              const known = KNOWN.has(`${etag}|${method}|${name}|${column}`);
              // A known cell answers the row's unconditional status.
              const want = EXPECTED[etag][name][known ? 0 : col];
              const path = `/h${index}`;
              const seen: Record<string, Answer> = {
                served: await answer(
                  await fetch(`http://127.0.0.1:${server.port}${path}`, {
                    method,
                    headers,
                  }),
                ),
                "adapter.fetch": await answer(
                  await adapter.fetch(path, { method, headers }),
                ),
                "router.fetch": await answer(
                  await router.fetch(path, { method, headers }),
                ),
              };
              for (const [mode, got] of Object.entries(seen)) {
                const where = `${mode} ${method} ${name} [${column}]`;
                if (got.status !== want) {
                  failures.push(
                    `${where}: ${got.status}, want ${want}${known ? " (known)" : ""}`,
                  );
                }
                if (got.etag !== (etag === "weak")) {
                  failures.push(`${where}: ETag ${got.etag}`);
                }
                if (got.status === 304 && (got.type || got.body !== "")) {
                  failures.push(`${where}: a 304 with a type or a body`);
                }
                if (method === "HEAD" && got.body !== "") {
                  failures.push(`${where}: a HEAD with a body`);
                }
              }
            }
          }
          expect(failures).toEqual([]);
        } finally {
          await adapter.close();
        }
      });
    }
  }
});

describe("freshness beyond the table", () => {
  it("stays on the no-headers path for a conditional request that cannot be fresh", async () => {
    // No validator on the response: an entity tag cannot match, nor a date
    // be checked; `no-cache` forbids a 304 outright.
    const cases: Record<string, string>[] = [
      {},
      { "If-Modified-Since": PAST },
      { "If-None-Match": '"abc"' },
      { "If-None-Match": "*", "Cache-Control": "no-cache" },
    ];
    for (const headers of cases) {
      const res = await makeResponse({ headers });
      const native = await res.send("hi").getNativeResponse(0);
      expect({ headers, status: native.status }).toEqual({
        headers,
        status: 200,
      });
      // Bun writes the type on the wire; a Response built without a
      // `Headers` object carries none.
      expect(native.headers.has("content-type")).toBe(false);
      expect(await native.text()).toBe("hi");
    }
  });

  it("never answers 304 outside 2xx, nor for a method other than GET and HEAD", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.all("/s", (_req, res) => res.status(404).send("x"));
    // A header set: the full path, which checks freshness (see `KNOWN`).
    adapter.all("/p", (_req, res) => res.set("x-h", "1").send("x"));
    const headers = { "if-none-match": "*" };
    expect((await adapter.fetch("/s", { headers })).status).toBe(404);
    // Control: the same request, 2xx, is fresh.
    expect((await adapter.fetch("/p", { headers })).status).toBe(304);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await adapter.fetch("/p", { method, headers });
      expect({ method, status: response.status }).toEqual({
        method,
        status: 200,
      });
    }
  });

  it("lets If-None-Match override If-Modified-Since against a Last-Modified", async () => {
    const adapter = new BunHttpAdapter(0);
    const older = "Mon, 01 Jan 2018 00:00:00 GMT";
    const newer = "Wed, 01 Jan 2020 00:00:00 GMT";
    adapter.get("/old", (_req, res) =>
      res.set("Last-Modified", older).send("x"),
    );
    adapter.get("/new", (_req, res) =>
      res.set("Last-Modified", newer).send("x"),
    );
    const get = async (path: string, headers: Record<string, string>) =>
      (await adapter.fetch(path, { headers })).status;
    // `If-Modified-Since` alone decides by the date.
    expect(await get("/old", { "if-modified-since": PAST })).toBe(304);
    expect(await get("/new", { "if-modified-since": PAST })).toBe(200);
    // With `If-None-Match` beside it, the date is ignored either way.
    expect(
      await get("/new", { "if-none-match": "*", "if-modified-since": PAST }),
    ).toBe(304);
    expect(
      await get("/old", {
        "if-none-match": '"other"',
        "if-modified-since": PAST,
      }),
    ).toBe(200);
  });
});
