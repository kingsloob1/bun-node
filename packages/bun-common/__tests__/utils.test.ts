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
