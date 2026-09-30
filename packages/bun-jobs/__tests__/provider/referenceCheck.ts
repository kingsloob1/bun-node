import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

/**
 * The drift check behind `docs/providers/reference.md` (plugins §15.3): the
 * reference is hand-written, and this holds it to the code.
 *
 * - **Names.** Every export of each documented entry has a `` ### `name` ``
 *   heading under that entry's `` ## `spelling` `` section, and every such
 *   heading names an export.
 * - **Members.** Every exported type declared in bun-jobs has a
 *   `` - `member` `` bullet (at the start of a line) for each of its members,
 *   under a heading of its name, and no bullet names a member it lacks. A
 *   name exported by more than one entry is documented once: the bullets
 *   under all its headings count together. Members are an interface's own
 *   properties and methods (not inherited ones), an object type's
 *   properties, a union's branches' properties, a class's own public
 *   members (a symbol-keyed one is the package's own hook, and skipped),
 *   and a union of string literals' values.
 * - Types re-exported from another package (bun-common's `Logger`,
 *   `StandardSchemaV1`, …) need a heading, not member bullets: that package
 *   documents them.
 *
 * Both directions fail, and the test runs the checker over broken copies of
 * the reference as its negative control.
 */

/** The package root. */
export const PACKAGE = resolve(import.meta.dir, "../..");

/** The entries the reference covers, and the source file each resolves to. */
export const REFERENCE_ENTRIES: Readonly<Record<string, string>> = {
  "@kingsleyweb/bun-jobs/provider": "lib/provider/index.ts",
  "@kingsleyweb/bun-jobs/provider/testing": "lib/provider/testing/index.ts",
  "@kingsleyweb/bun-jobs/summon": "lib/summon/index.ts",
};

/** One export of an entry, as the compiler sees it. */
export interface ExportInfo {
  /** The exported name. */
  name: string;
  /** Whether it exists at run time (a function, class or constant). */
  value: boolean;
  /**
   * Its members, when it is a type declared in bun-jobs; `undefined` for a
   * re-export from another package, whose members are not checked.
   */
  members: string[] | undefined;
  /** Where it is declared: file and position, so two entries' same export is recognised. */
  declaredAt: string;
}

/** Whether a declaration has a `private` or `protected` modifier. */
function isHidden(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : [];
  return (modifiers ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/** A member's name as written: `foo`, `"~standard"` as `~standard`, `[BRAND]` as `[BRAND]`. */
function memberName(name: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isComputedPropertyName(name)) {
    return name.getText(source);
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(source);
}

/** The named members of a list of type elements: properties and methods only. */
function elementNames(
  members: ts.NodeArray<ts.TypeElement>,
  source: ts.SourceFile,
): string[] {
  return members.flatMap((member) =>
    (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
    member.name !== undefined
      ? [memberName(member.name, source)]
      : [],
  );
}

/** The members of a type written as a type node: object types, unions of them, string literal unions. */
function typeNodeMembers(node: ts.TypeNode, source: ts.SourceFile): string[] {
  if (ts.isParenthesizedTypeNode(node)) {
    return typeNodeMembers(node.type, source);
  }
  if (ts.isTypeLiteralNode(node)) {
    return elementNames(node.members, source);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const literals = node.types.every(
      (part) => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal),
    );
    if (literals) {
      return node.types.map(
        (part) =>
          ((part as ts.LiteralTypeNode).literal as ts.StringLiteral).text,
      );
    }
    return [
      ...new Set(node.types.flatMap((part) => typeNodeMembers(part, source))),
    ];
  }
  return [];
}

/** The documented members of one declaration, by its kind. */
function declarationMembers(declaration: ts.Declaration): string[] {
  const source = declaration.getSourceFile();
  if (ts.isInterfaceDeclaration(declaration)) {
    return elementNames(declaration.members, source);
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    return typeNodeMembers(declaration.type, source);
  }
  if (ts.isClassDeclaration(declaration)) {
    return declaration.members.flatMap((member) =>
      (ts.isPropertyDeclaration(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      member.name !== undefined &&
      !ts.isPrivateIdentifier(member.name) &&
      // A symbol-keyed class member is a hook for the package itself
      // (`SummonController`'s `[ATTACH_QUEUE]`), not public API.
      !ts.isComputedPropertyName(member.name) &&
      !isHidden(member)
        ? [memberName(member.name, source)]
        : [],
    );
  }
  return [];
}

/** Whether a file belongs to bun-jobs' own source. */
function inPackage(file: string): boolean {
  return resolve(file).startsWith(join(PACKAGE, "lib") + sep);
}

/** The program over the documented entries, compiled once. */
let program: ts.Program | undefined;

/** The compiler options of the package's own project. */
function packageOptions(): ts.CompilerOptions {
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
  return { ...parsed.options, noEmit: true };
}

/** Every export of one entry, with its members. */
export function entryExports(spelling: string): ExportInfo[] {
  const file = REFERENCE_ENTRIES[spelling];
  if (file === undefined) {
    throw new Error(`${spelling} is not a documented entry`);
  }
  program ??= ts.createProgram({
    rootNames: Object.values(REFERENCE_ENTRIES).map((path) =>
      join(PACKAGE, path),
    ),
    options: packageOptions(),
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(PACKAGE, file));
  const moduleSymbol =
    source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) {
    throw new Error(`could not read the module ${file}`);
  }
  return checker.getExportsOfModule(moduleSymbol).map((exported) => {
    const target =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const declarations = target.declarations ?? [];
    const first = declarations[0];
    const own =
      first !== undefined && inPackage(first.getSourceFile().fileName);
    return {
      name: exported.name,
      value: (target.flags & ts.SymbolFlags.Value) !== 0,
      members: own
        ? [...new Set(declarations.flatMap(declarationMembers))]
        : undefined,
      declaredAt:
        first === undefined
          ? exported.name
          : `${first.getSourceFile().fileName}:${first.pos}`,
    };
  });
}

/** One `### \`name\`` heading of the reference, and the member bullets under it. */
export interface ReferenceHeading {
  /** The name in the heading. */
  name: string;
  /** The `` - `member` `` bullets under it, before the next heading. */
  bullets: string[];
}

/** The reference, parsed: each `## \`spelling\`` section's headings. */
export type ParsedReference = Map<string, ReferenceHeading[]>;

/** Parses the reference's sections, headings and member bullets. Fenced code is skipped. */
export function parseReference(markdown: string): ParsedReference {
  const sections: ParsedReference = new Map();
  let section: ReferenceHeading[] | undefined;
  let heading: ReferenceHeading | undefined;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const entry = /^## `([^`]+)`\s*$/.exec(line);
    if (entry !== null) {
      section = [];
      heading = undefined;
      sections.set(entry[1]!, section);
      continue;
    }
    if (line.startsWith("## ")) {
      section = undefined;
      heading = undefined;
      continue;
    }
    const name = /^### `([^`]+)`/.exec(line);
    if (name !== null && section !== undefined) {
      heading = { name: name[1]!, bullets: [] };
      section.push(heading);
      continue;
    }
    if (/^#{3,} /.test(line)) {
      heading = undefined;
      continue;
    }
    const bullet = /^- `([^`]+)`/.exec(line);
    if (bullet !== null && heading !== undefined) {
      heading.bullets.push(bullet[1]!);
    }
  }
  return sections;
}

/** What the reference gets wrong against the code, one line each; empty when it is right. */
export function checkReference(
  markdown: string,
  exportsOf: (spelling: string) => ExportInfo[] = entryExports,
): string[] {
  const problems: string[] = [];
  const parsed = parseReference(markdown);
  // Every documented declaration's bullets, across every heading of its name.
  const bullets = new Map<string, Set<string>>();
  const expected = new Map<string, { name: string; members: string[] }>();

  for (const spelling of Object.keys(REFERENCE_ENTRIES)) {
    const exports = exportsOf(spelling);
    const headings = parsed.get(spelling);
    if (headings === undefined) {
      problems.push(`no section \`## \`${spelling}\`\``);
      continue;
    }
    const exported = new Set(exports.map((one) => one.name));
    const documented = new Set(headings.map((one) => one.name));
    for (const name of exported) {
      if (!documented.has(name)) {
        problems.push(`${spelling}: export \`${name}\` has no heading`);
      }
    }
    for (const name of documented) {
      if (!exported.has(name)) {
        problems.push(`${spelling}: heading \`${name}\` is not an export`);
      }
    }
    for (const info of exports) {
      if (info.members === undefined) {
        continue;
      }
      expected.set(info.declaredAt, {
        name: info.name,
        members: info.members,
      });
      const found = bullets.get(info.declaredAt) ?? new Set<string>();
      for (const heading of headings.filter((one) => one.name === info.name)) {
        for (const bullet of heading.bullets) {
          found.add(bullet);
        }
      }
      bullets.set(info.declaredAt, found);
    }
    // A bullet under a heading whose export has no members to check.
    for (const heading of headings) {
      const info = exports.find((one) => one.name === heading.name);
      if (info !== undefined && info.members === undefined) {
        continue;
      }
      if (
        info !== undefined &&
        info.members !== undefined &&
        info.members.length === 0 &&
        heading.bullets.length > 0
      ) {
        problems.push(
          `${spelling}: \`${heading.name}\` has no members, but lists ${heading.bullets.map((one) => `\`${one}\``).join(", ")}`,
        );
      }
    }
  }

  for (const [declaredAt, { name, members }] of expected) {
    const found = bullets.get(declaredAt) ?? new Set<string>();
    for (const member of members) {
      if (!found.has(member)) {
        problems.push(`\`${name}\`: member \`${member}\` has no bullet`);
      }
    }
    for (const bullet of found) {
      if (!members.includes(bullet)) {
        problems.push(`\`${name}\`: bullet \`${bullet}\` is not a member`);
      }
    }
  }
  return problems;
}

/** The reference's path. */
export const REFERENCE_PATH = join(PACKAGE, "docs/providers/reference.md");

/** Where the docs live. */
export const DOCS_DIR = dirname(REFERENCE_PATH);
