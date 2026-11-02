/**
 * The one path from documents to a written file, shared by `bun-client
 * generate` and `bun-client watch` (typed-client plan §3.2, §3.3): generate
 * the module, then write it atomically and only when its content changed.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";
import type { LoadedDocuments } from "./load";
import type { CodegenWarning } from "./openapi";
import { generateRoutes } from "./openapi";

/** What {@link emitModule} produced. */
export interface EmittedModule {
  /** The module's text. */
  readonly code: string;
  /** The documents' hash, as the module's header records it. */
  readonly hash: string;
  /** What the generator (and the documents' producer) warned about. */
  readonly warnings: readonly CodegenWarning[];
}

/** Generates the module for loaded documents: the step `generate` and `watch` share. */
export function emitModule(documents: LoadedDocuments): EmittedModule {
  const result = generateRoutes(documents.openapi, {
    ...(documents.asyncapi === undefined
      ? {}
      : { asyncapi: documents.asyncapi }),
    documentWarnings: documents.warnings,
  });
  return { code: result.code, hash: result.hash, warnings: result.warnings };
}

/** The warnings as the commands print them, under `prefix` (`"bun-client generate"`). */
export function formatWarnings(
  prefix: string,
  warnings: readonly CodegenWarning[],
): string {
  return `${prefix}: ${warnings.length} warning${warnings.length === 1 ? "" : "s"} (also in the file's header):\n${warnings
    .map((warning) => `  - ${warning.at}: ${warning.message}\n`)
    .join("")}`;
}

/** The `typesHash` a generated file's header records, if it has one. */
export function headerHash(text: string): string | undefined {
  return /typesHash: ([0-9a-f]+)/.exec(text)?.[1];
}

/** Reads `path`, or `undefined` when it cannot be read (it does not exist, say). */
export async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A counter making two temporary names of one process and millisecond differ. */
let temporaryCounter = 0;

/**
 * Writes `text` to `path` atomically: a temporary file beside it (so on the
 * same file system), renamed over it. A reader sees the old file or the new
 * one, never a part; the temporary file is removed when the write fails.
 */
export async function writeAtomically(
  path: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryCounter += 1;
  const temporary = `${path}.${process.pid}.${Date.now()}.${temporaryCounter}.tmp`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Writes `text` to `path` (atomically) unless the file already holds exactly
 * that, so an unchanged file keeps its modification time and an editor or
 * `--watch` process sees no change.
 *
 * @returns `"written"`, or `"unchanged"` when nothing was written.
 */
export async function writeIfChanged(
  path: string,
  text: string,
): Promise<"written" | "unchanged"> {
  if ((await readExisting(path)) === text) return "unchanged";
  await writeAtomically(path, text);
  return "written";
}
