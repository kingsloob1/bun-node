/**
 * The glob matcher (layers.md L7; plan §11.3): its tokens, and a property
 * test against a reference regex over random paths.
 */
import { describe, expect, it } from "bun:test";
import { compileGlob, globRefusal } from "../../lib/rules/glob";
import { seededRandom } from "../helpers";

/** The reference: the glob as a regex (for the test only). */
function reference(glob: string, ignoreCase: boolean): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      source += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? "is" : "s");
}

describe("compileGlob", () => {
  it.each([
    ["/**/.env*", "/.env", true],
    ["/**/.env*", "/a/b/.env.local", true],
    ["/**/.env*", "/a/env", false],
    ["/*.php", "/a.php", true],
    ["/*.php", "/a/b.php", false],
    ["/**/.git/**", "/x/.git/config", true],
    ["/**/.git/**", "/x/.git", false],
    ["/a?c", "/abc", true],
    ["/a?c", "/a/c", false],
    ["/cgi-bin/**", "/cgi-bin/x/y", true],
    ["/cgi-bin/**", "/cgi-bin", false],
    ["**", "/anything/at/all", true],
    ["/wp-admin", "/WP-Admin", false],
  ] as const)("%p on %p: %p", (glob, input, expected) => {
    expect(compileGlob(glob)(input)).toBe(expected);
  });

  it("folds case when asked", () => {
    expect(compileGlob("/wp-admin/**", true)("/WP-ADMIN/x")).toBe(true);
    expect(compileGlob("/wp-admin/**")("/WP-ADMIN/x")).toBe(false);
  });

  it("refuses an empty glob, an overlong one and ***", () => {
    expect(globRefusal("")).toContain("empty");
    expect(globRefusal("a".repeat(513))).toContain("longer");
    expect(globRefusal("/***")).toContain("***");
    expect(() => compileGlob("")).toThrow(TypeError);
  });

  it("property: agrees with a reference regex on random globs and paths", () => {
    const seed = Number(
      process.env.GLOB_PROPERTY_SEED ?? Date.now() % 1_000_000,
    );
    const random = seededRandom(seed);
    const parts = [
      "/",
      "a",
      "b",
      ".",
      "env",
      "*",
      "**",
      "?",
      "/**/",
      "git",
      "x",
    ];
    const pathParts = [
      "/",
      "a",
      "b",
      ".",
      "env",
      "git",
      "x",
      "/.env",
      "/a/",
      "A",
    ];
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      let glob = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        () => parts[Math.floor(random() * parts.length)],
      ).join("");
      glob = glob.replaceAll("***", "**");
      if (globRefusal(glob) !== undefined) continue;
      const ignoreCase = random() < 0.5;
      const matcher = compileGlob(glob, ignoreCase);
      const expected = reference(glob, ignoreCase);
      for (let j = 0; j < 25; j++) {
        const path = Array.from(
          { length: Math.floor(random() * 7) },
          () => pathParts[Math.floor(random() * pathParts.length)],
        ).join("");
        compared++;
        if (matcher(path) !== expected.test(path)) {
          throw new Error(
            `seed ${seed}: glob ${JSON.stringify(glob)} on ${JSON.stringify(path)} (ignoreCase ${ignoreCase}): ${matcher(path)}, the reference says ${expected.test(path)}`,
          );
        }
      }
    }
    console.log(`glob property seed ${seed}: ${compared} comparisons`);
    expect(compared).toBeGreaterThan(5000);
  });
});
