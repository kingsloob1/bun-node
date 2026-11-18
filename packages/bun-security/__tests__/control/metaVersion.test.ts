/**
 * `/meta`'s `version` (PR-U5, the user's decision of 2026-11-18):
 * bun-security's release, its package's version, which the UI shows the
 * managed rule set as part of. The document declares it.
 */
import { describe, expect, it } from "bun:test";
import { testApi } from "./helpers";

const manifest = (await Bun.file(
  new URL("../../package.json", import.meta.url),
).json()) as { version: string };

describe("GET /meta", () => {
  it("names bun-security's release, beside the protocol version", async () => {
    const { call } = testApi();
    const meta = await call("GET", "/meta");
    expect(meta.body.version).toBe(manifest.version);
    expect(meta.body.version).toMatch(/^\d+\.\d+\.\d+/);
    // The control: the protocol version is a different thing.
    expect(meta.body.protocolVersion).toBe(1);
    const openapi = (await call("GET", "/openapi.json")).body;
    const schema = JSON.stringify(openapi.paths["/meta"].get.responses["200"]);
    expect(
      schema.includes("version") ||
        JSON.stringify(openapi.components ?? {}).includes('"version"'),
    ).toBe(true);
  });
});
