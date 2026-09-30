import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  anchorsOf,
  checkExcerpts,
  checkLinks,
  codeBlocks,
  compileSnippets,
  docFiles,
  isExcerptOf,
  slug,
} from "./docsCheck";
import { PACKAGE } from "./referenceCheck";

/**
 * `docs/providers/` stays true (plugins §15.6): every `ts` block is either a
 * verbatim excerpt of the file it names, or a snippet that compiles against
 * the package; every link resolves. Each check also runs over a broken copy
 * of what it checks, so a checker that passes everything is caught. See
 * `docsCheck.ts` for the rules.
 */

/** Every code block of the docs. */
function allBlocks() {
  return docFiles().flatMap((file) =>
    codeBlocks(file, readFileSync(join(PACKAGE, file), "utf8")),
  );
}

/** The package README's section that links the docs, by its heading. */
function readmeSection(): string {
  const readme = readFileSync(join(PACKAGE, "README.md"), "utf8");
  const start = readme.indexOf("\n### Compute providers\n");
  expect(start).toBeGreaterThan(-1);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

describe("docs/providers", () => {
  it("has the five published pages", () => {
    expect(docFiles()).toEqual([
      "docs/providers/README.md",
      "docs/providers/author-guide.md",
      "docs/providers/reference.md",
      "docs/providers/security.md",
      "docs/providers/user-guide.md",
    ]);
  });

  it("quotes the files it names verbatim", () => {
    const excerpts = allBlocks().filter(
      (block) => block.excerptOf !== undefined,
    );
    expect(excerpts.length).toBeGreaterThan(0);
    expect(checkExcerpts(excerpts)).toEqual([]);
  });

  it("has snippets that compile against the package", () => {
    const blocks = allBlocks();
    expect(
      blocks.filter(
        (block) => block.lang === "ts" && block.excerptOf === undefined,
      ).length,
    ).toBeGreaterThan(0);
    expect(compileSnippets(blocks)).toEqual([]);
  }, 120_000);

  it("has links that resolve", () => {
    const developOnly: string[] = [];
    for (const file of docFiles()) {
      const report = checkLinks(file);
      expect(report.broken).toEqual([]);
      expect(report.checked).toBeGreaterThan(0);
      developOnly.push(...report.developOnly);
    }
    // A GitHub link this tree does not have yet, but origin/develop does,
    // passes; it is printed so it is never silently so.
    if (developOnly.length > 0) {
      // eslint-disable-next-line no-console -- the test's output is where it is reported
      console.info(
        `links found on origin/develop only:\n  ${developOnly.join("\n  ")}`,
      );
    }
  });

  it("is linked from the package README, with links that resolve", () => {
    const section = readmeSection();
    for (const page of [
      "README",
      "author-guide",
      "reference",
      "user-guide",
      "security",
    ]) {
      expect(section).toContain(`](docs/providers/${page}.md)`);
    }
    expect(checkLinks("README.md", section).broken).toEqual([]);
  });

  it("ships: the package's files include docs", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE, "package.json"), "utf8"),
    ) as {
      /** What the tarball includes. */
      files: string[];
    };
    expect(manifest.files).toContain("docs");
  });
});

describe("the docs checks themselves (negative controls)", () => {
  it("refuses an excerpt that is not in its file", () => {
    const source = "const a = 1;\n  if (a) {\n    call(a);\n  }\n";
    expect(isExcerptOf("if (a) {\n  call(a);\n}", source)).toBe(true);
    expect(isExcerptOf("if (a) {\n  call(b);\n}", source)).toBe(false);
    // Lines that exist, but not consecutively.
    expect(isExcerptOf("const a = 1;\n  call(a);", source)).toBe(false);
    const blocks = codeBlocks(
      "x.md",
      "<!-- excerpt: some/file.ts -->\n```ts\nnot there\n```\n",
    );
    expect(checkExcerpts(blocks, () => source)).toEqual([
      "x.md:2: not a verbatim excerpt of some/file.ts",
    ]);
    expect(checkExcerpts(blocks, () => undefined)).toEqual([
      "x.md:2: excerpt of some/file.ts, which does not exist",
    ]);
  });

  it("catches a real excerpt of the template changed by one character", () => {
    const [excerpt] = allBlocks().filter(
      (block) => block.excerptOf !== undefined,
    );
    expect(checkExcerpts([excerpt!])).toEqual([]);
    const changed = { ...excerpt!, code: excerpt!.code.replace(/\S/, "#") };
    expect(checkExcerpts([changed])).toHaveLength(1);
  });

  it("fails a snippet that does not typecheck, and names its line", () => {
    const blocks = codeBlocks(
      "docs/providers/broken.md",
      [
        "Text.",
        "",
        "```ts",
        'import { ProviderError } from "@kingsleyweb/bun-jobs/provider";',
        "",
        'export const error = new ProviderError("x", "slow");',
        "```",
      ].join("\n"),
    );
    const problems = compileSnippets(blocks);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("docs/providers/broken.md:6: TS2345");
  }, 120_000);

  it("fails a link to a missing file, a missing anchor, or outside the package", () => {
    const markdown = [
      "# Title",
      "",
      "[ok](./security.md#the-facts-filter)",
      "[ok](#title)",
      "[missing](./nope.md)",
      "[anchor](./security.md#no-such-heading)",
      "[outside](../../../../CLAUDE.md)",
      "[github](https://github.com/kingsloob1/bun-node/blob/develop/no/such/file.ts)",
      "`[code](./ignored.md)`",
    ].join("\n");
    const report = checkLinks("docs/providers/fake.md", markdown, () => false);
    expect(report.checked).toBe(6);
    expect(report.broken.map((line) => line.split(": ")[0])).toEqual([
      "docs/providers/fake.md:5",
      "docs/providers/fake.md:6",
      "docs/providers/fake.md:7",
      "docs/providers/fake.md:8",
    ]);
    // A GitHub path this tree lacks passes only when origin/develop has it.
    const accepted = checkLinks(
      "docs/providers/fake.md",
      "[github](https://github.com/kingsloob1/bun-node/blob/develop/no/such/file.ts)",
      () => true,
    );
    expect(accepted.broken).toEqual([]);
    expect(accepted.developOnly).toHaveLength(1);
  });

  it("makes anchors the way GitHub does", () => {
    expect(slug("The attempt's detail")).toBe("the-attempts-detail");
    expect(slug("`./provider/testing`: the kit")).toBe(
      "providertesting-the-kit",
    );
    expect([...anchorsOf("# A\n## A\n```\n# not\n```\n")]).toEqual([
      "a",
      "a-1",
    ]);
  });
});
