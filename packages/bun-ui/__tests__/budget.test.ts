/**
 * The bundle budgets, one row per UI: each UI's real app is built exactly as
 * `scripts/build.ts` builds it (the kit's `buildAssets` over `app/<ui>/`),
 * and the test fails when its entry module, or any other chunk, grows past
 * the row's limits. The entry is what every page load pays for before the
 * first screen can render; a chunk is what opening one screen costs.
 *
 * To raise one deliberately: run `bun scripts/build.ts --ui <ui> --out <tmp dir>`,
 * which prints every file's size and gzipped size, set the limit about 10%
 * above the new figure, update the row's measurements, and say in the change
 * why the bundle grew. Never raise one only to make this test pass. A new UI
 * adds a row from its first build.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildAssets, uiEntry } from "../lib/kit/assets";

/** One UI's limits, in bytes. */
interface BundleBudget {
  /** The entry module (`manifest.entry.js`), minified. */
  entryBytes: number;
  /** The entry module gzipped (`Bun.gzipSync`, default level). */
  entryGzipBytes: number;
  /** Any other JavaScript file of the build (a lazy screen or a shared chunk), minified. */
  chunkBytes: number;
  /** Any other JavaScript file, gzipped. */
  chunkGzipBytes: number;
  /** Whether the build must split off at least one lazy chunk. */
  lazy: boolean;
}

/**
 * Byte limits per UI, each about 10% above what the build measured when it
 * was set.
 *
 * **jobs**
 * - Entry, raised 2026-09-21 (Bun 1.4.3): measured 316.4 KiB (101.6 KiB
 *   gzipped), leaving 0.4 KiB of gzipped room under the old 320 / 102 KiB.
 *   Why it grew: the UI-updates round added the Workers screens, worker
 *   control, the time-range model and picker, the analytics client and the
 *   contract's new constants. Every new screen and section went into a lazy
 *   chunk; what reached the entry is the shared code the Overview and the
 *   layout need at first paint (nav entries, the range picker and its URL
 *   state, the contract's constant arrays). The user decided to raise it
 *   rather than move the Overview's range control and queue table out of the
 *   entry.
 * - Chunks, raised 2026-10-27 (the AD (f) F2 migration): the API docs chunk
 *   is the package's screens now (`@kingsleyweb/bun-ui/docs/embed`),
 *   measured 92.0 KiB (29.9 KiB gzipped), up from 66.7 KiB (21.2 KiB
 *   gzipped) on 2026-09-21. Why it grew: the package's screens bundled the
 *   package's own copies of the shared components (Card, Dialog, JsonView,
 *   …), which the entry chunk also carried. The kit (BU-4, 2026-11-10) made
 *   them one copy (`app/kit/`): the largest chunk went from 93.7 KiB
 *   (30.4 KiB gzipped) to 76.4 KiB (24.7 KiB gzipped), the entry from
 *   330.0 to 329.9 KiB (106.5 to 106.5 KiB gzipped); the limits stay.
 *
 * **docs**
 * - Set 2026-10-27 (Bun 1.4.4): measured 330.8 KiB (103.2 KiB gzipped) —
 *   React 19, TanStack Query, the two references and their components, all
 *   in one entry (there is no lazy split: which reference renders depends on
 *   the document, known only after it loads). A split chunk, if one ever
 *   appears, is held to 120 / 40 KiB. With the kit (BU-4, 2026-11-10): 339.6
 *   to 339.9 KiB (106.1 to 106.2 KiB gzipped), the bindings that hand the
 *   kit's components the viewer's `isApiError` and query reset.
 */
const BUNDLE_BUDGETS: Readonly<Record<string, BundleBudget>> = {
  jobs: {
    entryBytes: 348 * 1024,
    entryGzipBytes: 112 * 1024,
    chunkBytes: 101 * 1024,
    chunkGzipBytes: 33 * 1024,
    lazy: true,
  },
  docs: {
    entryBytes: 365 * 1024,
    entryGzipBytes: 114 * 1024,
    chunkBytes: 120 * 1024,
    chunkGzipBytes: 40 * 1024,
    lazy: false,
  },
};

/** Formats bytes as KiB with one decimal, for failure messages. */
function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

for (const [ui, budget] of Object.entries(BUNDLE_BUDGETS)) {
  const assets = await buildAssets({ entry: uiEntry(ui) });
  const entry = assets.files.get(assets.entry.js)!;
  const chunks = [...assets.files.values()].filter(
    (file) => file.name.endsWith(".js") && file.name !== assets.entry.js,
  );

  describe(`the ${ui} bundle budget`, () => {
    it(
      budget.lazy
        ? "builds an entry and at least one lazy chunk"
        : "builds an entry module",
      () => {
        expect(entry).toBeDefined();
        if (budget.lazy) {
          expect(chunks.length).toBeGreaterThan(0);
        }
      },
    );

    it(`keeps the entry module within ${kib(budget.entryBytes)} (${kib(budget.entryGzipBytes)} gzipped)`, () => {
      const gzip = Bun.gzipSync(entry.body).byteLength;
      // Compared as text, so a failure names the file and both sizes.
      const measured = `${entry.name}: ${kib(entry.size)}, gzip ${kib(gzip)}`;
      expect(
        entry.size <= budget.entryBytes && gzip <= budget.entryGzipBytes
          ? "within budget"
          : measured,
      ).toBe("within budget");
    });

    it(`keeps every other chunk within ${kib(budget.chunkBytes)} (${kib(budget.chunkGzipBytes)} gzipped)`, () => {
      const over = chunks
        .map((file) => ({
          name: file.name,
          size: file.size,
          gzip: Bun.gzipSync(file.body).byteLength,
        }))
        .filter(
          (file) =>
            file.size > budget.chunkBytes || file.gzip > budget.chunkGzipBytes,
        )
        .map(
          (file) => `${file.name}: ${kib(file.size)}, gzip ${kib(file.gzip)}`,
        );
      expect(over).toEqual([]);
    });
  });
}

describe("the budget rows", () => {
  it("name every UI with an app entry (`app/<ui>/main.tsx`)", () => {
    const uis = [
      ...new Bun.Glob("*/main.tsx").scanSync({
        cwd: join(import.meta.dir, "..", "app"),
      }),
    ]
      .map((path) => path.split("/")[0])
      .sort();
    expect(uis).toEqual(["docs", "jobs"]);
    expect(Object.keys(BUNDLE_BUDGETS).sort()).toEqual(uis);
  });
});
