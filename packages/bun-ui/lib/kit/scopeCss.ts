/**
 * Scopes a UI's built stylesheet to its mount element (embedding.md §4): the
 * stylesheet a host page links beside a mounted UI, made from the very
 * stylesheet the UI's own page links, so the two never drift.
 *
 * - **Every selector** sits under the UI's root, `[data-bun-ui="<ui>"]`. A
 *   selector naming the page's root (`:root`, `html`, `body`) names the
 *   mount element itself instead (`:root[data-theme=dark]` becomes
 *   `[data-bun-ui="jobs"][data-theme=dark]`, which is where the kit's
 *   `applyTheme` puts the attribute when mounted); one starting with `*`
 *   covers the element and everything in it; any other becomes a
 *   descendant of it.
 * - **A guard comes first**: the root itself starts from initial values
 *   (`all: initial`, as a block), so nothing it would inherit from the host
 *   page reaches the UI, and every element in it, with its `::before` and
 *   `::after`, goes back to the browser's own styles (`all: revert`), so a
 *   host's universal and element rules (`* { font }`, `button { … }`) do
 *   not reach in. The UI's own rules, all later and at least as specific,
 *   then apply as on its page (the page's `html` and `body` rules on the
 *   root). SVG is left out: `revert` would drop the presentation attributes
 *   (`width`, `fill`) its charts draw with. The root is an element the
 *   mount function creates inside the host's, so `all: initial` never
 *   touches an element the host styles.
 * - **No cascade layer** (the user's decision, 2026-11-18, embedding.md §12
 *   decision 3): the CSS spec ranks a host's unlayered rules above every
 *   layer, whatever their specificity, so a layered UI loses to any global
 *   rule (measured in Chrome). A host overrides on purpose with a selector
 *   at least as specific as the UI's (`[data-bun-ui="jobs"] .btn`), linked
 *   after the mount stylesheet, or through the theme's custom properties on
 *   the root. A host rule more specific than the guard around the root
 *   (`.card p`) still reaches the UI's elements.
 * - **Keyframes** are renamed `bun-ui-<ui>-<name>`, with the `animation` and
 *   `animation-name` declarations that use them: a keyframes name is global
 *   to the page, the last stylesheet defining it winning, so a host's `spin`
 *   (Tailwind defines one) linked after the UI's would replace it.
 * - **`rem` follows the reader, not the host** (the user's decision,
 *   2026-11-18): every `Nrem` in a declaration becomes
 *   `calc(N*var(--bun-ui-rem,16px))`, so a host's `<html>` font size (the
 *   common `62.5%`) does not scale the UI. The mount function sets
 *   `--bun-ui-rem` on the root to the reader's default size, measured at
 *   `font-size: medium`; 16px until it does. Media queries keep `rem`, which
 *   there means the browser's default size anyway.
 * - `@font-face` and the other at-rules without selectors are kept as they
 *   are; `@media`, `@supports`, `@container` and `@layer` blocks are scoped
 *   inside. `@charset` and `@import` stay first, where CSS requires them.
 *
 * Internal to the kit: `buildAssets` runs it over a UI's built entry
 * stylesheet. It reads CSS as the bundler writes it (no nesting: Bun lowers
 * it), skipping comments and strings, and throws on a stylesheet it cannot
 * read (an unbalanced brace) rather than scoping it wrongly.
 */

/** The attribute every mount element carries, naming its UI (embedding.md §11). */
export const MOUNT_ROOT_ATTRIBUTE = "data-bun-ui";

/** The selector of a UI's mount element: `[data-bun-ui="jobs"]`. */
export function mountRootSelector(ui: string): string {
  return `[${MOUNT_ROOT_ATTRIBUTE}="${ui}"]`;
}

/**
 * The guard rules that open a UI's mount stylesheet: the root from initial
 * values, as a block; every element under it but SVG, and its
 * `::before`/`::after`, back to the browser's styles. `:where()` keeps the
 * second at one attribute's specificity, as the first, and no higher than
 * any rule of the UI's own, which follow.
 */
export function mountGuardRule(ui: string): string {
  const root = mountRootSelector(ui);
  const element = `*:where(:not(svg,svg *))`;
  return `${root}{all:initial;display:block}${root} ${element},${root} ${element}::before,${root} ${element}::after{all:revert}`;
}

/** A UI's keyframes name once scoped: `bun-ui-jobs-spin`. */
export function mountKeyframesName(ui: string, name: string): string {
  return `bun-ui-${ui}-${name}`;
}

/** The custom property a mounted UI's `rem` reads (embedding.md §12, decision 12). */
export const MOUNT_REM_PROPERTY = "--bun-ui-rem";

/** A `rem` length in a declaration: its number. */
const REM = /(?<![\w.-])(-?(?:\d+(?:\.\d+)?|\.\d+))rem(?![\w-])/g;

/** A declaration block's `rem` lengths, outside strings, as `calc(N*var(--bun-ui-rem,16px))`. */
export function rewriteRem(body: string): string {
  const rewrite = (text: string) =>
    text.replace(
      REM,
      (_match, n: string) => `calc(${n}*var(${MOUNT_REM_PROPERTY},16px))`,
    );
  let out = "";
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '"' && body[i] !== "'") continue;
    out += rewrite(body.slice(start, i));
    const after = skipString(body, i);
    out += body.slice(i, after);
    start = after;
    i = after - 1;
  }
  return out + rewrite(body.slice(start));
}

/** A UI name the scoping accepts: what goes into an attribute value and a layer name unquoted. */
const UI_NAME = /^[a-z][a-z0-9-]*$/;

/** At-rules whose block holds rules, scoped inside. */
const GROUPING = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "document",
]);

/** At-rules that must precede every other rule, so stay ahead of the guard. */
const LEADING = new Set(["charset", "import"]);

/** One top-level or nested item of a stylesheet. */
type Node =
  /** A style rule: its selector list and its declarations, as written. */
  | { kind: "rule"; selector: string; body: string }
  /** An at-rule with a block (`@media …{…}`), its content parsed when it groups rules, else kept as written. */
  | {
      kind: "block";
      name: string;
      prelude: string;
      children: Node[] | null;
      raw: string;
    }
  /** An at-rule without a block (`@import …;`). */
  | { kind: "statement"; name: string; text: string };

/** Where a quoted string starting at `start` ends (the index after its closing quote). */
function skipString(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length && css[i] !== quote) {
    i += css[i] === "\\" ? 2 : 1;
  }
  if (i >= css.length) throw new Error("scopeStylesheet: unterminated string");
  return i + 1;
}

/** Where a comment starting at `start` (`/*`) ends. */
function skipComment(css: string, start: number): number {
  const end = css.indexOf("*/", start + 2);
  if (end === -1) throw new Error("scopeStylesheet: unterminated comment");
  return end + 2;
}

/** The index of the `}` closing the block whose `{` is at `open`. */
function closingBrace(css: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i);
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new Error("scopeStylesheet: unbalanced braces");
}

/** The first index at or after `from` of one of `chars`, outside strings and comments; -1 for none. */
function findOutside(css: string, from: number, chars: string): number {
  let i = from;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i);
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (chars.includes(c)) return i;
    i += 1;
  }
  return -1;
}

/** Parses a run of rules and at-rules (a stylesheet, or a grouping block's content). */
function parse(css: string): Node[] {
  const nodes: Node[] = [];
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      i = skipComment(css, i);
      continue;
    }
    if (c === "}") throw new Error("scopeStylesheet: unbalanced braces");
    const stop = findOutside(css, i, c === "@" ? "{;" : "{");
    if (stop === -1) {
      if (css.slice(i).trim() === "") break;
      throw new Error("scopeStylesheet: a rule without a block");
    }
    if (c === "@") {
      const head = css.slice(i + 1, stop);
      const name = /^[\w-]+/.exec(head)?.[0].toLowerCase() ?? "";
      if (css[stop] === ";") {
        nodes.push({ kind: "statement", name, text: css.slice(i, stop + 1) });
        i = stop + 1;
        continue;
      }
      const close = closingBrace(css, stop);
      const prelude = head.slice(name.length).trim();
      const inner = css.slice(stop + 1, close);
      nodes.push({
        kind: "block",
        name,
        prelude,
        children: GROUPING.has(name) ? parse(inner) : null,
        raw: inner,
      });
      i = close + 1;
      continue;
    }
    const close = closingBrace(css, stop);
    nodes.push({
      kind: "rule",
      selector: css.slice(i, stop).trim(),
      body: css.slice(stop + 1, close),
    });
    i = close + 1;
  }
  return nodes;
}

/** Splits a selector list on its top-level commas (not those in `:is(…)`, `[…]` or strings). */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < list.length) {
    const c = list[i];
    if (c === '"' || c === "'") {
      i = skipString(list, i);
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "(" || c === "[") depth += 1;
    if (c === ")" || c === "]") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  parts.push(list.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/** A selector naming the page's root first (`:root`, `html`, `body`), and what follows that name. */
const PAGE_ROOT = /^(?::root|html|body)(?![\w-])/i;

/** One selector, under `root`: see the module's description. */
function scopeSelector(selector: string, root: string): string[] {
  const page = PAGE_ROOT.exec(selector);
  if (page) return [`${root}${selector.slice(page[0].length)}`];
  if (selector.startsWith("*")) {
    return [`${root}${selector.slice(1)}`, `${root} ${selector}`];
  }
  return [`${root} ${selector}`];
}

/** A selector list, under `root`, duplicates dropped (`html,body` both name the root). */
function scopeSelectorList(list: string, root: string): string {
  const scoped = splitSelectorList(list).flatMap((selector) =>
    scopeSelector(selector, root),
  );
  return [...new Set(scoped)].join(",");
}

/** The keyframes names `nodes` define, at any depth. */
function keyframesNames(
  nodes: readonly Node[],
  into = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "block") continue;
    if (/^(?:-[a-z]+-)?keyframes$/.test(node.name)) into.add(node.prelude);
    if (node.children) keyframesNames(node.children, into);
  }
  return into;
}

/** Escapes a string for use in a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A declaration block with the `animation`/`animation-name` uses of `names` renamed. */
function renameAnimations(
  body: string,
  names: ReadonlyMap<string, string>,
): string {
  if (names.size === 0) return body;
  const name = new RegExp(
    `(?<![\\w-])(${[...names.keys()].map(escapeRegExp).join("|")})(?![\\w-])`,
    "g",
  );
  return body.replace(
    /((?:^|[;{\s])(?:-[a-z]+-)?animation(?:-name)?\s*:)([^;}]*)/gi,
    (_match, property: string, value: string) =>
      property + value.replace(name, (found: string) => names.get(found)!),
  );
}

/** Writes `nodes` back, scoped. */
function write(
  nodes: readonly Node[],
  root: string,
  names: ReadonlyMap<string, string>,
): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "statement") {
      out += node.text;
    } else if (node.kind === "rule") {
      out += `${scopeSelectorList(node.selector, root)}{${rewriteRem(renameAnimations(node.body, names))}}`;
    } else if (/^(?:-[a-z]+-)?keyframes$/.test(node.name)) {
      out += `@${node.name} ${names.get(node.prelude) ?? node.prelude}{${rewriteRem(node.raw)}}`;
    } else if (node.children) {
      const prelude = node.prelude === "" ? "" : ` ${node.prelude}`;
      out += `@${node.name}${prelude}{${write(node.children, root, names)}}`;
    } else {
      const prelude = node.prelude === "" ? "" : ` ${node.prelude}`;
      out += `@${node.name}${prelude}{${node.raw}}`;
    }
  }
  return out;
}

/**
 * Scopes a UI's stylesheet to its mount element, after its guard: see the
 * module's description. `ui` is the UI's name (`"jobs"`), lower case.
 *
 * @throws On a name that is not a lower-case word, or a stylesheet it cannot read.
 */
export function scopeStylesheet(css: string, ui: string): string {
  if (!UI_NAME.test(ui)) {
    throw new Error(`scopeStylesheet: ${JSON.stringify(ui)} is not a UI name`);
  }
  const nodes = parse(css);
  const names = new Map(
    [...keyframesNames(nodes)].map((name) => [
      name,
      mountKeyframesName(ui, name),
    ]),
  );
  const leading = nodes.filter(
    (node) => node.kind === "statement" && LEADING.has(node.name),
  );
  const rest = nodes.filter((node) => !leading.includes(node));
  return `${write(leading, "", names)}${mountGuardRule(ui)}${write(rest, mountRootSelector(ui), names)}`;
}
