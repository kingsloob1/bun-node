import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * A cheap static tripwire over `app/**`: in each file, every opener of a
 * handle has its closer — `setInterval`/`clearInterval`, `setTimeout`/
 * `clearTimeout`, `requestAnimationFrame`/`cancelAnimationFrame`,
 * `addEventListener`/`removeEventListener`, `new WebSocket`/`new
 * EventSource`/`.close()`, `new *Observer`/`.disconnect()` — at least as many
 * closers as openers, comments stripped. And every `queryFn` destructures
 * TanStack's `signal`: a read is aborted on unmount only when its signal is
 * consumed.
 *
 * It is PARTIAL by design: it counts names in a file, so a closer in the
 * wrong place (outside the effect's cleanup, on another handle) satisfies it,
 * and a handle opened through an alias (`this.#timers.setTimeout`) escapes
 * it. The real guard is the runtime ledger, `unmountLeaks.test.tsx`, which
 * watches what actually stays open; this one only fails fast, at the line, on
 * the plain mistake.
 *
 * An opener that is meant to stay open carries `// leak-ok: <reason>` on its
 * own line or the line above; the reason is required.
 */

/** The app's sources. */
const APP = join(import.meta.dir, "..", "..", "app");

/** An opener and the closer it needs. */
interface Pair {
  /** What it is, for the message. */
  name: string;
  /** Matches one opening. */
  open: RegExp;
  /** Matches one closing. */
  close: RegExp;
}

/** Every pair checked. The live client builds its socket as `new Ctor(...)`. */
const PAIRS: readonly Pair[] = [
  {
    name: "setInterval",
    open: /(?<![.#\w])setInterval\s*\(/g,
    close: /(?<![.#\w])clearInterval\s*\(/g,
  },
  {
    name: "setTimeout",
    open: /(?<![.#\w])setTimeout\s*\(/g,
    close: /(?<![.#\w])clearTimeout\s*\(/g,
  },
  {
    name: "requestAnimationFrame",
    open: /\brequestAnimationFrame\s*\(/g,
    close: /\bcancelAnimationFrame\s*\(/g,
  },
  {
    name: "addEventListener",
    open: /\.addEventListener\s*\(/g,
    close: /\.removeEventListener\s*\(/g,
  },
  {
    name: "MediaQueryList.addListener",
    open: /\.addListener\s*\(/g,
    close: /\.removeListener\s*\(/g,
  },
  {
    name: "WebSocket",
    open: /\bnew\s+(?:(?:globalThis|window)\.)?(?:WebSocket|Ctor)\s*\(/g,
    close: /\.close\s*\(/g,
  },
  {
    name: "EventSource",
    open: /\bnew\s+(?:(?:globalThis|window)\.)?EventSource\s*\(/g,
    close: /\.close\s*\(/g,
  },
  {
    name: "Observer",
    open: /\bnew\s+(?:Intersection|Resize|Mutation|Performance)Observer\s*\(/g,
    close: /\.disconnect\s*\(/g,
  },
];

/** The escape: `leak-ok:` and a reason. */
const ESCAPE = /\/\/\s*leak-ok:\s*\S/;

/**
 * `source` with its comments and the contents of its strings blanked to
 * spaces (newlines kept, so an offset still maps to its line): a name in a
 * comment, a URL or a message is not code. A quoted string ends at its line's
 * end, so a quote in a regular expression cannot swallow what follows; a
 * template literal's `${…}` is blanked with it (an opener there escapes the
 * check, which is partial anyway).
 */
export function codeOnly(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    let stop: number;
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
    } else if (char === '"' || char === "'" || char === "`") {
      const multiline = char === "`";
      let end = index + 1;
      for (; end < source.length; end += source[end] === "\\" ? 2 : 1) {
        if (source[end] === char || (!multiline && source[end] === "\n")) {
          break;
        }
      }
      end = Math.min(end, source.length);
      const closed = source[end] === char;
      // An unclosed quote stops before the newline, which stays.
      stop = closed ? end + 1 : end;
      out += char + blank(source.slice(index + 1, end)) + (closed ? char : "");
    } else {
      stop = index + 1;
      out += char;
    }
    index = stop;
  }
  return out;
}

/** One problem found. */
export interface PairProblem {
  /** The file, relative to `app/`. */
  file: string;
  /** What is wrong, with the line. */
  message: string;
}

/** The 1-based line of `offset` in `text`. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** Checks one file's source; `file` names it in the problems. */
export function checkSource(file: string, source: string): PairProblem[] {
  const code = codeOnly(source);
  const lines = source.split("\n");
  /** Whether the opener at `offset` carries the escape on its line or the line above. */
  const escaped = (offset: number) => {
    const line = lineOf(code, offset);
    return [lines[line - 1], lines[line - 2]].some(
      (text) => text !== undefined && ESCAPE.test(text),
    );
  };
  const problems: PairProblem[] = [];
  for (const pair of PAIRS) {
    const opens = [...code.matchAll(pair.open)].filter(
      (match) => !escaped(match.index),
    );
    const closes = [...code.matchAll(pair.close)].length;
    if (opens.length > closes) {
      const at = opens.map((match) => lineOf(code, match.index)).join(", ");
      problems.push({
        file,
        message: `${pair.name} opened ${opens.length}× (line ${at}) but closed ${closes}×`,
      });
    }
  }
  for (const match of code.matchAll(/\bqueryFn\s*:\s*/g)) {
    const rest = code.slice(match.index + match[0].length);
    const params = /^(?:async\s*)?\(([^)]*)\)\s*=>/.exec(rest);
    const line = lineOf(code, match.index);
    if (escaped(match.index)) {
      continue;
    }
    if (!params) {
      problems.push({
        file,
        message: `queryFn at line ${line} is not an inline arrow: its signal cannot be checked`,
      });
    } else if (!/\bsignal\b/.test(params[1]!)) {
      problems.push({
        file,
        message: `queryFn at line ${line} does not take TanStack's signal, so unmounting cannot abort it`,
      });
    }
  }
  return problems;
}

describe("every opener in app/** has its closer (a partial tripwire; unmountLeaks.test.tsx is the guard)", () => {
  it("finds none unpaired, and every queryFn takes the signal", () => {
    const problems: PairProblem[] = [];
    let files = 0;
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: APP })) {
      files++;
      problems.push(
        ...checkSource(file, readFileSync(join(APP, file), "utf8")),
      );
    }
    expect(files).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  it("negative control: flags an unpaired opener, a queryFn without its signal, and an opener whose only closer is in a comment", () => {
    const fixture = [
      "useEffect(() => {",
      "  const id = setInterval(tick, 1000);",
      "  window.addEventListener('resize', onResize);",
      "  // return () => window.removeEventListener('resize', onResize);",
      "}, []);",
      "useQuery({ queryKey: ['x'], queryFn: () => api.get('/x') });",
      "useQuery({ queryKey: ['y'], queryFn: load });",
    ].join("\n");
    expect(
      checkSource("fixture.tsx", fixture).map((problem) => problem.message),
    ).toEqual([
      "setInterval opened 1× (line 2) but closed 0×",
      "addEventListener opened 1× (line 3) but closed 0×",
      "queryFn at line 6 does not take TanStack's signal, so unmounting cannot abort it",
      "queryFn at line 7 is not an inline arrow: its signal cannot be checked",
    ]);
  });

  it("passes paired openers, a `leak-ok` with its reason, and an opener inside a string or comment", () => {
    const fixture = [
      "useEffect(() => {",
      "  const id = setTimeout(go, 10);",
      "  return () => clearTimeout(id);",
      "}, []);",
      "// leak-ok: the app-wide clock lives as long as the page",
      "setInterval(tick, 1000);",
      "const url = 'http://example.test/setInterval(';",
      "/* new WebSocket(url) */",
      "useQuery({ queryKey: ['x'], queryFn: ({ signal }) => api.get('/x', signal) });",
    ].join("\n");
    expect(checkSource("fixture.tsx", fixture)).toEqual([]);
  });

  it("requires a reason after `leak-ok:`", () => {
    const fixture = "// leak-ok:\nsetInterval(tick, 1000);";
    expect(checkSource("fixture.tsx", fixture)).toHaveLength(1);
  });
});
