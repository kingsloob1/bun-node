#!/usr/bin/env bun
/**
 * The `bun-client` command (typed-client plan §3.2, §10.1, §16):
 *
 * ```bash
 * bun-client generate --url http://127.0.0.1:3000/__bun/types --out src/api.gen.ts
 * bun-client generate --openapi ./openapi.json [--asyncapi ./asyncapi.json] --out src/api.gen.ts
 * bun-client generate --module ./server/app.ts [--export app] --out src/api.gen.ts
 * bun-client generate … --check      # CI: exit 1 when the file is stale
 * ```
 *
 * Exit status: `0` written (or fresh, under `--check`), `1` stale under
 * `--check`, `2` a usage error or a source that could not be read. `watch`
 * (PR-C3) and `--zod`/`--zod-flavour` (PR-C4) are named by the plan and not
 * built yet: they exit `2` saying so.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { DocumentSource } from "./load";
import { loadDocuments } from "./load";
import { generateRoutes } from "./openapi";

/** Where the command writes, and where it reads relative paths from. */
export interface CliIo {
  /** Receives the generated module when there is no `--out`, and progress lines. Default: `process.stdout`. */
  readonly stdout?: (text: string) => void;
  /** Receives warnings and errors. Default: `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** The directory relative paths resolve from. Default: `process.cwd()`. */
  readonly cwd?: string;
}

/** The usage text. */
const USAGE = `Usage:
  bun-client generate <source> [--out <file>] [--check]

Sources (one):
  --url <url>          a URL serving an OpenAPI document, or { hash, openapi, asyncapi }
  --openapi <file>     an OpenAPI 3.x document (JSON, or YAML by extension)
    --asyncapi <file>  an AsyncAPI document beside it (covered by the hash)
  --module <path>      a module exporting a router or a document, documented in process
    --export <name>    the export to read (default: "default")

Options:
  --out <file>         where to write the module (default: stdout)
  --check              write nothing; exit 1 when <file> is not what would be written
  --help               this text
`;

/** The `typesHash` a generated file's header records, for messages. */
function headerHash(text: string): string | undefined {
  return /typesHash: ([0-9a-f]+)/.exec(text)?.[1];
}

/** Writes `text` to `path` atomically: a temporary file beside it, renamed over it. */
async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/**
 * Runs the command with `argv` (without the executable and script).
 *
 * @param argv The arguments: `["generate", "--openapi", "a.json", …]`.
 * @param io Where output goes, and the working directory.
 * @returns The exit status.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = {},
): Promise<number> {
  const out = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();

  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "watch") {
    err(
      "bun-client watch is not built yet (typed-client plan PR-C3); run `bun-client generate` again instead\n",
    );
    return 2;
  }
  if (command !== "generate") {
    err(`bun-client: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: false,
      options: {
        url: { type: "string" },
        openapi: { type: "string" },
        asyncapi: { type: "string" },
        module: { type: "string" },
        export: { type: "string" },
        out: { type: "string" },
        check: { type: "boolean" },
        zod: { type: "string" },
        "zod-flavour": { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    err(`bun-client generate: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help === true) {
    out(USAGE);
    return 0;
  }
  if (values.zod !== undefined || values["zod-flavour"] !== undefined) {
    err(
      "bun-client generate: --zod and --zod-flavour are not built yet (typed-client plan PR-C4)\n",
    );
    return 2;
  }

  const given = (["url", "openapi", "module"] as const).filter(
    (name) => values[name] !== undefined,
  );
  if (given.length !== 1) {
    err(
      `bun-client generate: give exactly one of --url, --openapi or --module${given.length > 1 ? ` (got ${given.map((name) => `--${name}`).join(", ")})` : ""}\n\n${USAGE}`,
    );
    return 2;
  }
  if (values.asyncapi !== undefined && values.openapi === undefined) {
    err("bun-client generate: --asyncapi goes with --openapi\n");
    return 2;
  }
  if (values.export !== undefined && values.module === undefined) {
    err("bun-client generate: --export goes with --module\n");
    return 2;
  }
  if (values.check === true && values.out === undefined) {
    err("bun-client generate: --check needs --out, the file to check\n");
    return 2;
  }

  const source: DocumentSource =
    values.url !== undefined
      ? { url: values.url as string }
      : values.openapi !== undefined
        ? {
            openapi: values.openapi as string,
            ...(values.asyncapi === undefined
              ? {}
              : { asyncapi: values.asyncapi as string }),
          }
        : {
            module: values.module as string,
            ...(values.export === undefined
              ? {}
              : { export: values.export as string }),
          };

  let code: string;
  let hash: string;
  try {
    const documents = await loadDocuments(source, cwd);
    const result = generateRoutes(documents.openapi, {
      ...(documents.asyncapi === undefined
        ? {}
        : { asyncapi: documents.asyncapi }),
      documentWarnings: documents.warnings,
    });
    code = result.code;
    hash = result.hash;
    if (result.warnings.length > 0) {
      err(
        `bun-client generate: ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"} (also in the file's header):\n${result.warnings
          .map((warning) => `  - ${warning.at}: ${warning.message}\n`)
          .join("")}`,
      );
    }
  } catch (error) {
    err(`bun-client generate: ${(error as Error).message}\n`);
    return 2;
  }

  if (values.out === undefined) {
    out(code);
    return 0;
  }
  const path = resolve(cwd, values.out as string);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = undefined;
  }

  if (values.check === true) {
    if (existing === code) {
      out(
        `bun-client generate: ${values.out} is up to date (typesHash ${hash})\n`,
      );
      return 0;
    }
    const was = existing === undefined ? undefined : headerHash(existing);
    err(
      existing === undefined
        ? `bun-client generate: ${values.out} does not exist; run the same command without --check\n`
        : `bun-client generate: ${values.out} is stale (it records typesHash ${was ?? "none"}, the documents hash ${hash}${was === hash ? ", with different content: regenerated by another version of the generator?" : ""}); run the same command without --check\n`,
    );
    return 1;
  }

  if (existing === code) {
    out(`bun-client generate: ${values.out} unchanged (typesHash ${hash})\n`);
    return 0;
  }
  await writeAtomically(path, code);
  out(`bun-client generate: wrote ${values.out} (typesHash ${hash})\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
