import type { FakePlatform } from "@kingsleyweb/bun-jobs/provider/testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertConformance,
  runProviderConformance,
} from "@kingsleyweb/bun-jobs/provider/testing";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import manifest from "../package.json";
import { acme } from "../src/index";
import { acmeFake } from "./fake-platform";

/**
 * The provider against the conformance kit, and the few things the kit
 * cannot know about Acme. The kit needs no credentials: every platform call
 * goes to the fake, and its handoff check starts a real worker, on a
 * temporary SQLite file unless `driver` names another shared backend.
 */

// The kit starts real worker processes: give it time.
setDefaultTimeout(120_000);

/** The fakes a test started, closed after it. */
const platforms: FakePlatform[] = [];
afterEach(async () => {
  await Promise.all(
    platforms.splice(0).map(async (platform) => await platform.close()),
  );
});

/** A fresh fake, closed after the test. */
async function fake(): Promise<FakePlatform> {
  const platform = await acmeFake();
  platforms.push(platform);
  return platform;
}

/** A config for the fake. The kit replaces the token with a canary it then looks for in every log. */
function configFor(platform: FakePlatform) {
  return {
    url: platform.url,
    region: "eu-west",
    pool: "workers",
    apiToken: "acme-test-token-0123456789",
  };
}

describe("Acme Compute", () => {
  it("passes the conformance kit", async () => {
    const platform = await fake();
    const config = configFor(platform);
    const report = await runProviderConformance(acme, {
      config,
      // Each should be refused with a ConfigError naming its path.
      invalidConfigs: [
        { config: { ...config, region: "EU West" }, path: "region" },
        {
          config: { url: platform.url, region: "eu-west", pool: "workers" },
          path: "apiToken",
        },
        {
          config: {
            ...config,
            apiToken: undefined,
            apiTokenFile: "/nonexistent/acme-token",
          },
          path: "apiTokenFile",
        },
      ],
      platform,
    });
    // Throws with the report when a `must` check fails.
    assertConformance(report);
    // A `should` that failed reads `warn`, which assertConformance allows: this provider has none.
    expect(report.checks.filter((check) => check.status === "warn")).toEqual(
      [],
    );
    // What the kit skipped, and nothing else: a check that stops running is a
    // regression too. These are the scale and wake checks, and Acme launches.
    expect(
      report.checks
        .filter((check) => check.status === "skip")
        .map((check) => check.id),
    ).toEqual([
      "summon.capabilities.scale-has-release",
      "summon.capabilities.wake-has-pool-size",
      "summon.scale.target-idempotent",
      "summon.scale.release-to-zero",
      "summon.handoff.scale-down",
    ]);
    // `passes: "argv"`: the worker got its summon id, so the attempt was released by it.
    expect(
      report.checks.find((check) => check.id === "summon.handoff.released")
        ?.detail,
    ).toBe("by id");
  });

  it("declares in package.json what the code declares", () => {
    const { definition } = acme;
    expect(manifest.name).toBe(definition.name);
    expect(manifest.version).toBe(definition.version);
    expect(manifest.keywords).toEqual([
      "bun-jobs-provider",
      "bun-jobs-provider-summon",
    ]);
    expect(manifest["bun-jobs"] as unknown).toEqual({
      facets: ["summon"],
      apiVersion: definition.apiVersion,
    });
  });

  it("reads the token from apiTokenFile, once ready", async () => {
    const platform = await fake();
    const dir = await mkdtemp(join(tmpdir(), "acme-token-"));
    try {
      const file = join(dir, "token");
      await writeFile(file, "acme-file-token-0123456789\n");
      const { apiToken: _, ...config } = configFor(platform);
      const configured = acme({ ...config, apiTokenFile: file });
      await configured.ready;
      expect(configured.config.apiToken).toBe("acme-file-token-0123456789");
      expect(await configured.validate()).toEqual([
        { id: "credentials", status: "pass" },
        { id: "pool", status: "pass" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports an unknown pool from validate(), starting nothing", async () => {
    const platform = await fake();
    const checks = await acme({
      ...configFor(platform),
      pool: "missing",
    }).validate();
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ["credentials", "pass"],
      ["pool", "fail"],
    ]);
    expect(await platform.units()).toEqual([]);
  });
});
