/**
 * The kit's bundle code (`lib/kit/assets.ts`) as each UI binds it: a UI's
 * name picks `app/<ui>/main.tsx` and `dist/<ui>/`, the in-memory build's
 * notice names that `dist/<ui>`, and a bad configuration throws the error the
 * caller makes, never one of the kit's own. The jobs and docs bindings
 * (`lib/<ui>/assets.ts`) keep the names they had before the kit.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "@kingsleyweb/bun-common";
import { ConfigError as JobsConfigError } from "@kingsleyweb/bun-jobs";
import { afterAll, describe, expect, it } from "bun:test";
import * as docsAssets from "../../../lib/docs/assets";
import * as jobsAssets from "../../../lib/jobs/assets";
import {
  PACKAGE_DIR,
  resolveAssetSource,
  uiDistDir,
  uiEntry,
} from "../../../lib/kit/assets";

/** A third UI's error class. */
class TestUiError extends Error {}

const SCRATCH = mkdtempSync(join(tmpdir(), "bun-ui-kit-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/**
 * A copy of the jobs server tests' fixture app (one stylesheet, one split
 * chunk) at a path of its own: the in-memory build is cached per entry for
 * the process, and only a first build logs its notice.
 */
const FIXTURE_ENTRY = (() => {
  const app = join(SCRATCH, "app");
  cpSync(
    join(import.meta.dir, "..", "..", "jobs", "server", "fixtures", "app"),
    app,
    { recursive: true },
  );
  return join(app, "entry.ts");
})();

describe("the kit's assets, per UI", () => {
  it("names a UI's entry and dist directory after it", () => {
    expect(uiEntry("security")).toBe(
      join(PACKAGE_DIR, "app", "security", "main.tsx"),
    );
    expect(uiDistDir("security")).toBe(join(PACKAGE_DIR, "dist", "security"));
    expect(jobsAssets.DEFAULT_ENTRY).toBe(uiEntry("jobs"));
    expect(jobsAssets.DEFAULT_DIST_DIR).toBe(uiDistDir("jobs"));
    expect(docsAssets.DEFAULT_ENTRY).toBe(uiEntry("docs"));
    expect(docsAssets.DEFAULT_DIST_DIR).toBe(uiDistDir("docs"));
  });

  it("names the UI's dist/<ui> in the in-memory build's notice", async () => {
    const { logger, events } = createTestLogger();
    const load = resolveAssetSource({
      ui: "security",
      dev: undefined,
      distDir: join(SCRATCH, "none"),
      entry: FIXTURE_ENTRY,
      logger,
      fail: (message) => new TestUiError(message),
    });
    const assets = await load();
    expect(assets.source).toBe("memory");
    expect(events.map((event) => event.message)).toEqual([
      "bun-ui: no dist/security build, bundling the app in memory (run `bun scripts/build.ts` to prebuild)",
    ]);
  });

  it("throws the caller's error for dev: false with no build, and for a corrupt one", () => {
    const { logger } = createTestLogger();
    const options = {
      ui: "security",
      entry: FIXTURE_ENTRY,
      logger,
      fail: (message: string) => new TestUiError(message),
    };
    expect(() =>
      resolveAssetSource({
        ...options,
        dev: false,
        distDir: join(SCRATCH, "none"),
      }),
    ).toThrow(TestUiError);
    const corrupt = join(SCRATCH, "corrupt");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "manifest.json"), "{ not json");
    expect(() =>
      resolveAssetSource({ ...options, dev: undefined, distDir: corrupt }),
    ).toThrow(TestUiError);
  });

  it("keeps each UI's own error class through its binding", () => {
    const corrupt = join(SCRATCH, "corrupt-bindings");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "manifest.json"), "{ not json");
    const docsError = (() => {
      try {
        docsAssets.loadDistAssets(corrupt);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect((docsError as Error).name).toBe("ConfigError");
    expect(docsError).not.toBeInstanceOf(JobsConfigError);
    // The jobs binding takes the error it throws, as before the kit.
    expect(() =>
      jobsAssets.loadDistAssets(
        corrupt,
        (message, context) => new JobsConfigError(message, context),
      ),
    ).toThrow(JobsConfigError);
  });
});
