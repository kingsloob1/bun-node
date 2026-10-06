import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";
import { testServer } from "./helpers";

/**
 * Response headers as handlers see them and as they are sent: case-insensitive
 * reads, replacement, removal, the order a `Headers` store lists them in,
 * appends and arrays, `Set-Cookie`, a handler's `Content-Type`, and the
 * freshness rules (`fresh()`'s, as Express applies them in `res.send`).
 * Pinned so a change to how headers are stored cannot be observed.
 */

const make = (headers: Record<string, string> = {}) => {
  const req = new BunRequest(
    new Request("http://h/x", { headers }),
    testServer,
    { parseBody: false },
  );
  return new BunResponse(req);
};

describe("response headers", () => {
  it("reach the response, case-insensitively, with a default Content-Type", async () => {
    const res = make();
    res.set("X-One", "1");
    res.set("access-control-allow-origin", "*");
    res.set("Vary", "Origin");
    expect(res.getHeader("x-one")).toBe("1");
    expect(res.get("ACCESS-CONTROL-ALLOW-ORIGIN")).toBe("*");
    expect(res.hasHeader("vary")).toBe(true);
    expect(res.hasHeader("x-two")).toBe(false);
    expect(res.getHeader("x-two")).toBeNull();
    res.send("ok");
    const response = res.settledResponse!;
    expect([...response.headers]).toEqual([
      ["access-control-allow-origin", "*"],
      ["content-type", "text/plain;charset=utf-8"],
      ["vary", "Origin"],
      ["x-one", "1"],
    ]);
    expect(await response.text()).toBe("ok");
    // Still readable after the send.
    expect(res.getHeader("x-one")).toBe("1");
  });

  it("are replaced, removed, and listed as a Headers store lists them", () => {
    const res = make();
    res.set("B", "1");
    res.set("a", "2");
    res.set("b", "3");
    res.removeHeader("A");
    res.set("c", "4");
    expect(res.getHeader("b")).toBe("3");
    expect(res.hasHeader("a")).toBe(false);
    // Sorted, lower-cased: the order `Headers` iterates in.
    expect(res.getHeaderNames()).toEqual(["b", "c"]);
    expect(res.getHeaders()).toEqual({ b: "3", c: "4" });
  });

  it("an append, an array or an unusual value goes through Headers, as before", () => {
    const res = make();
    res.set("x-list", "a");
    res.append("x-list", "b");
    expect(res.getHeader("x-list")).toBe("a, b");
    res.set("x-many", ["1", "2"]);
    expect(res.getHeader("x-many")).toBe("1, 2");
    // Edge whitespace is stripped by Headers.
    res.set("x-pad", "  v  ");
    expect(res.getHeader("x-pad")).toBe("v");
    // A value Headers refuses still throws at set().
    expect(() => res.set("x-bad", "a\r\nb")).toThrow();
    const fresh = make();
    expect(() => fresh.set("x-bad", "a\r\nb")).toThrow();
    expect(() => fresh.set("bad name", "v")).toThrow();
  });

  it("set-cookie set once reads back as a one-line array", () => {
    const res = make();
    res.set("Set-Cookie", "a=1");
    expect(res.getHeader("set-cookie")).toEqual(["a=1"]);
    res.send("ok");
    expect(res.settledResponse!.headers.getSetCookie()).toEqual(["a=1"]);
  });

  it("json() with a header set sends its JSON Content-Type", async () => {
    const res = make();
    res.set("x-id", "7");
    res.json({ ok: true });
    const response = res.settledResponse!;
    expect(response.headers.get("content-type")).toBe(
      "application/json;charset=utf-8",
    );
    expect(response.headers.get("x-id")).toBe("7");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("a Content-Type set by the handler is kept", () => {
    const res = make();
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send("<p>hi</p>");
    expect(res.settledResponse!.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });
});

describe("freshness", () => {
  /** Serves `GET /x`, which sets one header (and `extra`), with `headers`. */
  async function serve(
    headers: Record<string, string>,
    extra: Record<string, string> = {},
  ) {
    const app = new BunHttpAdapter(0);
    app.get("/x", (_req, res) => {
      res.set("x-a", "1");
      for (const [name, value] of Object.entries(extra)) {
        res.set(name, value);
      }
      res.send("body");
    });
    return app.fetch("/x", { headers });
  }

  it("no validator: only If-None-Match: * makes it fresh, as fresh() does", async () => {
    expect((await serve({})).status).toBe(200);
    expect((await serve({ "if-none-match": '"abc"' })).status).toBe(200);
    expect(
      (await serve({ "if-modified-since": new Date().toUTCString() })).status,
    ).toBe(200);
    expect((await serve({ "if-none-match": "*" })).status).toBe(304);
    expect(
      (
        await serve({
          "if-none-match": "*",
          "if-modified-since": new Date().toUTCString(),
        })
      ).status,
    ).toBe(200);
  });

  it("with an ETag or Last-Modified, the full check runs", async () => {
    expect(
      (await serve({ "if-none-match": '"v1"' }, { ETag: '"v1"' })).status,
    ).toBe(304);
    expect(
      (await serve({ "if-none-match": '"v2"' }, { ETag: '"v1"' })).status,
    ).toBe(200);
    const modified = new Date(Date.now() - 60_000).toUTCString();
    expect(
      (
        await serve(
          { "if-modified-since": new Date().toUTCString() },
          { "Last-Modified": modified },
        )
      ).status,
    ).toBe(304);
  });
});
