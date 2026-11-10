/**
 * The kit sits under every UI, never beside one: nothing in `lib/kit/` or
 * `app/kit/` imports a UI's own code (`lib/<ui>/`, `app/<ui>/`), so a third
 * UI built on the kit carries none of the jobs UI or the docs viewer. A
 * seam a UI must fill (its `ApiError`, its query reset, its error class) is a
 * parameter the UI binds (`app/<ui>/components/*`, `lib/<ui>/assets.ts`).
 * `entryIsolation.test.ts` checks the packages an entry reaches; this checks
 * the package's own layers.
 */
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..", "..", "..");

const transpiler = new Bun.Transpiler({ loader: "tsx" });

/** The UI a package path belongs to (`app/jobs/x.ts` → `jobs`), or `null` for the kit and anything else. */
function uiOf(path: string): string | null {
  const match = /^(?:app|lib)\/([^/]+)\//.exec(path);
  return match && match[1] !== "kit" ? match[1] : null;
}

/** Each relative import of `source` (a file at `file`, package-relative) that lands in a UI's own code. */
function crossings(file: string, source: string): string[] {
  return transpiler
    .scanImports(source)
    .map((entry) => entry.path)
    .filter((spec) => spec.startsWith("."))
    .map((spec) => relative(ROOT, resolve(ROOT, dirname(file), spec)))
    .filter((target) => uiOf(target) !== null)
    .map((target) => `${file} → ${target}`);
}

describe("the kit's layering", () => {
  it("imports no UI's own code from lib/kit or app/kit", async () => {
    const found: string[] = [];
    let files = 0;
    for (const dir of ["lib/kit", "app/kit"]) {
      for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({
        cwd: join(ROOT, dir),
      })) {
        const file = `${dir}/${rel}`;
        files++;
        found.push(...crossings(file, await Bun.file(join(ROOT, file)).text()));
      }
    }
    expect(files).toBeGreaterThan(40);
    expect(found).toEqual([]);
  });

  it("negative control: sees a kit component reaching into a UI", () => {
    expect(
      crossings(
        "app/kit/components/ErrorView.tsx",
        'import { isApiError } from "../../jobs/api/errors";\nimport { Button } from "./Button";',
      ),
    ).toEqual(["app/kit/components/ErrorView.tsx → app/jobs/api/errors"]);
    expect(
      crossings(
        "lib/kit/assets.ts",
        'import { DOCS_UI_CONFIG_ELEMENT_ID } from "../docs/browser/config";',
      ),
    ).toEqual(["lib/kit/assets.ts → lib/docs/browser/config"]);
    expect(
      crossings("app/kit/theme.ts", 'import "../../lib/kit/browser/shared";'),
    ).toEqual([]);
  });
});
