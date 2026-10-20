import type { Route } from "@routejs/router";

/**
 * A radix tree over a route table, answering "which routes match this path,
 * and with what captures" — the job `RegExp#exec` did per candidate route.
 *
 * Every route is compiled from **its own regex** (`route.pathRegexp`), never
 * from its path syntax, so the tree answers for exactly the regex it stands
 * for. A source made only of the shapes `@routejs/router` emits for literal
 * and whole-segment parameters —
 *
 * ```
 * ^ ( \/literal | \/([^\/]+?) )* ( \/REST | (?:\/([^]+))? )? \/?$   a route
 * ^ ( \/literal | \/([^\/]+?) )*                            \/?(?=\/|$)   a `use()` prefix
 * ^ \/ \/?$                                                                the route `/`
 *
 * REST: (.*)  ([^]+)  (?:([^]+))?
 * ```
 *
 * — is walked character by character: literals compared in place (ASCII
 * case folded for an `i` regex: without the `u` flag no non-ASCII character
 * folds to an ASCII letter, so the fold is exact), a parameter taken up to
 * the next `/`, a trailing rest taking what is left: routejs's bare `*`
 * (`(.*)`), and the wildcards of Express 5 paths, `*name` (`([^]+)`, one
 * character or more), `{*name}` after a `/` (`(?:([^]+))?`) and `{/*name}` (`(?:\/([^]+))?`, whose `/` is
 * optional too). `/` is Express's `^\/\/?$`, which also answers `//`. Any
 * other source (an
 * optional or regex-constrained parameter, a parameter inside a segment, an
 * escape, a non-ASCII literal) is a **regex leaf**: hung at the node of its
 * fixed literal prefix and run with `exec` only for a path that reaches it.
 *
 * No substring is created or hashed to follow a literal, which is what made
 * the per-segment `Map` lookups of the previous index cost more than the
 * regexes they saved.
 */

/** One part of a compiled source. */
type Part =
  | { kind: "literal"; text: string }
  | { kind: "param" }
  | { kind: "rest"; rest: RestKind };

/**
 * How a trailing rest takes the remainder `r` of the path (after the `/`
 * before it, except {@link REST_SLASH_OPTIONAL}, which starts at that `/`).
 */
const RestKinds = {
  /** `(.*)`: all of `r`, empty included, unless it holds a line terminator. */
  Dot: 0,
  /** `([^]+)`: all of `r`, which must not be empty. */
  Plus: 1,
  /** `(?:([^]+))?`: all of `r`, no capture when it is empty. */
  OptionalPlus: 2,
  /**
   * `(?:\/([^]+))?`: nothing (no capture) when `r` is `""` or `"/"`, else
   * `r` must start with `/` and the capture is what follows it.
   */
  SlashOptional: 4,
} as const;
type RestKind = (typeof RestKinds)[keyof typeof RestKinds];

/** The sources of the rests that follow a `\/`, longest first. */
const RESTS: readonly (readonly [string, RestKind])[] = [
  ["(?:([^]+))?", RestKinds.OptionalPlus],
  ["([^]+)", RestKinds.Plus],
  ["(.*)", RestKinds.Dot],
];
/** {@link RestKinds.SlashOptional}'s source, which carries its own `\/`. */
const REST_SLASH_OPTIONAL = "(?:\\/([^]+))?";

/** A source in the tree's grammar. */
interface CompiledSource {
  /** Its parts, in order. */
  parts: Part[];
  /** A `use()` prefix (`\/?(?=\/|$)`) rather than a whole path (`\/?$`). */
  prefix: boolean;
  /** Compiled with the `i` flag. */
  insensitive: boolean;
}

/** A literal run of a source: escaped punctuation or plain URL characters. */
const SOURCE_LITERAL = /^(?:\\[.+*?=^!:${}()[\]|\\-]|[\w\-~%@&,;'"])+/;
const ROUTE_END = "\\/?$";
const PREFIX_END = "\\/?(?=\\/|$)";
const PARAM = "([^\\/]+?)";

/** Compiles a route regex in the tree's grammar, or `undefined` for a leaf. */
function compileSource(regexp: RegExp): CompiledSource | undefined {
  const flags = regexp.flags;
  if (flags !== "" && flags !== "i") {
    return undefined;
  }
  let source = regexp.source;
  if (!source.startsWith("^")) {
    return undefined;
  }
  source = source.slice(1);
  let prefix: boolean;
  if (source.endsWith(PREFIX_END)) {
    prefix = true;
    source = source.slice(0, -PREFIX_END.length);
  } else if (source.endsWith(ROUTE_END)) {
    prefix = false;
    source = source.slice(0, -ROUTE_END.length);
  } else {
    return undefined;
  }
  const parts: Part[] = [];
  // Express's `/`: one literal "/" whose segment is empty.
  if (source === "\\/" && !prefix) {
    return {
      parts: [{ kind: "literal", text: "" }],
      prefix,
      insensitive: flags === "i",
    };
  }
  while (source.length > 0) {
    if (source === REST_SLASH_OPTIONAL && !prefix) {
      parts.push({ kind: "rest", rest: RestKinds.SlashOptional });
      break;
    }
    if (!source.startsWith("\\/")) {
      return undefined;
    }
    source = source.slice(2);
    const rest = RESTS.find(([text]) => source.startsWith(text));
    if (source.startsWith(PARAM)) {
      parts.push({ kind: "param" });
      source = source.slice(PARAM.length);
    } else if (rest !== undefined) {
      source = source.slice(rest[0].length);
      // Only at the very end of a whole-path route.
      if (prefix || source.length > 0) {
        return undefined;
      }
      parts.push({ kind: "rest", rest: rest[1] });
    } else {
      const literal = SOURCE_LITERAL.exec(source);
      if (literal === null) {
        return undefined;
      }
      parts.push({
        kind: "literal",
        text: literal[0].replace(/\\(.)/g, "$1"),
      });
      source = source.slice(literal[0].length);
    }
    // Every part fills a whole segment.
    if (
      source.length > 0 &&
      !source.startsWith("\\/") &&
      source !== REST_SLASH_OPTIONAL
    ) {
      return undefined;
    }
  }
  return { parts, prefix, insensitive: flags === "i" };
}

/**
 * The fixed text every match of `regexp` starts with — the literal run after
 * `^` up to the first special token, minus a last character a quantifier
 * makes optional — or `""` when there is none to rely on (a `|` anywhere, a
 * non-ASCII literal under `i`).
 */
function fixedPrefix(regexp: RegExp): string {
  const source = regexp.source;
  if (!source.startsWith("^") || source.includes("|")) {
    return "";
  }
  let text = "";
  let at = 1;
  while (at < source.length) {
    const char = source[at];
    if (char === "\\") {
      const next = source[at + 1];
      if (next === undefined || !/[/.+*?=^!:${}()[\]|\\-]/.test(next)) {
        break;
      }
      text += next;
      at += 2;
    } else if (/[\w\-~%@&,;'"]/.test(char)) {
      text += char;
      at += 1;
    } else {
      break;
    }
  }
  const next = source[at];
  if (
    text.length > 0 &&
    (next === "?" || next === "*" || next === "+" || next === "{")
  ) {
    text = text.slice(0, -1);
  }
  if (regexp.flags.includes("i") && /[^\0-\x7F]/.test(text)) {
    return "";
  }
  return text;
}

/** A tree node: an edge label, its children by first character, its routes. */
interface TreeNode {
  /** The literal text this node matches (case folded in a folding tree). */
  label: string;
  /** Children by the char code their label starts with. */
  children: (TreeNode | undefined)[] | undefined;
  /** The node a whole-segment parameter leads to. */
  param: TreeNode | undefined;
  /** Routes whose path ends here (an optional `/` may follow). */
  ends: number[];
  /** `use()` prefixes that end here (a `/` or the end must follow). */
  prefixes: number[];
  /** Routes whose trailing rest takes the rest of the path from here. */
  rests: number[];
  /** Each of {@link rests}' {@link RestKind}, by position. */
  restKinds: RestKind[];
  /** Routes outside the grammar, run with `exec` from here. */
  leaves: number[];
}

function createNode(label: string): TreeNode {
  return {
    label,
    children: undefined,
    param: undefined,
    ends: [],
    prefixes: [],
    rests: [],
    restKinds: [],
    leaves: [],
  };
}

/** The node `text` (already folded as the tree is) leads to from `node`, created as needed. */
function descend(node: TreeNode, text: string): TreeNode {
  let current = node;
  let rest = text;
  while (rest.length > 0) {
    const code = rest.charCodeAt(0);
    current.children ??= [];
    const child = current.children[code];
    if (child === undefined) {
      const created = createNode(rest);
      current.children[code] = created;
      return created;
    }
    const max = Math.min(child.label.length, rest.length);
    let common = 0;
    while (
      common < max &&
      child.label.charCodeAt(common) === rest.charCodeAt(common)
    ) {
      common++;
    }
    if (common < child.label.length) {
      // Split the edge: the child keeps the common part, a new node the rest.
      const tail = createNode(child.label.slice(common));
      tail.children = child.children;
      tail.param = child.param;
      tail.ends = child.ends;
      tail.prefixes = child.prefixes;
      tail.rests = child.rests;
      tail.restKinds = child.restKinds;
      tail.leaves = child.leaves;
      child.label = child.label.slice(0, common);
      child.children = [];
      child.children[tail.label.charCodeAt(0)] = tail;
      child.param = undefined;
      child.ends = [];
      child.prefixes = [];
      child.rests = [];
      child.restKinds = [];
      child.leaves = [];
    }
    current = child;
    rest = rest.slice(common);
  }
  return current;
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/** What {@link RouteTree.match} found: matching route indices, ascending, and each one's captures. */
export interface RouteTreeMatches {
  /** Indices into the route table, in registration order. */
  indices: number[];
  /** Each match's captures, as `exec` would return them (index 0 the matched text). */
  captures: (readonly (string | undefined)[])[];
}

/**
 * The route table's radix tree (see the module comment). Rebuilt lazily when
 * the table it was built from changes length or identity, or after
 * {@link invalidate}.
 */
export class RouteTree {
  /** The table the tree was built from; `undefined` until the first build. */
  #table: Route[] | undefined = undefined;
  /** The table's length at the build, so a pushed route triggers a rebuild. */
  #builtLength = -1;
  /** Routes compiled with the `i` flag, walked with ASCII case folded. */
  #folded = createNode("");
  /** Case-sensitive routes, walked as they are. */
  #exact = createNode("");
  /** Whether {@link #exact} holds any route (most tables have none). */
  #hasExact = false;

  /** Drops the tree; the next lookup rebuilds it. */
  invalidate(): void {
    this.#table = undefined;
    this.#builtLength = -1;
  }

  #build(routes: Route[]): void {
    this.#table = routes;
    this.#builtLength = routes.length;
    this.#folded = createNode("");
    this.#exact = createNode("");
    this.#hasExact = false;
    for (let index = 0; index < routes.length; index++) {
      const regexp = routes[index].pathRegexp as RegExp | null | undefined;
      if (regexp === null || regexp === undefined) {
        continue;
      }
      const compiled = compileSource(regexp);
      const insensitive = regexp.flags.includes("i");
      const root = insensitive ? this.#folded : this.#exact;
      if (!insensitive) {
        this.#hasExact = true;
      }
      if (compiled === undefined) {
        const fixed = fixedPrefix(regexp);
        descend(root, insensitive ? fixed.toLowerCase() : fixed).leaves.push(
          index,
        );
        continue;
      }
      let node = root;
      let pending = "";
      let added = false;
      for (const part of compiled.parts) {
        if (part.kind === "literal") {
          pending += `/${insensitive ? part.text.toLowerCase() : part.text}`;
          continue;
        }
        // `{/*name}` hangs before its optional `/`, every other part after it.
        node = descend(
          node,
          part.kind === "rest" && part.rest === RestKinds.SlashOptional
            ? pending
            : `${pending}/`,
        );
        pending = "";
        if (part.kind === "param") {
          node = node.param ??= createNode("");
        } else {
          node.rests.push(index);
          node.restKinds.push(part.rest);
          added = true;
        }
      }
      if (!added) {
        node = descend(node, pending);
        (compiled.prefix ? node.prefixes : node.ends).push(index);
      }
    }
  }

  /**
   * Every route of `routes` whose regex matches `path`, with the captures its
   * `exec` would give, in registration order.
   */
  match(routes: Route[], path: string): RouteTreeMatches {
    if (routes !== this.#table || routes.length !== this.#builtLength) {
      this.#build(routes);
    }
    const found: RouteTreeMatches = { indices: [], captures: [] };
    const params: string[] = [];
    walk(this.#folded, routes, path, 0, true, params, found);
    if (this.#hasExact) {
      walk(this.#exact, routes, path, 0, false, params, found);
    }
    // Registration order: an insertion sort, as a match set is small.
    const { indices, captures } = found;
    for (let i = 1; i < indices.length; i++) {
      const index = indices[i];
      const capture = captures[i];
      let j = i - 1;
      while (j >= 0 && indices[j] > index) {
        indices[j + 1] = indices[j];
        captures[j + 1] = captures[j];
        j--;
      }
      indices[j + 1] = index;
      captures[j + 1] = capture;
    }
    return found;
  }
}

/** {@link restCapture}'s answer when the rest does not match. */
const NO_REST = null;

/**
 * What a rest of `kind` captures of `path` from `at` (`undefined`: it
 * matches, with no capture), or {@link NO_REST}.
 */
function restCapture(
  kind: RestKind,
  path: string,
  at: number,
): string | undefined | typeof NO_REST {
  switch (kind) {
    case RestKinds.Dot: {
      const rest = path.slice(at);
      // `.` stops at a line terminator, and `$` then fails.
      return LINE_TERMINATOR.test(rest) ? NO_REST : rest;
    }
    case RestKinds.Plus:
      return at < path.length ? path.slice(at) : NO_REST;
    case RestKinds.OptionalPlus:
      return at < path.length ? path.slice(at) : undefined;
    case RestKinds.SlashOptional:
      if (at === path.length) {
        return undefined;
      }
      if (path.charCodeAt(at) !== 47) {
        return NO_REST;
      }
      // `{/*name}` needs a character after its `/`; a lone `/` is `\/?$`'s.
      return at + 1 === path.length ? undefined : path.slice(at + 1);
  }
}

/** `[first, ...params]`, without a spread. */
function captureList(first: string, params: string[]): string[] {
  const list = [first];
  for (let i = 0; i < params.length; i++) {
    list.push(params[i]);
  }
  return list;
}

function walk(
  node: TreeNode,
  routes: Route[],
  path: string,
  start: number,
  fold: boolean,
  params: string[],
  found: RouteTreeMatches,
): void {
  const label = node.label;
  const length = path.length;
  if (start + label.length > length) {
    return;
  }
  for (let i = 0; i < label.length; i++) {
    let code = path.charCodeAt(start + i);
    if (fold && code >= 65 && code <= 90) {
      code += 32;
    }
    if (code !== label.charCodeAt(i)) {
      return;
    }
  }
  const at = start + label.length;

  if (
    node.ends.length > 0 &&
    (at === length || (at === length - 1 && path.charCodeAt(at) === 47))
  ) {
    for (const index of node.ends) {
      found.indices.push(index);
      found.captures.push(captureList(path, params));
    }
  }
  if (
    node.prefixes.length > 0 &&
    (at === length || path.charCodeAt(at) === 47)
  ) {
    // `\/?` takes a "/" only when the end or another "/" follows it.
    const matched = path.slice(
      0,
      at < length && (at + 1 === length || path.charCodeAt(at + 1) === 47)
        ? at + 1
        : at,
    );
    for (const index of node.prefixes) {
      found.indices.push(index);
      found.captures.push(captureList(matched, params));
    }
  }
  if (node.rests.length > 0) {
    const rests = node.rests;
    const kinds = node.restKinds;
    for (let r = 0; r < rests.length; r++) {
      const rest = restCapture(kinds[r], path, at);
      if (rest !== NO_REST) {
        // Pushed even when `undefined`, as `exec` reports an unmatched group.
        const captures: (string | undefined)[] = captureList(path, params);
        captures.push(rest);
        found.indices.push(rests[r]);
        found.captures.push(captures);
      }
    }
  }
  if (node.leaves.length > 0) {
    for (const index of node.leaves) {
      const result = routes[index].pathRegexp.exec(path);
      if (result !== null) {
        found.indices.push(index);
        found.captures.push(result);
      }
    }
  }
  if (at < length) {
    if (node.children !== undefined) {
      let code = path.charCodeAt(at);
      if (fold && code >= 65 && code <= 90) {
        code += 32;
      }
      const child = node.children[code];
      if (child !== undefined) {
        walk(child, routes, path, at, fold, params, found);
      }
    }
    if (node.param !== undefined) {
      let end = path.indexOf("/", at);
      if (end === -1) {
        end = length;
      }
      if (end > at) {
        params.push(path.slice(at, end));
        walk(node.param, routes, path, end, fold, params, found);
        params.pop();
      }
    }
  }
}
