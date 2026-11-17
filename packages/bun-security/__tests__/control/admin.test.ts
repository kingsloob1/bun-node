/**
 * `secureAdmin` (README §3.6): the admin listener binds loopback or an
 * internal address and serves the API there; a public or wildcard bind is
 * refused unless allowed with client certificates or a trusted proxy; the
 * API and UI are mounted apart.
 */
import { describe, expect, it } from "bun:test";
import { BunRouter, ConfigError } from "@kingsleyweb/bun-common";
import { isPrivateBind, secureAdmin } from "../../lib/control/index";
import { testApi } from "./helpers";

describe("secureAdmin", () => {
  it("serves the API on loopback (port 0)", async () => {
    const { api } = testApi();
    const admin = await secureAdmin({ port: 0, api, logger: () => {} });
    try {
      expect(admin.url).toBe(`http://127.0.0.1:${admin.port}`);
      const response = await fetch(`${admin.url}${api.basePath}/meta`, {
        headers: { "x-op": "alice" },
      });
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { signingKeyId: string }).signingKeyId,
      ).toBe("sk_test");
    } finally {
      await admin.close();
    }
  });

  it("refuses a public or wildcard bind unless allowed with client certificates or a trusted proxy", async () => {
    const { api } = testApi();
    for (const hostname of [
      "0.0.0.0",
      "::",
      "203.0.113.5",
      "admin.example.com",
    ]) {
      expect(isPrivateBind(hostname)).toBe(false);
      await expect(secureAdmin({ hostname, port: 0, api })).rejects.toThrow(
        ConfigError,
      );
    }
    await expect(
      secureAdmin({ hostname: "0.0.0.0", port: 0, api, allowPublicBind: true }),
    ).rejects.toThrow(/client certificates/);
    for (const hostname of [
      "127.0.0.1",
      "::1",
      "localhost",
      "10.1.2.3",
      "192.168.0.4",
    ]) {
      expect(isPrivateBind(hostname)).toBe(true);
    }
  });

  it("refuses a UI mounted at or under the API's path", async () => {
    const { api } = testApi();
    await expect(
      secureAdmin({
        port: 0,
        api,
        ui: { basePath: `${api.basePath}/ui`, router: new BunRouter() },
      }),
    ).rejects.toThrow(/mounted apart/);
  });
});
