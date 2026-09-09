import { describe, expect, it } from "bun:test";
import * as barrel from "../lib/index";

describe("@kingsleyweb/bun-jobs barrel", () => {
  it("resolves as an ES module", () => {
    expect(typeof barrel).toBe("object");
  });

  it("can reach bun-common through the workspace link", async () => {
    const common = await import("@kingsleyweb/bun-common");
    expect(typeof common.createDeferred).toBe("function");
  });
});
