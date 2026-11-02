/**
 * The one path from documents to a written file, shared by `bun-client
 * generate` and `bun-client watch` (typed-client plan §3.2, §3.3): generate
 * the module, then write it atomically and only when its content changed.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
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
  /** The zod module (`--zod`, plan §5.2), when it was asked for. */
  readonly zod?: {
    /** Its text. */
    readonly code: string;
    /** What it does not check; also in its header. */
    readonly warnings: readonly CodegenWarning[];
  };
}

/** The zod module to write beside the route map (`--zod`, `--zod-flavour`). */
export interface ZodTarget {
  /** Where the zod module goes, absolute. */
  readonly path: string;
  /** Where the route map goes, absolute: the zod module imports `Routes` from it. */
  readonly routesPath: string;
  /** `"mini"` (`zod/mini`, the default) or `"classic"` (`zod`). */
  readonly flavour: "mini" | "classic";
}

/**
 * The specifier a module at `from` imports the module at `to` with: relative,
 * `./`-led, with the file's `.ts`-family extension dropped (`"./api.gen"`).
 */
export function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to)
    .replaceAll("\\", "/")
    .replace(/\.(?:d\.)?[cm]?tsx?$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * Generates the module for loaded documents, and the zod module when
 * `zod` names one: the step `generate` and `watch` share.
 */
export function emitModule(
  documents: LoadedDocuments,
  zod?: ZodTarget,
): EmittedModule {
  const result = generateRoutes(documents.openapi, {
    ...(documents.asyncapi === undefined
      ? {}
      : { asyncapi: documents.asyncapi }),
    documentWarnings: documents.warnings,
    ...(zod === undefined
      ? {}
      : {
          zod: {
            flavour: zod.flavour,
            routesModule: relativeSpecifier(zod.path, zod.routesPath),
          },
        }),
  });
  return {
    code: result.code,
    hash: result.hash,
    warnings: result.warnings,
    ...(result.zod === undefined ? {} : { zod: result.zod }),
  };
}

/**
 * Checks `--zod` and `--zod-flavour` for a command: the zod target, `null`
 * when `--zod` is not given, or an error message.
 *
 * @param zod `--zod`'s value: the zod module's path.
 * @param flavour `--zod-flavour`'s value.
 * @param out `--out`'s value, the route map's path, which the zod module imports.
 * @param cwd What relative paths resolve from.
 */
export function zodTarget(
  zod: string | undefined,
  flavour: string | undefined,
  out: string | undefined,
  cwd: string,
): ZodTarget | null | string {
  if (zod === undefined)
    return flavour === undefined ? null : "--zod-flavour goes with --zod";
  if (flavour !== undefined && flavour !== "mini" && flavour !== "classic")
    return `--zod-flavour is "mini" or "classic", not "${flavour}"`;
  if (out === undefined)
    return "--zod needs --out: the zod module imports the route map's types from it";
  const path = resolve(cwd, zod);
  const routesPath = resolve(cwd, out);
  if (path === routesPath)
    return `--zod names the same file as --out (${basename(path)})`;
  return { path, routesPath, flavour: flavour ?? "mini" };
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
