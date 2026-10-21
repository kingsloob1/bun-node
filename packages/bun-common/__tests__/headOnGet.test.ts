import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import net from "node:net";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";

/**
 * A `HEAD` on a route with only a GET handler, as Express answers it: the GET
 * handler runs and the body is dropped. With no header set, the response goes
 * out without a `Headers` object passed in (the path GET takes), its type set
 * on the built response because Bun writes none for a served `HEAD`
 * (docs/bun-bugs/head-response-loses-implicit-content-type.md). Each case
 * carries its control: the same request shaped so the assertion would fail.
 */

const TEXT = "text/plain;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";

/** Sends a raw request and returns the response head (lower-cased) and body. */
function raw(
  port: number,
  method: string,
  path: string,
  extra = "",
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const [statusLine, ...lines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body: rest.join("\r\n\r\n"),
      });
    });
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: x\r\n${extra}Connection: close\r\n\r\n`,
    );
  });
}

/** The status, type and body of a socket-free answer. */
async function answer(response: Response) {
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: await response.text(),
  };
}

describe("HEAD on a GET route: what it answers", () => {
  it("runs the GET handler and drops the body, served and through fetch()", async () => {
    const adapter = new BunHttpAdapter(0);
    const ran: string[] = [];
    adapter.get("/text", (req, res) => {
      ran.push(req.method);
      res.send("hello");
    });
    adapter.get("/created", (_req, res) => res.status(201).send("made"));
    adapter.get("/json", (_req, res) => res.json({ a: 1 }));
    adapter.get("/object", (_req, res) => res.send({ via: "send" }));
    adapter.get("/undefined", (_req, res) => res.json(undefined));
    adapter.get("/number", (_req, res) => res.send(42));
    adapter.get("/empty", (_req, res) => res.send(""));
    adapter.post("/post-only", (_req, res) => res.send("post"));
    const server = await adapter.listen(0);
    try {
      const cases: [string, number, string, string][] = [
        ["/text", 200, TEXT, "5"],
        ["/created", 201, TEXT, "4"],
        ["/json", 200, JSON_TYPE, "7"],
        ["/object", 200, JSON_TYPE, "14"],
        ["/undefined", 200, JSON_TYPE, "0"],
        ["/number", 200, TEXT, "2"],
        ["/empty", 200, TEXT, "0"],
      ];
      for (const [path, status, type, length] of cases) {
        const served = await raw(server.port!, "HEAD", path);
        expect({ path, status: served.status }).toEqual({ path, status });
        expect({ path, type: served.headers["content-type"] }).toEqual({
          path,
          type,
        });
        // The length of the body GET sends, which HEAD does not.
        expect({ path, length: served.headers["content-length"] }).toEqual({
          path,
          length,
        });
        expect(served.body).toBe("");
        const fetched = await answer(
          await adapter.fetch(path, { method: "HEAD" }),
        );
        expect({ path, ...fetched }).toEqual({ path, status, type, body: "" });
      }
      // Once served, once through fetch().
      expect(ran).toEqual(["HEAD", "HEAD"]);

      // Control: the GET of the same route has the body HEAD drops.
      const get = await raw(server.port!, "GET", "/text");
      expect([get.body, get.headers["content-type"]]).toEqual(["hello", TEXT]);
      // Control: a route with no GET handler does not answer HEAD.
      expect((await raw(server.port!, "HEAD", "/post-only")).status).toBe(404);
      expect(
        (await adapter.fetch("/post-only", { method: "HEAD" })).status,
      ).toBe(404);
    } finally {
      await adapter.close();
    }
  });

  it("reports the type to header reads after the send, as GET does", async () => {
    const adapter = new BunHttpAdapter(0);
    const seen: Record<string, unknown> = {};
    adapter.get("/t", (req, res) => {
      res.send("hi");
      seen[req.method] = {
        type: res.getHeader("Content-Type"),
        names: res.getHeaderNames(),
        sent: res.headersSent,
      };
    });
    await adapter.fetch("/t", { method: "HEAD" });
    await adapter.fetch("/t");
    expect(seen.HEAD).toEqual({
      type: TEXT,
      names: ["content-type"],
      sent: true,
    });
    expect(seen.HEAD).toEqual(seen.GET);
  });

  it("still answers a fresh HEAD 304, and an unconditional one 200", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/t", (_req, res) => res.send("hi"));
    adapter.get("/j", (_req, res) => res.json({ a: 1 }));
    const server = await adapter.listen(0);
    try {
      for (const path of ["/t", "/j"]) {
        // `If-None-Match: *` makes a HEAD fresh with no validator, as before.
        const fresh = await raw(
          server.port!,
          "HEAD",
          path,
          "If-None-Match: *\r\n",
        );
        expect({ path, status: fresh.status }).toEqual({ path, status: 304 });
        expect(fresh.headers["content-type"]).toBeUndefined();
        const fetched = await adapter.fetch(path, {
          method: "HEAD",
          headers: { "if-none-match": "*" },
        });
        expect(fetched.status).toBe(304);
        // Control: an entity tag cannot match without a validator.
        const tagged = await adapter.fetch(path, {
          method: "HEAD",
          headers: { "if-none-match": '"abc"' },
        });
        expect(tagged.status).toBe(200);
        // Control: unconditional.
        expect((await raw(server.port!, "HEAD", path)).status).toBe(200);
      }
      // GET's no-headers path does not look (a known difference from Express,
      // responseNoHeaders.test.ts says why).
      const get = await adapter.fetch("/t", {
        headers: { "if-none-match": "*" },
      });
      expect(get.status).toBe(200);
    } finally {
      await adapter.close();
    }
  });

  it("keeps a header the handler set, which takes the full path", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/h", (_req, res) => res.set("x-h", "1").send("hello"));
    const server = await adapter.listen(0);
    try {
      const served = await raw(server.port!, "HEAD", "/h");
      expect([served.headers["x-h"], served.headers["content-type"]]).toEqual([
        "1",
        TEXT,
      ]);
      expect(served.headers["content-length"]).toBe("5");
      const fetched = await adapter.fetch("/h", { method: "HEAD" });
      expect([fetched.headers.get("x-h"), await fetched.text()]).toEqual([
        "1",
        "",
      ]);
    } finally {
      await adapter.close();
    }
  });
});

describe("HEAD on a GET route: routing", () => {
  it("prefers a HEAD route registered first; a GET registered first answers", async () => {
    const router = new BunRouter();
    router.head("/head-first", (_req, res) => res.status(202).send("head"));
    router.get("/head-first", (_req, res) => res.send("get"));
    router.get("/get-first", (_req, res) => res.status(201).send("get"));
    router.head("/get-first", (_req, res) => res.status(202).send("head"));
    router.get("/handed-on", (_req, _res, next) => next());
    router.head("/handed-on", (_req, res) => res.status(203).send("head"));

    const handled = async (path: string) => {
      const response = await router.fetch(path, { method: "HEAD" });
      return { status: response.status, body: await response.text() };
    };
    expect(await handled("/head-first")).toEqual({ status: 202, body: "" });
    expect(await (await router.fetch("/head-first")).text()).toBe("get");
    // Express: the routes are tried in order, and the GET one handles HEAD.
    expect(await handled("/get-first")).toEqual({ status: 201, body: "" });
    // Control: when the GET handler hands on, the HEAD route answers.
    expect(await handled("/handed-on")).toEqual({ status: 203, body: "" });
  });

  it("runs middleware, honours next('route') and reaches all() routes", async () => {
    const router = new BunRouter();
    const order: string[] = [];
    router.use((req, _res, next) => {
      order.push(`use:${req.method}`);
      next();
    });
    router.get(
      "/r",
      (req, _res, next) => {
        order.push("get-1");
        next(req.query.skip === "1" ? "route" : undefined);
      },
      (_req, res) => {
        order.push("get-2");
        res.send("get");
      },
    );
    router.all("/r", (req, res) => {
      order.push(`all:${req.method}`);
      res.status(207).send("all");
    });

    const head = await router.fetch("/r", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect(order.splice(0)).toEqual(["use:HEAD", "get-1", "get-2"]);

    const skipped = await router.fetch("/r?skip=1", { method: "HEAD" });
    expect([skipped.status, await skipped.text()]).toEqual([207, ""]);
    expect(order.splice(0)).toEqual(["use:HEAD", "get-1", "all:HEAD"]);

    // Control: the same skip on GET reaches all() with its body.
    const get = await router.fetch("/r?skip=1");
    expect([get.status, await get.text()]).toEqual([207, "all"]);
    expect(order.splice(0)).toEqual(["use:GET", "get-1", "all:GET"]);

    // An all() route alone answers HEAD itself.
    const only = new BunRouter();
    only.all("/a", (req, res) => res.send(req.method));
    const allHead = await only.fetch("/a", { method: "HEAD" });
    expect([allHead.status, allHead.headers.get("content-type")]).toEqual([
      200,
      TEXT,
    ]);
  });

  it("answers through a mounted router and a host route", async () => {
    const adapter = new BunHttpAdapter(0);
    const sub = new BunRouter();
    sub.get("/items/:id", (req, res) => res.send(String(req.params.id)));
    sub.head("/own/:id", (_req, res) => res.status(203).send("own"));
    sub.get("/own/:id", (_req, res) => res.send("get"));
    adapter.use("/api/:org", sub);
    adapter.domain(":tenant.example.com", (tenant) => {
      tenant.get("/users/:id", (req, res) =>
        res.send(`${String(req.params.tenant)}/${String(req.params.id)}`),
      );
    });

    const mounted = await adapter.fetch("http://localhost/api/acme/items/5", {
      method: "HEAD",
    });
    expect(await answer(mounted)).toEqual({
      status: 200,
      type: TEXT,
      body: "",
    });
    const own = await adapter.fetch("http://localhost/api/acme/own/5", {
      method: "HEAD",
    });
    expect(own.status).toBe(203);
    // Control: GET on the mounted route has its body.
    expect(
      await (await adapter.fetch("http://localhost/api/acme/items/5")).text(),
    ).toBe("5");

    const host = await adapter.fetch("http://acme.example.com/users/7", {
      method: "HEAD",
    });
    expect(await answer(host)).toEqual({ status: 200, type: TEXT, body: "" });
    expect(
      await (await adapter.fetch("http://acme.example.com/users/7")).text(),
    ).toBe("acme/7");
    // Control: another host does not reach the host route.
    const other = await adapter.fetch("http://other.test/users/7", {
      method: "HEAD",
    });
    expect(other.status).toBe(404);
  });
});

describe("HEAD on a GET route: the fast path", () => {
  it("matches HEAD once per path, beside the GET, within routeCacheMax", async () => {
    const adapter = new BunHttpAdapter(0, { routeCacheMax: 2 });
    adapter.get("/a", (_req, res) => res.send("a"));
    adapter.get("/b", (_req, res) => res.send("b"));
    adapter.get("/c", (_req, res) => res.send("c"));
    const match = (method: string, path: string) =>
      adapter.getMatchedLayers({
        requestHost: "localhost",
        requestMethod: method,
        requestUrl: path,
      });

    const get = match("GET", "/a");
    const head = match("HEAD", "/a");
    // The same handler, in its own cached pipeline: a hit, not a re-match.
    expect(head).not.toBe(get);
    expect(head.map((layer) => layer.callback)).toEqual(
      get.map((layer) => layer.callback),
    );
    expect(match("HEAD", "/a")).toBe(head);
    expect(match("GET", "/a")).toBe(get);

    // Bounded: two more paths evict "/a", HEAD's pipeline with it.
    match("HEAD", "/b");
    match("HEAD", "/c");
    const cache = (
      adapter.instance as unknown as {
        routeCacheLayers: { size: number };
      }
    ).routeCacheLayers;
    expect(cache.size).toBeLessThanOrEqual(2);
    expect(match("HEAD", "/a")).not.toBe(head);
    const again = await adapter.fetch("/a", { method: "HEAD" });
    expect(await answer(again)).toEqual({ status: 200, type: TEXT, body: "" });
  });

  it("sends a socket-free HEAD without a body, and a served one with it", async () => {
    const adapter = new BunHttpAdapter(0);
    const natives: Response[] = [];
    const keep = (res: BunResponse) => {
      res.whenResponded((response) => natives.push(response));
    };
    adapter.get("/t", (_req: BunRequest, res) => {
      keep(res);
      res.send("hello");
    });
    adapter.get("/h", (_req: BunRequest, res) => {
      keep(res);
      res.set("x-h", "1").send("hello");
    });

    await adapter.fetch("/t", { method: "HEAD" });
    const [fast] = natives.splice(0);
    // Nothing to drop: the response was built bodiless, its type set on it.
    expect(fast.body).toBeNull();
    expect(fast.bodyUsed).toBe(false);
    expect(fast.headers.get("content-type")).toBe(TEXT);

    // Control: with a header set (the full path) the body is built, and
    // dropped afterwards.
    await adapter.fetch("/h", { method: "HEAD" });
    const [full] = natives.splice(0);
    expect(await full.text()).toBe("hello");

    // Control: a served HEAD keeps the body Bun measures for Content-Length.
    const server = await adapter.listen(0);
    try {
      await raw(server.port!, "HEAD", "/t");
      const [served] = natives.splice(0);
      expect(served.headers.get("content-type")).toBe(TEXT);
      // Bun read the body to measure and drop it.
      expect(served.bodyUsed).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
