import type { ExportInfo } from "./referenceCheck";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  checkReference,
  entryExports,
  parseReference,
  REFERENCE_ENTRIES,
  REFERENCE_PATH,
} from "./referenceCheck";

/**
 * The API reference's drift test (plugins §15.3): `docs/providers/reference.md`
 * names every export of `./provider`, `./provider/testing` and `./summon`, and
 * every member of each type, and nothing that is not there. See
 * `referenceCheck.ts` for the rules.
 */

/** The reference as it is on disk. */
const reference = readFileSync(REFERENCE_PATH, "utf8");

/** The reference with one line removed: the first that matches. */
function without(pattern: RegExp): string {
  const lines = reference.split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  expect(index).toBeGreaterThan(-1);
  lines.splice(index, 1);
  return lines.join("\n");
}

describe("docs/providers/reference.md", () => {
  it("matches the entries' exports and their members", () => {
    expect(checkReference(reference)).toEqual([]);
  }, 60_000);

  it("reads the entries the way they load at run time", async () => {
    // The compiler's view of the values and the runtime's agree, so a value
    // the checker missed cannot hide behind a type.
    for (const spelling of Object.keys(REFERENCE_ENTRIES)) {
      const loaded = Object.keys(
        (await import(spelling)) as Record<string, unknown>,
      ).sort();
      const values = entryExports(spelling)
        .filter((info) => info.value)
        .map((info) => info.name)
        .sort();
      expect(values).toEqual(loaded);
    }
  });
});

describe("the drift check (negative controls)", () => {
  it("fails an export with no heading", () => {
    expect(checkReference(without(/^### `ProviderError`/))).toContain(
      "@kingsleyweb/bun-jobs/provider: export `ProviderError` has no heading",
    );
  });

  it("fails a heading with no export", () => {
    const extra = reference.replace(
      "## `@kingsleyweb/bun-jobs/provider/testing`",
      "### `removedLongAgo`\n\nGone.\n\n## `@kingsleyweb/bun-jobs/provider/testing`",
    );
    expect(checkReference(extra)).toContain(
      "@kingsleyweb/bun-jobs/provider: heading `removedLongAgo` is not an export",
    );
  });

  it("fails a member with no bullet", () => {
    expect(checkReference(without(/^- `dedupeKey`/))).toContain(
      "`SummonRequest`: member `dedupeKey` has no bullet",
    );
  });

  it("fails a bullet for a member that is not there", () => {
    const extra = reference.replace(
      /^- `dedupeKey`/m,
      "- `oldField`: removed.\n- `dedupeKey`",
    );
    expect(checkReference(extra)).toContain(
      "`SummonRequest`: bullet `oldField` is not a member",
    );
  });

  it("fails an export added to the code but not the reference", () => {
    const exportsOf = (spelling: string): ExportInfo[] => [
      ...entryExports(spelling),
      ...(spelling === "@kingsleyweb/bun-jobs/summon"
        ? [
            {
              name: "brandNewThing",
              value: true,
              members: [],
              declaredAt: "virtual:brandNewThing",
            },
          ]
        : []),
    ];
    expect(checkReference(reference, exportsOf)).toEqual([
      "@kingsleyweb/bun-jobs/summon: export `brandNewThing` has no heading",
    ]);
  });

  it("fails a missing entry section", () => {
    const withoutSection = reference.replace(
      "## `@kingsleyweb/bun-jobs/summon`",
      "## The summon entry",
    );
    expect(checkReference(withoutSection)).toContain(
      "no section `## `@kingsleyweb/bun-jobs/summon``",
    );
  });

  it("parses headings and top-level bullets only, outside code", () => {
    const parsed = parseReference(
      [
        "## `x`",
        "### `A`",
        "- `one`: a member.",
        "  - `nested`: not a member bullet.",
        "```ts",
        "- `inCode`",
        "```",
        "- `two`",
        "#### Notes",
        "- `afterNotes`",
      ].join("\n"),
    );
    expect(parsed.get("x")).toEqual([{ name: "A", bullets: ["one", "two"] }]);
  });
});
