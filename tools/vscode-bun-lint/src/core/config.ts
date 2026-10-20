/**
 * Where to run `bun`, and whether a file is ours to lint or format at all.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The working directory for a file: its own directory (plan §5). Bun reads
 * the `bunfig.toml` nearest the working directory, so this finds the root
 * one for every directory of the repo and the template's own inside
 * `templates/compute-provider`; a `[lint.overrides]` glob is relative to the
 * `bunfig.toml`, not to the working directory (measured: `scripts/**`
 * matched from the root, `scripts/` and `scripts/__tests__/` alike), and a
 * package's `lint` script runs from the package directory, so the result is
 * the same as the gate's `bun run lint` there (the 11-directory test checks
 * it).
 * @param filePath The file, absolute.
 * @returns The directory to spawn `bun` in.
 */
export function workingDirectory(filePath: string): string {
  return dirname(filePath);
}

/** Reads a file's text, or `undefined` when it cannot be read. */
export type ReadText = (path: string) => string | undefined;

/**
 * Reads a file with `node:fs`.
 * @param path The file.
 * @returns Its text, or `undefined` when it is missing or unreadable.
 */
export const readText: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Whether a `bunfig.toml`'s text has a `[section]` table, or a sub-table or
 * array of tables of it (`[lint.rules]`, `[[lint.overrides]]`).
 * @param text The file's text.
 * @param section `lint` or `fmt`.
 * @returns Whether the section is there.
 */
export function hasSection(text: string, section: "lint" | "fmt"): boolean {
  return new RegExp(`^\\s*\\[{1,2}\\s*${section}\\s*[\\].]`, "m").test(text);
}

/**
 * The `bunfig.toml` nearest a directory, walking up to the filesystem root.
 * @param dir Where to start.
 * @param read How to read a file (the tests pass a map).
 * @returns The path and text of the nearest one, or `undefined`.
 */
export function nearestBunfig(
  dir: string,
  read: ReadText = readText,
): { path: string; text: string } | undefined {
  let current = dir;
  for (;;) {
    const path = join(current, "bunfig.toml");
    const text = read(path);
    if (text !== undefined) return { path, text };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Whether the extension should run a tool on a file: the nearest
 * `bunfig.toml` (the one Bun will read) configures it. Keeps an installed
 * extension out of every other project on the machine.
 * @param filePath The file, absolute.
 * @param section `lint` for diagnostics, `fmt` for formatting.
 * @param read How to read a file.
 * @returns Whether to run.
 */
export function isConfigured(
  filePath: string,
  section: "lint" | "fmt",
  read: ReadText = readText,
): boolean {
  const found = nearestBunfig(workingDirectory(filePath), read);
  return found !== undefined && hasSection(found.text, section);
}
