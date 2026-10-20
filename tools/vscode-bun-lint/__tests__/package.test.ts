// The README's install step, `bun run package`, run as written: it must exit
// 0, pack only the bundle, the manifest and the README, and leave no README
// link that is broken outside the repository (vsce refuses a relative link
// it cannot resolve, and resolves one by plain concatenation onto
// `--baseContentUrl`). The first run fetches @vscode/vsce through `bunx`, so
// it needs the network once; afterwards it runs from Bun's cache (measured:
// 1.8 s, also with the registry unreachable). Needs `unzip` to read the .vsix.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { expect, test } from "bun:test";
import { runBun } from "../src/core/bun";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "../..");
const VSIX = join(ROOT, "dist/vscode-bun-lint.vsix");
const BLOB = "https://github.com/kingsloob1/bun-node/blob/develop/";

/**
 * Runs `unzip` on the package.
 * @param args The arguments before the archive.
 * @param rest The arguments after it.
 * @returns Standard output.
 */
async function unzip(args: string[], rest: string[] = []): Promise<string> {
  const result = await runBun("unzip", [...args, VSIX, ...rest], { cwd: ROOT });
  if (result.code !== 0) throw new Error(`unzip failed: ${result.stderr}`);
  return result.stdout;
}

test("bun run package exits 0 and packs a README whose links resolve", async () => {
  const run = await runBun(process.execPath, ["run", "package"], {
    cwd: ROOT,
    timeoutMs: 110_000,
  });
  expect({ code: run.code, stderr: run.code === 0 ? "" : run.stderr }).toEqual({
    code: 0,
    stderr: "",
  });

  const names = (await unzip(["-Z1"])).trim().split("\n").sort();
  expect(names).toEqual([
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/dist/extension.js",
    "extension/package.json",
    "extension/readme.md",
  ]);

  const readme = await unzip(["-p"], ["extension/readme.md"]);
  const links = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) {
    if (link.startsWith("#")) continue;
    const href = new URL(link).href;
    expect(href.startsWith(BLOB)).toBe(true);
    const path = decodeURIComponent(href.slice(BLOB.length).split("#")[0]);
    expect({ link, exists: existsSync(resolve(REPO, path)) }).toEqual({
      link,
      exists: true,
    });
  }
}, 120_000);
