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
 * bun-client generate … --include asyncapi   # only the documents listed: openapi, asyncapi
 * bun-client watch --out src/api.gen.ts [--zod src/api.zod.gen.ts] [--url <url>] [--token-file <path>]
 * bun-client watch --document customer --out src/customer.gen.ts \
 *                  --document backoffice --out src/backoffice.gen.ts [--zod …]
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
import type { AsyncApiFileSource, DocumentSource } from "./load";
import { readClientConfig, targetSource } from "./config";
import {
  devServerFor,
  DOCUMENT_NAME_PATTERN,
  readDevServers,
  tokenDirectory,
} from "./devServer";
import type { DocumentKind, ZodTarget } from "./emit";
import {
  emitModule,
  formatWarnings,
  headerHash,
  parseInclude,
  readExisting,
  writeAtomically,
  zodTarget,
} from "./emit";
import { loadAsyncApiFile, loadDocuments } from "./load";
import type { WatchTarget } from "./watch";
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
  bun-client generate --config <file> [--check] [--token-file <path>]
  bun-client watch --out <file> [--zod <file>] [--url <url>] [--token-file <path>]
  bun-client watch --document <name> --out <file> [--zod <file>]
                   [--document <name> --out <file> [--zod <file>]]… [--url <url>]
  bun-client watch --config <file> [--url <url>] [--token-file <path>]

Sources (one):
  --url <url>          a URL serving an OpenAPI document, or { hash, openapi, asyncapi }
  --openapi <file>     an OpenAPI 3.x document (JSON, or YAML by extension)
    --asyncapi <file>  an AsyncAPI document beside it (its WebSocket channels);
                       alone with --include asyncapi for a channels-only client
  --module <path>      a module exporting a router or a document, documented in process
    --export <name>    the export to read (default: "default")

Options:
  --out <file>         where to write the module (default: stdout)
  --check              write nothing; exit 1 when <file> is not what would be written
  --zod <file>         also write the runtime zod schemas there (needs --out)
  --zod-flavour <f>    "mini" (zod/mini, the default) or "classic" (zod)
  --include <list>     the documents the client covers, comma-separated:
                       openapi (the routes), asyncapi (the WebSocket channels).
                       Default: every document the source has
  --token-file <path>  a dev server's token file, or a directory of them
                       (default: the nearest node_modules/.cache/bun-types)
  --config <file>      a targets file (JSON): one source and every client to
                       write, { url | module [export] | openapi [asyncapi] |
                       asyncapi, tokenFile?, targets: [{ out, document?,
                       export?, zod?, zodFlavour?, include? }] }, paths
                       relative to it. generate writes
                       (or --checks) every target; watch keeps them all live
  --help               this text

watch keeps --out in step with a running dev server (bun-common's devTypes()),
found through its token file: the only one running, or the one at --url. It
regenerates when the server's documents change, and stops on Ctrl-C.

  --document <name>    follow one of the server's named documents (devTypes()'s
                       documents, served at <url>/<name>). Each --document
                       starts a target: the --out, --zod, --zod-flavour and
                       --include after it, up to the next --document, are its. Options
                       before the first --document are a target of the
                       unnamed document. One watcher, one connection, one file
                       per target, each regenerated when its document changes.
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
  const { err, cwd } = io;
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
      include: { type: "string" },
      config: { type: "string" },
    },
    io,
  );
  if (values === undefined) return asksHelp(args) ? 0 : 2;
  if (values.config !== undefined) {
    const others = (
      [
        "url",
        "openapi",
        "asyncapi",
        "module",
        "export",
        "out",
        "zod",
        "zod-flavour",
        "include",
      ] as const
    ).filter((name) => values[name] !== undefined);
    if (others.length > 0) {
      err(
        `bun-client generate: --config holds the source and the targets; it does not go with ${others.map((name) => `--${name}`).join(", ")}\n`,
      );
      return 2;
    }
    return await generateFromConfig(
      values.config,
      { check: values.check === true, tokenFile: values["token-file"] },
      io,
    );
  }
  const zod = zodTarget(values.zod, values["zod-flavour"], values.out, cwd);
  if (typeof zod === "string") {
    err(`bun-client generate: ${zod}\n`);
    return 2;
  }

  let include: readonly DocumentKind[] | undefined;
  if (values.include !== undefined) {
    const read = parseInclude(values.include, "--include");
    if (typeof read === "string") {
      err(`bun-client generate: ${read}\n`);
      return 2;
    }
    include = read;
  }
  // An --asyncapi file alone is a source of its own, under --include asyncapi.
  const asyncapiAlone =
    values.asyncapi !== undefined &&
    values.openapi === undefined &&
    values.url === undefined &&
    values.module === undefined;
  const given = (["url", "openapi", "module"] as const).filter(
    (name) => values[name] !== undefined,
  );
  if (given.length > 1 || (given.length === 0 && !asyncapiAlone)) {
    err(
      `bun-client generate: give exactly one of --url, --openapi or --module${given.length > 1 ? ` (got ${given.map((name) => `--${name}`).join(", ")})` : ""}\n\n${USAGE}`,
    );
    return 2;
  }
  if (
    values.asyncapi !== undefined &&
    given.length === 1 &&
    values.openapi === undefined
  ) {
    err("bun-client generate: --asyncapi goes with --openapi, or alone\n");
    return 2;
  }
  if (asyncapiAlone && include?.join() !== "asyncapi") {
    err(
      "bun-client generate: --asyncapi alone needs --include asyncapi: without --openapi there are no routes\n",
    );
    return 2;
  }
  if (include !== undefined && values.openapi !== undefined) {
    // A file source's documents are known: name what --include leaves unused.
    const unused = !include.includes("openapi")
      ? "--openapi"
      : !include.includes("asyncapi") && values.asyncapi !== undefined
        ? "--asyncapi"
        : undefined;
    if (unused !== undefined) {
      err(
        `bun-client generate: --include ${include.join(",")} leaves ${unused} unused; leave it out${unused === "--openapi" ? " (give --asyncapi alone)" : ""}\n`,
      );
      return 2;
    }
    if (include.includes("asyncapi") && values.asyncapi === undefined) {
      err(
        `bun-client generate: --include ${include.join(",")} needs --asyncapi beside --openapi\n`,
      );
      return 2;
    }
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

  const source: DocumentSource | AsyncApiFileSource =
    values.url !== undefined
      ? { url: values.url }
      : asyncapiAlone
        ? { asyncapiFile: values.asyncapi! }
        : values.openapi !== undefined
          ? {
              openapi: values.openapi,
              ...(values.asyncapi === undefined
                ? {}
                : { asyncapi: values.asyncapi }),
            }
          : {
              module: values.module as string,
              ...(values.export === undefined ? {} : { export: values.export }),
            };
  return await generateTarget(
    {
      source,
      tokenPath:
        values["token-file"] === undefined
          ? tokenDirectory(cwd)
          : resolve(cwd, values["token-file"]),
      out:
        values.out === undefined
          ? undefined
          : { display: values.out, path: resolve(cwd, values.out) },
      zod:
        zod === null || values.zod === undefined
          ? undefined
          : { ...zod, display: values.zod },
      include,
      check: values.check === true,
    },
    io,
  );
}

/** One file `generate` writes or checks, from one source. */
interface GenerateTarget {
  /** Where its documents come from. A `url` gets the bearer token of the token file naming it. */
  readonly source: DocumentSource | AsyncApiFileSource;
  /** A token file or a directory of them, absolute, read for a `url` source. */
  readonly tokenPath: string;
  /** The file, absolute, and as the user named it; `undefined` prints the module to stdout. */
  readonly out: { readonly display: string; readonly path: string } | undefined;
  /** The zod module beside it; `undefined` for none. */
  readonly zod: (ZodTarget & { readonly display: string }) | undefined;
  /** The documents it covers (`--include`); `undefined` for every document the source has. */
  readonly include: readonly DocumentKind[] | undefined;
  /** Write nothing; report whether the files are fresh. */
  readonly check: boolean;
}

/**
 * Loads one target's documents, emits its module (and zod module), and
 * writes or checks them.
 *
 * @returns `0` written or fresh, `1` stale under `check`, `2` the source
 *   could not be read.
 */
async function generateTarget(
  target: GenerateTarget,
  { out, err, cwd }: Io,
): Promise<number> {
  let source = target.source;
  /** The token file whose token was sent, for a refusal's message. */
  let tokenFile: string | undefined;
  if ("url" in source) {
    // A dev endpoint a token file names gets its token (plan §3.3); any
    // other URL is fetched as it is.
    const server = devServerFor(
      source.url,
      await readDevServers(target.tokenPath),
      "endpoint",
    );
    tokenFile = server?.file;
    if (server !== undefined) {
      source = {
        url: source.url,
        headers: { authorization: `Bearer ${server.token}` },
      };
    }
  }

  let code: string;
  let hash: string;
  let zodCode: string | undefined;
  try {
    const emitted = emitModule(
      "asyncapiFile" in source
        ? await loadAsyncApiFile(source, cwd)
        : await loadDocuments(source, cwd),
      target.zod,
      target.include,
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

  if (target.out === undefined) {
    out(code);
    return 0;
  }
  const files: { display: string; path: string; code: string }[] = [
    { display: target.out.display, path: target.out.path, code },
  ];
  if (target.zod !== undefined && zodCode !== undefined)
    files.push({
      display: target.zod.display,
      path: target.zod.path,
      code: zodCode,
    });

  if (target.check) {
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

/**
 * `bun-client generate --config <file>`: every target of a targets file,
 * from its source, written or (`--check`) checked. Keeps going past a target
 * that fails, so one run reports them all.
 *
 * @returns The worst status of any target: `2` beats `1` beats `0`.
 */
async function generateFromConfig(
  configArg: string,
  options: { check: boolean; tokenFile: string | undefined },
  io: Io,
): Promise<number> {
  const config = await readClientConfig(resolve(io.cwd, configArg));
  if (typeof config === "string") {
    io.err(`bun-client generate: --config ${configArg}: ${config}\n`);
    return 2;
  }
  if (config.source === undefined) {
    io.err(
      `bun-client generate: --config ${configArg} names no source: give it "url", "module", "openapi" or "asyncapi"\n`,
    );
    return 2;
  }
  const tokenPath =
    options.tokenFile !== undefined
      ? resolve(io.cwd, options.tokenFile)
      : (config.tokenFile ?? tokenDirectory(io.cwd));
  let status = 0;
  for (const target of config.targets) {
    const result = await generateTarget(
      {
        source: targetSource(config, target)!,
        tokenPath,
        out: { display: target.display, path: target.out },
        zod:
          target.zod === undefined
            ? undefined
            : {
                path: target.zod.path,
                routesPath: target.out,
                flavour: target.zodFlavour === "classic" ? "classic" : "mini",
                display: target.zod.display,
              },
        include: target.include,
        check: options.check,
      },
      io,
    );
    status = Math.max(status, result);
  }
  return status;
}

/** One target's flags, in the order given. */
interface TargetFlags {
  /** `--document`, or `undefined` for the unnamed document's target. */
  document: string | undefined;
  /** `--out`. */
  out?: string;
  /** `--zod`. */
  zod?: string;
  /** `--zod-flavour`. */
  zodFlavour?: string;
  /** `--include`, as given. */
  include?: string;
}

/**
 * Groups `watch`'s target flags in the order given: each `--document` starts
 * a target, and `--out`, `--zod`, `--zod-flavour` and `--include` belong to the target
 * they follow; those before the first `--document` are the unnamed
 * document's. Answers the targets, or a usage error. Pure.
 */
export function groupWatchTargets(
  flags: readonly { name: string; value: string }[],
): TargetFlags[] | string {
  const groups: TargetFlags[] = [{ document: undefined }];
  for (const { name, value } of flags) {
    if (name === "document") {
      if (!DOCUMENT_NAME_PATTERN.test(value) || value === "ws") {
        return `--document ${value} is not a document name (letters, digits, _ and -, starting with a letter or digit)`;
      }
      if (groups.some((group) => group.document === value)) {
        return `--document ${value} is given twice`;
      }
      groups.push({ document: value });
      continue;
    }
    const group = groups.at(-1)!;
    const key =
      name === "zod-flavour"
        ? "zodFlavour"
        : (name as "out" | "zod" | "include");
    if (group[key] !== undefined) {
      const which =
        group.document === undefined
          ? "before the first --document"
          : `for --document ${group.document}`;
      return `--${name} is given twice ${which}`;
    }
    group[key] = value;
  }
  // The unnamed group only when it holds something: with --document alone,
  // nothing before it.
  const [unnamed, ...named] = groups;
  const used =
    unnamed.out !== undefined ||
    unnamed.zod !== undefined ||
    unnamed.zodFlavour !== undefined ||
    unnamed.include !== undefined ||
    named.length === 0
      ? [unnamed, ...named]
      : named;
  for (const group of used) {
    if (group.out === undefined) {
      return group.document === undefined
        ? "--out is required, the file to keep generated"
        : `--document ${group.document} needs an --out after it, the file to keep generated`;
    }
  }
  const outs = used.map((group) => group.out);
  const twice = outs.find((out, index) => outs.indexOf(out) !== index);
  if (twice !== undefined) {
    return `--out ${twice} is named by two targets`;
  }
  return used;
}

/** Parses `watch`'s arguments, with their tokens: the order groups the targets. Throws on a usage error. */
function parseWatchArgs(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      document: { type: "string", multiple: true },
      out: { type: "string", multiple: true },
      zod: { type: "string", multiple: true },
      "zod-flavour": { type: "string", multiple: true },
      include: { type: "string", multiple: true },
      url: { type: "string" },
      "token-file": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean" },
    },
  });
}

/** `bun-client watch`. */
async function watch(args: readonly string[], io: Io): Promise<number> {
  const { err, cwd, out: stdout } = io;
  let parsed: ReturnType<typeof parseWatchArgs>;
  try {
    parsed = parseWatchArgs(args);
  } catch (error) {
    err(`bun-client watch: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const values = parsed.values;
  if (values.help === true) {
    stdout(USAGE);
    return 0;
  }
  const targetFlags = parsed.tokens.flatMap((token) =>
    token.kind === "option" &&
    ["document", "out", "zod", "zod-flavour", "include"].includes(token.name) &&
    typeof token.value === "string"
      ? [{ name: token.name, value: token.value }]
      : [],
  );
  if (values.url !== undefined && !URL.canParse(values.url)) {
    err(`bun-client watch: --url ${values.url} is not a URL\n`);
    return 2;
  }
  let url = values.url;
  let tokenPath =
    values["token-file"] === undefined
      ? undefined
      : resolve(cwd, values["token-file"]);
  const targets: WatchTarget[] = [];
  if (values.config !== undefined) {
    if (targetFlags.length > 0) {
      err(
        `bun-client watch: --config holds the targets; it does not go with ${[...new Set(targetFlags.map((flag) => `--${flag.name}`))].join(", ")}\n`,
      );
      return 2;
    }
    const config = await readClientConfig(resolve(cwd, values.config));
    if (typeof config === "string") {
      err(`bun-client watch: --config ${values.config}: ${config}\n`);
      return 2;
    }
    // The file's url and token file, unless the command line names others.
    if (url === undefined && config.source !== undefined) {
      if ("url" in config.source) url = config.source.url;
    }
    tokenPath ??= config.tokenFile;
    for (const target of config.targets) {
      targets.push({
        ...(target.document === undefined ? {} : { document: target.document }),
        out: target.out,
        display: target.display,
        ...(target.zod === undefined
          ? {}
          : {
              zod: {
                path: target.zod.path,
                routesPath: target.out,
                flavour: target.zodFlavour === "classic" ? "classic" : "mini",
                display: target.zod.display,
              },
            }),
        ...(target.include === undefined ? {} : { include: target.include }),
      });
    }
  } else {
    const grouped = groupWatchTargets(targetFlags);
    if (typeof grouped === "string") {
      err(
        `bun-client watch: ${grouped}${grouped.startsWith("--out is required") ? `\n\n${USAGE}` : "\n"}`,
      );
      return 2;
    }
    for (const group of grouped) {
      const zod: ZodTarget | null | string = zodTarget(
        group.zod,
        group.zodFlavour,
        group.out,
        cwd,
      );
      if (typeof zod === "string") {
        err(
          `bun-client watch: ${zod}${group.document === undefined ? "" : ` (--document ${group.document})`}\n`,
        );
        return 2;
      }
      let include: readonly DocumentKind[] | undefined;
      if (group.include !== undefined) {
        const read = parseInclude(group.include, "--include");
        if (typeof read === "string") {
          err(
            `bun-client watch: ${read}${group.document === undefined ? "" : ` (--document ${group.document})`}\n`,
          );
          return 2;
        }
        include = read;
      }
      targets.push({
        ...(group.document === undefined ? {} : { document: group.document }),
        ...(include === undefined ? {} : { include }),
        out: resolve(cwd, group.out!),
        display: group.out!,
        ...(zod === null || group.zod === undefined
          ? {}
          : { zod: { ...zod, display: group.zod } }),
      });
    }
  }
  const zodPaths = targets.flatMap((target) =>
    target.zod === undefined ? [] : [target.zod.path],
  );
  const clash = targets.find((target) => zodPaths.includes(target.out));
  if (clash !== undefined) {
    err(
      `bun-client watch: ${clash.display} is both one target's --out and another's --zod\n`,
    );
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
      targets,
      url,
      tokenPath,
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
