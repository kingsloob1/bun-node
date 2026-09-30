import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { PACKAGE } from "./referenceCheck";

/**
 * The checks that keep `docs/providers/` true (plugins §15.6): its code
 * blocks and its links.
 *
 * **Code blocks.** Every ` ```ts ` block is one of two kinds:
 *
 * - an **excerpt**, marked by `<!-- excerpt: <path from the repo root> -->`
 *   among the comments just above its fence (with `<!-- eslint-skip -->`
 *   right above the fence, since an excerpt is rarely a whole module and
 *   lints as one): it must appear verbatim, as consecutive
 *   lines, in that file (a common indentation may be removed). The starter
 *   template's files are typechecked and tested by its own gate, so an
 *   excerpt of them is checked by being one;
 * - a **snippet**, anything else: compiled as a module of its own, with the
 *   package's compiler options, against the package's source. The template's
 *   package name, `bun-jobs-provider-example`, resolves to its `src/`, so a
 *   user-facing snippet can import the worked example.
 *
 * Blocks in any other language (`bash`, `text`, `json`) are not checked.
 *
 * **Links.** A relative link must name a file that exists and stays inside
 * the package (the docs ship in the tarball, where nothing outside it
 * exists), and its `#anchor`, if any, a heading in it. A link to this repo
 * on GitHub (`https://github.com/kingsloob1/bun-node/{blob,tree}/develop/…`)
 * must name a path that exists here, or on `origin/develop` when this tree
 * is behind it. Other absolute links are not fetched.
 */

/** The repo root. */
export const REPO = resolve(PACKAGE, "../..");

/** The docs directory. */
export const DOCS = join(PACKAGE, "docs/providers");

/** The template's source, for snippets that import the worked example. */
const TEMPLATE_ENTRY = join(REPO, "templates/compute-provider/src/index.ts");

/** One fenced code block of a Markdown file. */
export interface CodeBlock {
  /** The Markdown file, relative to the package. */
  file: string;
  /** The fence's first line number, 1-based. */
  line: number;
  /** The fence's language, e.g. `ts`. */
  lang: string;
  /** The block's text, without its fences. */
  code: string;
  /** For an excerpt, the file it quotes, relative to the repo root. */
  excerptOf?: string;
}

/** The fenced code blocks of a Markdown text. */
export function codeBlocks(file: string, markdown: string): CodeBlock[] {
  const lines = markdown.split("\n");
  const blocks: CodeBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = /^(\s*)(`{3,})(\S*)/.exec(lines[index]!);
    if (open === null) {
      continue;
    }
    const fence = open[2]!;
    const body: string[] = [];
    let end = index + 1;
    for (; end < lines.length; end++) {
      if (lines[end]!.trimStart().startsWith(fence)) {
        break;
      }
      body.push(lines[end]!);
    }
    // The marker is among the HTML comments just above the fence (an
    // `<!-- eslint-skip -->` must be the one right above it).
    let marker: RegExpExecArray | null = null;
    for (let above = index - 1; above >= 0 && marker === null; above--) {
      const text = lines[above]!.trim();
      if (text !== "" && !/^<!--.*-->$/.test(text)) {
        break;
      }
      marker = /^<!--\s*excerpt:\s*(\S+)\s*-->$/.exec(text);
    }
    blocks.push({
      file,
      line: index + 1,
      lang: open[3]!,
      code: body.join("\n"),
      ...(marker === null ? {} : { excerptOf: marker[1]! }),
    });
    index = end;
  }
  return blocks;
}

/** The Markdown files of the docs, relative to the package, sorted. */
export function docFiles(): string[] {
  return readdirSync(DOCS)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => relative(PACKAGE, join(DOCS, name)));
}

/**
 * Whether `excerpt` appears in `source` as consecutive lines, allowing one
 * common indentation to have been removed from the excerpt.
 */
export function isExcerptOf(excerpt: string, source: string): boolean {
  const wanted = excerpt.replace(/\n+$/, "").split("\n");
  const lines = source.split("\n");
  if (wanted.length === 0 || wanted[0] === "") {
    return false;
  }
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    const first = lines[start]!;
    // The indentation removed from the excerpt: whitespace only.
    const prefix = first.slice(0, first.length - wanted[0]!.length);
    if (!first.endsWith(wanted[0]!) || prefix.trim() !== "") {
      continue;
    }
    const matches = wanted.every((line, offset) => {
      const actual = lines[start + offset]!;
      return line === "" ? actual.trim() === "" : actual === prefix + line;
    });
    if (matches) {
      return true;
    }
  }
  return false;
}

/** What is wrong with the excerpts among `blocks`, one line each. */
export function checkExcerpts(
  blocks: readonly CodeBlock[],
  read: (path: string) => string | undefined = (path) => {
    const absolute = join(REPO, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  },
): string[] {
  const problems: string[] = [];
  for (const block of blocks) {
    if (block.excerptOf === undefined) {
      continue;
    }
    const source = read(block.excerptOf);
    if (source === undefined) {
      problems.push(
        `${block.file}:${block.line}: excerpt of ${block.excerptOf}, which does not exist`,
      );
    } else if (!isExcerptOf(block.code, source)) {
      problems.push(
        `${block.file}:${block.line}: not a verbatim excerpt of ${block.excerptOf}`,
      );
    }
  }
  return problems;
}

/** The package's compiler options, with the template and the entries mapped to one copy of the source. */
function snippetOptions(): ts.CompilerOptions {
  const configPath = join(PACKAGE, "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (parsed === undefined) {
    throw new Error(`could not read ${configPath}`);
  }
  return {
    ...parsed.options,
    noEmit: true,
    baseUrl: PACKAGE,
    // One copy of bun-jobs for the snippets and the template alike: the
    // template's own install is a second copy, whose brand symbols would
    // not be the package's.
    paths: {
      ...parsed.options.paths,
      "@kingsleyweb/bun-jobs": ["./lib/index.ts"],
      "@kingsleyweb/bun-jobs/provider": ["./lib/provider/index.ts"],
      "@kingsleyweb/bun-jobs/provider/testing": [
        "./lib/provider/testing/index.ts",
      ],
      "@kingsleyweb/bun-jobs/summon": ["./lib/summon/index.ts"],
      "bun-jobs-provider-example": [relative(PACKAGE, TEMPLATE_ENTRY)],
    },
  };
}

/** Where a snippet is compiled from: a module beside the docs that never exists on disk. */
function snippetPath(block: CodeBlock): string {
  const name = block.file.replace(/[/\\]/g, "_").replace(/\.md$/, "");
  return join(DOCS, "__snippets__", `${name}.line${block.line}.ts`);
}

/** Compiles every snippet among `blocks`; answers the diagnostics, one line each. */
export function compileSnippets(blocks: readonly CodeBlock[]): string[] {
  const snippets = blocks.filter(
    (block) => block.lang === "ts" && block.excerptOf === undefined,
  );
  if (snippets.length === 0) {
    return [];
  }
  const virtual = new Map(
    snippets.map((block) => [snippetPath(block), block] as const),
  );
  const options = snippetOptions();
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (path) => virtual.get(resolve(path))?.code ?? readFile(path);
  host.fileExists = (path) => virtual.has(resolve(path)) || fileExists(path);
  host.getSourceFile = (path, language, onError, create) => {
    const block = virtual.get(resolve(path));
    return block === undefined
      ? getSourceFile(path, language, onError, create)
      : ts.createSourceFile(path, block.code, language, true);
  };
  const program = ts.createProgram({
    rootNames: [...virtual.keys()],
    options,
    host,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file !== undefined &&
        virtual.has(resolve(diagnostic.file.fileName)),
    )
    .map((diagnostic) => {
      const block = virtual.get(resolve(diagnostic.file!.fileName))!;
      const line =
        diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
          .line + 1;
      return `${block.file}:${block.line + line}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
}

/** GitHub's anchor for a heading's text. */
export function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The anchors a Markdown text's headings make, duplicates numbered as GitHub numbers them. */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const heading = fenced ? null : /^#{1,6}\s(.*)$/.exec(line);
    if (heading === null) {
      continue;
    }
    // A closing run of `#`s is not part of the text.
    const base = slug(heading[1]!.replace(/\s#+\s*$/, ""));
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

/** One link in a Markdown text. */
export interface MarkdownLink {
  /** The line it is on, 1-based. */
  line: number;
  /** Its target as written. */
  target: string;
}

/** The inline links of a Markdown text, outside code. */
export function linksOf(markdown: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let fenced = false;
  markdown.split("\n").forEach((text, index) => {
    if (/^\s*```/.test(text)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      return;
    }
    const prose = text.replace(/`[^`]*`/g, "");
    for (const match of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      links.push({ line: index + 1, target: match[1]! });
    }
  });
  return links;
}

/** This repo on GitHub, on the develop branch. */
const GITHUB =
  /^https:\/\/github\.com\/kingsloob1\/bun-node\/(?:blob|tree)\/develop\/([^#?]+)(?:#(.*))?$/;

/** Whether a path exists on `origin/develop`; `false` when git or the ref is not there. */
export function onOriginDevelop(path: string): boolean {
  const result = Bun.spawnSync({
    cmd: ["git", "cat-file", "-e", `origin/develop:${path}`],
    cwd: REPO,
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

/** What a link check found. */
export interface LinkReport {
  /** Links that do not resolve, one line each. */
  broken: string[];
  /** GitHub links accepted only because `origin/develop` has them. */
  developOnly: string[];
  /** How many links were checked. */
  checked: number;
}

/**
 * Checks the links of one Markdown file. `file` is its path relative to the
 * package; `markdown` its text (the file itself unless given).
 */
export function checkLinks(
  file: string,
  markdown: string = readFileSync(join(PACKAGE, file), "utf8"),
  onDevelop: (path: string) => boolean = onOriginDevelop,
): LinkReport {
  const report: LinkReport = { broken: [], developOnly: [], checked: 0 };
  const from = join(PACKAGE, file);
  for (const link of linksOf(markdown)) {
    const where = `${file}:${link.line}: ${link.target}`;
    const github = GITHUB.exec(link.target);
    if (github !== null) {
      report.checked++;
      const path = decodeURIComponent(github[1]!.replace(/\/$/, ""));
      if (existsSync(join(REPO, path))) {
        continue;
      }
      if (onDevelop(path)) {
        report.developOnly.push(where);
      } else {
        report.broken.push(`${where} (no such path in the repo)`);
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(link.target)) {
      continue;
    }
    report.checked++;
    const [pathPart, anchor] = link.target.split("#", 2) as [
      string,
      string | undefined,
    ];
    const target =
      pathPart === "" ? from : resolve(dirname(from), decodeURI(pathPart));
    if (!target.startsWith(PACKAGE + sep) && target !== PACKAGE) {
      report.broken.push(`${where} (leaves the package: it will not ship)`);
      continue;
    }
    if (pathPart !== "" && !existsSync(target)) {
      report.broken.push(`${where} (no such file)`);
      continue;
    }
    if (anchor !== undefined && anchor !== "") {
      if (!target.endsWith(".md")) {
        report.broken.push(`${where} (an anchor into a non-Markdown file)`);
        continue;
      }
      const text = target === from ? markdown : readFileSync(target, "utf8");
      if (!anchorsOf(text).has(anchor)) {
        report.broken.push(`${where} (no heading for #${anchor})`);
      }
    }
  }
  return report;
}
