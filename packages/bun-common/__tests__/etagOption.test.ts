import type { EtagOption } from "../lib";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { etag } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { makeResponse } from "./helpers";

/**
 * `res.etag` / `res.setEtag(option)`: how one response is tagged with an
 * ETag, overruling the adapter's `etag` option for that response only.
 */

async function tagOf(option: EtagOption | undefined, body: unknown = "hello") {
  const res = await makeResponse();
  if (option !== undefined) {
    res.setEtag(option);
  }
  const native = await res.send(body as never).getNativeResponse(0);
  return native.headers.get("etag");
}

describe("BunResponse: etag option", () => {
  it("is off by default, and each mode tags as documented", async () => {
    expect(await tagOf(undefined)).toBeNull();
    expect(await tagOf(false)).toBeNull();
    expect(await tagOf(true)).toBe(etag("hello"));
    expect(await tagOf("strong")).toBe(etag("hello"));
    expect(await tagOf("weak")).toBe(`W/${etag("hello")}`);
  });

  it("calls a function with the body and uses what it returns", async () => {
    const seen: unknown[] = [];
    const custom = (body: string | Uint8Array) => {
      seen.push(body);
      return `"v-${typeof body === "string" ? body.length : body.byteLength}"`;
    };
    expect(await tagOf(custom, "hello")).toBe('"v-5"');
    expect(await tagOf(custom, Buffer.from([1, 2, 3]))).toBe('"v-3"');
    expect(seen[0]).toBe("hello");
    expect(seen[1]).toBeInstanceOf(Uint8Array);
    // undefined (or "") means no tag for this body.
    expect(await tagOf(() => undefined)).toBeNull();
    expect(await tagOf(() => "")).toBeNull();
  });

  it("tags JSON and binary bodies too", async () => {
    expect(await tagOf("weak", { a: 1 })).toBe(`W/${etag('{"a":1}')}`);
    expect(await tagOf(true, Buffer.from("bin"))).toBe(
      etag(Buffer.from("bin")),
    );
  });

  it("never replaces a tag set by hand", async () => {
    const res = await makeResponse();
    res.setEtag("weak").set("ETag", '"mine"');
    const native = await res.send("x").getNativeResponse(0);
    expect(native.headers.get("etag")).toBe('"mine"');
  });

  it("reads back what was set, via etag and setEtag", async () => {
    const res = await makeResponse();
    expect(res.etag).toBe(false);
    expect(res.setEtag()).toBe(res);
    expect(res.etag).toBe(true);
    res.etag = "weak";
    expect(res.etag).toBe("weak");
  });

  it("rejects a value that is not an option", async () => {
    const res = await makeResponse();
    for (const bad of ["weakk", 1, null, {}]) {
      expect(() => {
        res.etag = bad as never;
      }).toThrow(TypeError);
    }
    expect(() => new BunHttpAdapter(0, { etag: "x" as never })).toThrow(
      TypeError,
    );
  });

  it("answers 304 to a matching If-None-Match, weak or strong", async () => {
    for (const option of ["weak", "strong"] as const) {
      const tag = option === "weak" ? `W/${etag("hello")}` : etag("hello");
      for (const sent of [tag, etag("hello"), `W/${etag("hello")}`]) {
        const res = await makeResponse({ headers: { "If-None-Match": sent } });
        const native = await res
          .setEtag(option)
          .send("hello")
          .getNativeResponse(0);
        expect(native.status).toBe(304);
      }
    }
  });
});

describe("BunResponse: etag overrules the adapter's option", () => {
  it("turns the ETag off for one route of an adapter that tags everything", async () => {
    const adapter = new BunHttpAdapter(0, { etag: true });
    adapter.get("/tagged", (_req, res) => res.send("a"));
    adapter.get("/untagged", (_req, res) => res.setEtag(false).send("a"));
    expect((await adapter.fetch("/tagged")).headers.get("etag")).toBe(
      etag("a"),
    );
    expect((await adapter.fetch("/untagged")).headers.get("etag")).toBeNull();
    // The adapter's option is unchanged for the next request.
    expect((await adapter.fetch("/tagged")).headers.get("etag")).toBe(
      etag("a"),
    );
  });

  it("turns it on (or makes it weak) for one route of an adapter that does not", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use("/weak", (_req, res, next) => {
      res.etag = "weak";
      next();
    });
    adapter.get("/weak", (_req, res) => res.send("b"));
    adapter.get("/plain", (_req, res) => res.send("b"));
    expect((await adapter.fetch("/weak")).headers.get("etag")).toBe(
      `W/${etag("b")}`,
    );
    expect((await adapter.fetch("/plain")).headers.get("etag")).toBeNull();
  });

  it("takes the adapter's function or mode as every response's starting point", async () => {
    const adapter = new BunHttpAdapter(0, { etag: () => '"fixed"' });
    adapter.get("/f", (_req, res) => res.send("c"));
    expect((await adapter.fetch("/f")).headers.get("etag")).toBe('"fixed"');
    const weak = new BunHttpAdapter(0, { etag: "weak" });
    weak.get("/w", (_req, res) => res.json({ c: 1 }));
    expect((await weak.fetch("/w")).headers.get("etag")).toBe(
      `W/${etag('{"c":1}')}`,
    );
  });

  it("keeps a response with ETag off on the no-headers path", async () => {
    const res = await makeResponse();
    res.setEtag(true).setEtag(false);
    const native = await res.send("x").getNativeResponse(0);
    expect(native.headers.has("content-type")).toBe(false);
    expect(native.headers.has("etag")).toBe(false);
  });
});
