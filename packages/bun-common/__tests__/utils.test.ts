import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { describe, expect, it } from "bun:test";
import {
  getMimeFromStr,
  getUniqueFilename,
  isMime,
  isNodeReadableStream,
  pathExists,
  randomBytes,
  streamToBuffer,
} from "../lib/utils/general";

describe("utils/general: mime helpers", () => {
  it("isMime detects mime type strings", () => {
    expect(isMime("application/json")).toBe(true);
    expect(isMime("image/png")).toBe(true);
    expect(isMime("not-a-mime")).toBe(false);
  });

  it("getMimeFromStr resolves extensions and passes through mime types", () => {
    expect(getMimeFromStr("application/json")).toBe("application/json");
    expect(getMimeFromStr("json")).toBe("application/json");
    expect(getMimeFromStr("png")).toBe("image/png");
  });
});

describe("utils/general: filesystem helpers", () => {
  it("pathExists reports existing and missing paths", async () => {
    expect(await pathExists(import.meta.path)).toBe(true);
    expect(await pathExists("/definitely/not/here-xyz")).toBe(false);
  });

  it("getUniqueFilename keeps the extension and is unique", async () => {
    const a = await getUniqueFilename("photo.png");
    const b = await getUniqueFilename("photo.png");
    expect(a.endsWith(".png")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("utils/general: randomBytes", () => {
  it("produces a buffer of the requested size", async () => {
    const bytes = await randomBytes(16);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBe(16);
  });
});

describe("utils/general: streams", () => {
  it("streamToBuffer collects a readable stream", async () => {
    const stream = Readable.from([Buffer.from("hello "), Buffer.from("world")]);
    const buffer = await streamToBuffer(stream);
    expect(buffer.toString()).toBe("hello world");
  });

  it("streamToBuffer rejects non-readable input", () => {
    expect(() => streamToBuffer({} as never)).toThrow("not readable");
  });

  it("isNodeReadableStream identifies node readable streams", () => {
    expect(isNodeReadableStream(Readable.from(["x"]))).toBe(true);
    expect(isNodeReadableStream({})).toBe(false);
    expect(isNodeReadableStream(null)).toBe(false);
  });
});

describe("index: accepts and typeIs compatibility exports", () => {
  it("are the callable functions, not module namespaces", async () => {
    const { accepts, typeIs } = await import("../lib/index");
    // A plain header object, with no cast: both read only `headers`.
    const request = {
      headers: {
        accept: "text/html, application/json;q=0.9",
        "content-type": "application/json; charset=utf-8",
        "content-length": "2",
      },
    };

    expect(typeof accepts).toBe("function");
    expect(typeof typeIs).toBe("function");
    expect(accepts(request).types(["json", "html"])).toBe("html");
    expect(typeIs(request, ["urlencoded", "json"])).toBe("json");
    expect(typeIs.is("application/vnd.api+json", ["+json"])).toBe(
      "application/vnd.api+json",
    );
  });

  it("are the packages' own functions, only retyped", async () => {
    const { accepts, typeIs } = await import("../lib/index");
    const acceptsModule = (await import("accepts")).default;
    const typeIsModule = (await import("type-is")).default;

    expect(accepts as unknown).toBe(acceptsModule);
    expect(typeIs as unknown).toBe(typeIsModule);
  });

  it("accepts negotiates every Accept-* header from plain headers", async () => {
    const { accepts } = await import("../lib/index");
    const negotiation = accepts({
      headers: {
        accept: "text/html, application/json;q=0.9, */*;q=0.1",
        "accept-encoding": "gzip, br;q=0.8",
        "accept-charset": "utf-8, iso-8859-1;q=0.2",
        "accept-language": "en;q=0.8, es",
        "x-unrelated": undefined,
      },
    });

    expect(negotiation.types(["json", "html"])).toBe("html");
    expect(negotiation.types()).toEqual([
      "text/html",
      "application/json",
      "*/*",
    ]);
    expect(negotiation.encodings(["br", "deflate"])).toBe("br");
    expect(negotiation.charsets(["iso-8859-1"])).toBe("iso-8859-1");
    expect(negotiation.languages(["en", "fr"])).toBe("en");
    expect(negotiation.languages(["fr"])).toBe(false);

    // No `Accept` header: the first offered type wins.
    expect(accepts({ headers: {} }).types(["xml", "json"])).toBe("xml");
  });

  it("typeIs decides body presence from transfer-encoding and content-length", async () => {
    const { typeIs } = await import("../lib/index");

    // A type but no body-declaring header: no body, so `null`.
    expect(
      typeIs({ headers: { "content-type": "application/json" } }, ["json"]),
    ).toBeNull();
    // A numeric content-length declares a body, zero included.
    expect(
      typeIs(
        {
          headers: {
            "content-type": "application/json",
            "content-length": "0",
          },
        },
        ["json"],
      ),
    ).toBe("json");
    // transfer-encoding declares one too; spread types work as well.
    expect(
      typeIs(
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "transfer-encoding": "chunked",
          },
        },
        "json",
        "html",
      ),
    ).toBe("html");
    // A body without a content-type matches nothing.
    expect(typeIs({ headers: { "content-length": "2" } }, ["json"])).toBe(
      false,
    );

    expect(typeIs.hasBody({ headers: { "content-length": "12" } })).toBe(true);
    expect(
      typeIs.hasBody({ headers: { "transfer-encoding": "chunked" } }),
    ).toBe(true);
    expect(typeIs.hasBody({ headers: { "content-length": "abc" } })).toBe(
      false,
    );
    expect(typeIs.hasBody({ headers: { "content-length": undefined } })).toBe(
      false,
    );
    expect(typeIs.hasBody({ headers: {} })).toBe(false);
  });

  it("take a BunRequest directly", async () => {
    const { accepts, typeIs } = await import("../lib/index");
    const { makeRequest } = await import("./helpers");
    const request = await makeRequest({
      url: "http://localhost/upload",
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        // A `Request` built in-process carries no Content-Length of its own,
        // and `type-is` decides body presence from the headers alone.
        "content-length": String(JSON.stringify({ ok: true }).length),
      },
      body: JSON.stringify({ ok: true }),
    });

    expect(accepts(request).types(["html", "json"])).toBe("json");
    expect(typeIs.hasBody(request)).toBe(true);
    expect(typeIs(request, ["urlencoded", "json"])).toBe("json");
  });
});
