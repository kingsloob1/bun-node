#!/usr/bin/env bun
/**
 * The `bun-client` command (typed-client plan §3.2, §10.1, §16):
 *
 * ```bash
 * bun-client generate --url http://127.0.0.1:3000/__bun/types --out src/api.gen.ts
 * bun-client generate --openapi ./openapi.json [--asyncapi ./asyncapi.json] --out src/api.gen.ts
 * bun-client generate --module ./server/app.ts [--export app] --out src/api.gen.ts
 * bun-client generate … --check      # CI: exit 1 when the file is stale
 * bun-client generate … --out src/api.gen.ts --zod src/api.zod.gen.ts [--zod-flavour classic]
 * bun-client watch --out src/api.gen.ts [--zod src/api.zod.gen.ts] [--url <url>] [--token-file <path>]
 * ```
 *
 * Exit status: `0` written (or fresh, under `--check`; for `watch`, stopped),
 * `1` stale under `--check` (either file, with `--zod`), `2` a usage error
 * or a source that could not be read. `--zod` (PR-C4) writes the runtime zod
 * schemas beside the route map, for both commands.
 *
 * `generate --url` against a dev endpoint (bun-common's `devTypes()`) sends
 * the bearer token of the matching token file (plan §3.3), the one `watch`
 * reads; a URL no token file names is fetched without one.
 */
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import type { DocumentSource } from "./load";
import { devServerFor, readDevServers, tokenDirectory } from "./devServer";
import type { ZodTarget } from "./emit";
import {
  emitModule,
  formatWarnings,
  headerHash,
  readExisting,
  writeAtomically,
  zodTarget,
} from "./emit";
import { loadDocuments } from "./load";
import { watchDevServer } from "./watch";

/** Where the command writes, and where it reads relative paths from. */
export interface CliIo {
  /** Receives the generated module when there is no `--out`, and progress lines. Default: `process.stdout`. */
  readonly stdout?: (text: string) => void;
  /** Receives warnings and errors. Default: `process.stderr`. */
  readonly stderr?: (text: string) => void;
  /** The directory relative paths resolve from. Default: `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Stops `watch`, which otherwise runs until SIGINT or SIGTERM. Given, the
   * command installs no signal handler (the caller owns stopping). Default:
   * none.
   */
  readonly signal?: AbortSignal;
}

/** The usage text. */
const USAGE = `Usage:
  bun-client generate <source> [--out <file>] [--zod <file>] [--check]
  bun-client watch --out <file> [--zod <file>] [--url <url>] [--token-file <path>]

Sources (one):
  --url <url>          a URL serving an OpenAPI document, or { hash, openapi, asyncapi }
  --openapi <file>     an OpenAPI 3.x document (JSON, or YAML by extension)
    --asyncapi <file>  an AsyncAPI document beside it (covered by the hash)
  --module <path>      a module exporting a router or a document, documented in process
    --export <name>    the export to read (default: "default")

Options:
  --out <file>         where to write the module (default: stdout)
  --check              write nothing; exit 1 when <file> is not what would be written
  --zod <file>         also write the runtime zod schemas there (needs --out)
  --zod-flavour <f>    "mini" (zod/mini, the default) or "classic" (zod)
  --token-file <path>  a dev server's token file, or a directory of them
                       (default: the nearest node_modules/.cache/bun-types)
  --help               this text

watch keeps --out in step with a running dev server (bun-common's devTypes()),
found through its token file: the only one running, or the one at --url. It
regenerates when the server's documents change, and stops on Ctrl-C.
`;

/** The resolved {@link CliIo}. */
interface Io {
  /** Standard output. */
  readonly out: (text: string) => void;
  /** Standard error. */
  readonly err: (text: string) => void;
  /** The working directory. */
  readonly cwd: string;
  /** The caller's stop signal, when given. */
  readonly signal: AbortSignal | undefined;
}

/**
 * Runs the command with `argv` (without the executable and script).
 *
 * @param argv The arguments: `["generate", "--openapi", "a.json", …]`.
 * @param io Where output goes, the working directory, and what stops `watch`.
 * @returns The exit status (for `watch`, once it is stopped).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = {},
): Promise<number> {
  const resolved: Io = {
    out: io.stdout ?? ((text: string) => void process.stdout.write(text)),
    err: io.stderr ?? ((text: string) => void process.stderr.write(text)),
    cwd: io.cwd ?? process.cwd(),
    signal: io.signal,
  };
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "help") {
    resolved.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "generate") return generate(rest, resolved);
  if (command === "watch") return watch(rest, resolved);
  resolved.err(`bun-client: unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

/** Parses `args` strictly with `options`; `undefined` (after printing why) on a usage error. */
function parse<const T extends Record<string, { type: "string" | "boolean" }>>(
  name: string,
  args: readonly string[],
  options: T,
  { out, err }: Io,
):
  | { [K in keyof T]?: T[K]["type"] extends "boolean" ? boolean : string }
  | undefined {
  try {
    const { values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: { ...options, help: { type: "boolean" } },
    });
    if ((values as Record<string, unknown>).help === true) {
      out(USAGE);
      return undefined;
    }
    return values;
  } catch (error) {
    err(`bun-client ${name}: ${(error as Error).message}\n\n${USAGE}`);
    return undefined;
  }
}

/** Whether `args` asks for help (so a `parse` that returned nothing succeeded). */
function asksHelp(args: readonly string[]): boolean {
  return args.includes("--help");
}

/** `bun-client generate`. */
async function generate(args: readonly string[], io: Io): Promise<number> {
  const { out, err, cwd } = io;
  const values = parse(
    "generate",
    args,
    {
      url: { type: "string" },
      openapi: { type: "string" },
      asyncapi: { type: "string" },
      module: { type: "string" },
      export: { type: "string" },
      out: { type: "string" },
      check: { type: "boolean" },
      "token-file": { type: "string" },
      zod: { type: "string" },
      "zod-flavour": { type: "string" },
    },
    io,
  );
  if (values === undefined) return asksHelp(args) ? 0 : 2;
  const zod = zodTarget(values.zod, values["zod-flavour"], values.out, cwd);
  if (typeof zod === "string") {
    err(`bun-client generate: ${zod}\n`);
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
  if (values["token-file"] !== undefined && values.url === undefined) {
    err("bun-client generate: --token-file goes with --url\n");
    return 2;
  }
  if (values.check === true && values.out === undefined) {
    err("bun-client generate: --check needs --out, the file to check\n");
    return 2;
  }

  let source: DocumentSource;
  /** The token file whose token was sent, for a refusal's message. */
  let tokenFile: string | undefined;
  if (values.url !== undefined) {
    // A dev endpoint a token file names gets its token (plan §3.3); any
    // other URL is fetched as it is.
    const tokenPath =
      values["token-file"] === undefined
        ? tokenDirectory(cwd)
        : resolve(cwd, values["token-file"]);
    const server = devServerFor(
      values.url,
      await readDevServers(tokenPath),
      "endpoint",
    );
    tokenFile = server?.file;
    source = {
      url: values.url,
      ...(server === undefined
        ? {}
        : { headers: { authorization: `Bearer ${server.token}` } }),
    };
  } else if (values.openapi !== undefined) {
    source = {
      openapi: values.openapi,
      ...(values.asyncapi === undefined ? {} : { asyncapi: values.asyncapi }),
    };
  } else {
    source = {
      module: values.module as string,
      ...(values.export === undefined ? {} : { export: values.export }),
    };
  }

  let code: string;
  let hash: string;
  let zodCode: string | undefined;
  try {
    const emitted = emitModule(
      await loadDocuments(source, cwd),
      zod ?? undefined,
    );
    code = emitted.code;
    hash = emitted.hash;
    zodCode = emitted.zod?.code;
    if (emitted.warnings.length > 0) {
      err(formatWarnings("bun-client generate", emitted.warnings));
    }
    if (emitted.zod !== undefined && emitted.zod.warnings.length > 0) {
      err(formatWarnings("bun-client generate --zod", emitted.zod.warnings));
    }
  } catch (error) {
    const refused =
      tokenFile !== undefined && /answered 40[134]\b/.test(String(error));
    err(
      `bun-client generate: ${(error as Error).message}${refused ? ` (the token in ${tokenFile} was sent: a stale token file?)` : ""}\n`,
    );
    return 2;
  }

  if (values.out === undefined) {
    out(code);
    return 0;
  }
  const files: { display: string; path: string; code: string }[] = [
    { display: values.out, path: resolve(cwd, values.out), code },
  ];
  if (zod !== null && values.zod !== undefined && zodCode !== undefined)
    files.push({ display: values.zod, path: zod.path, code: zodCode });

  if (values.check === true) {
    let stale = false;
    for (const file of files) {
      const existing = await readExisting(file.path);
      if (existing === file.code) {
        out(
          `bun-client generate: ${file.display} is up to date (typesHash ${hash})\n`,
        );
        continue;
      }
      stale = true;
      const was = existing === undefined ? undefined : headerHash(existing);
      err(
        existing === undefined
          ? `bun-client generate: ${file.display} does not exist; run the same command without --check\n`
          : `bun-client generate: ${file.display} is stale (it records typesHash ${was ?? "none"}, the documents hash ${hash}${was === hash ? ", with different content: regenerated by another version of the generator?" : ""}); run the same command without --check\n`,
      );
    }
    return stale ? 1 : 0;
  }

  for (const file of files) {
    if ((await readExisting(file.path)) === file.code) {
      out(
        `bun-client generate: ${file.display} unchanged (typesHash ${hash})\n`,
      );
      continue;
    }
    await writeAtomically(file.path, file.code);
    out(`bun-client generate: wrote ${file.display} (typesHash ${hash})\n`);
  }
  return 0;
}

/** `bun-client watch`. */
async function watch(args: readonly string[], io: Io): Promise<number> {
  const { err, cwd } = io;
  const values = parse(
    "watch",
    args,
    {
      out: { type: "string" },
      url: { type: "string" },
      "token-file": { type: "string" },
      zod: { type: "string" },
      "zod-flavour": { type: "string" },
    },
    io,
  );
  if (values === undefined) return asksHelp(args) ? 0 : 2;
  if (values.out === undefined) {
    err(
      `bun-client watch: --out is required, the file to keep generated\n\n${USAGE}`,
    );
    return 2;
  }
  if (values.url !== undefined && !URL.canParse(values.url)) {
    err(`bun-client watch: --url ${values.url} is not a URL\n`);
    return 2;
  }
  const zod: ZodTarget | null | string = zodTarget(
    values.zod,
    values["zod-flavour"],
    values.out,
    cwd,
  );
  if (typeof zod === "string") {
    err(`bun-client watch: ${zod}\n`);
    return 2;
  }

  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  // The caller's signal, or SIGINT/SIGTERM when the command owns the process.
  const signals: NodeJS.Signals[] =
    io.signal === undefined
      ? process.platform === "win32"
        ? ["SIGINT"]
        : ["SIGINT", "SIGTERM"]
      : [];
  if (io.signal?.aborted === true) controller.abort();
  io.signal?.addEventListener("abort", stop, { once: true });
  for (const name of signals) process.on(name, stop);
  try {
    return await watchDevServer({
      out: resolve(cwd, values.out),
      display: values.out,
      ...(zod === null || values.zod === undefined
        ? {}
        : { zod: { ...zod, display: values.zod } }),
      url: values.url,
      tokenPath:
        values["token-file"] === undefined
          ? undefined
          : resolve(cwd, values["token-file"]),
      cwd,
      signal: controller.signal,
      stdout: io.out,
      stderr: io.err,
    });
  } finally {
    io.signal?.removeEventListener("abort", stop);
    for (const name of signals) process.off(name, stop);
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
