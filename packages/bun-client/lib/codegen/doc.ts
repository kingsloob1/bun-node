/**
 * A small document printer for the generator's output (typed-client plan
 * §3.2, R10): the algorithm Prettier prints with (Wadler's, as Prettier's
 * `printDocToString` runs it), over the handful of commands the emitter
 * needs. The emitter builds its TypeScript as these documents, laid out the
 * way Prettier lays out the same constructs, so a generated file is already
 * formatted: `bun fmt` and Prettier leave it unchanged
 * (`__tests__/codegen/format.test.ts` proves it on every golden file).
 *
 * Nothing here knows TypeScript: `./print` and `./zod` do. Beside Prettier's
 * `group`, `indent`, `line` and `ifBreak` there are its `conditionalGroup`
 * and `breakParent`, which call arguments and member chains are printed
 * with, and {@link fluid}, its "fluid" assignment layout (`group(indent(line),
 * { id })` with `indentIfBreak(rhs, { groupId })`) as one command.
 */

/** A printable document. */
export type Doc = string | readonly Doc[] | DocCommand;

/** The commands beside plain text and concatenation. */
type DocCommand =
  | {
      /** Contents printed flat when they fit, broken otherwise. */
      readonly kind: "group";
      /** The contents. */
      readonly contents: Doc;
      /** Set when the contents hold a hard line: the group always breaks. */
      shouldBreak: boolean;
    }
  | {
      /** Contents one level (two spaces) deeper, or `width` columns deeper. */
      readonly kind: "indent";
      /** The contents. */
      readonly contents: Doc;
      /** Columns added; `undefined` for one level. */
      readonly width?: number;
    }
  | {
      /** A line break, or what it prints as when its group is flat. */
      readonly kind: "line";
      /** `true`: prints nothing when flat (a softline). */
      readonly soft: boolean;
      /** `true`: always breaks (a hardline). */
      readonly hard: boolean;
    }
  | {
      /** One document when the enclosing group breaks, another when flat. */
      readonly kind: "ifBreak";
      /** Printed when broken. */
      readonly broken: Doc;
      /** Printed when flat. */
      readonly flat: Doc;
    }
  | {
      /**
       * Prettier's `conditionalGroup`: the first state that fits, printed
       * flat (its forced breaks still break), else the last, broken.
       */
      readonly kind: "conditional";
      /** The states, from flattest to most expanded. */
      readonly states: readonly Doc[];
    }
  | {
      /** Breaks the enclosing group, printing nothing (Prettier's `breakParent`). */
      readonly kind: "breakParent";
    }
  | {
      /**
       * The right side of an assignment in Prettier's "fluid" layout: a
       * space and `contents` when the text up to its first possible line
       * break fits; else a line break and `contents` one level deeper.
       */
      readonly kind: "fluid";
      /** The right side. */
      readonly contents: Doc;
    };

/** The line width the output is laid out for: Prettier's default. */
export const PRINT_WIDTH = 80;

/** A group: flat if it fits on the line, broken otherwise. */
export function group(contents: Doc, shouldBreak = false): Doc {
  return { kind: "group", contents, shouldBreak };
}

/** The contents one level deeper when they break. */
export function indent(contents: Doc): Doc {
  return { kind: "indent", contents };
}

/** The contents `width` columns deeper when they break (Prettier's `align`). */
export function align(width: number, contents: Doc): Doc {
  return { kind: "indent", contents, width };
}

/** A space when flat, a line break when broken. */
export const line: Doc = { kind: "line", soft: false, hard: false };

/** Nothing when flat, a line break when broken. */
export const softline: Doc = { kind: "line", soft: true, hard: false };

/** Always a line break; breaks every enclosing group. */
export const hardline: Doc = { kind: "line", soft: false, hard: true };

/** `broken` when the enclosing group breaks, else `flat`. */
export function ifBreak(broken: Doc, flat: Doc = ""): Doc {
  return { kind: "ifBreak", broken, flat };
}

/** Prettier's `conditionalGroup`: see the command. */
export function conditionalGroup(states: readonly Doc[]): Doc {
  return { kind: "conditional", states };
}

/** Breaks the enclosing group. */
export const breakParent: Doc = { kind: "breakParent" };

/** An assignment's right side in Prettier's "fluid" layout: see the command. */
export function fluid(contents: Doc): Doc {
  return { kind: "fluid", contents };
}

/** `docs` with `separator` between each two. */
export function join(separator: Doc, docs: readonly Doc[]): Doc[] {
  const out: Doc[] = [];
  docs.forEach((doc, index) => {
    if (index > 0) out.push(separator);
    out.push(doc);
  });
  return out;
}

/** Whether a document holds a hard line anywhere. */
export function hasHardline(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (Array.isArray(doc)) return doc.some(hasHardline);
  const command = doc as DocCommand;
  switch (command.kind) {
    case "line":
      return command.hard;
    case "group":
    case "indent":
    case "fluid":
      return hasHardline(command.contents);
    case "ifBreak":
      return hasHardline(command.broken) || hasHardline(command.flat);
    case "conditional":
      return command.states.some(hasHardline);
    case "breakParent":
      return true;
  }
}

/** Marks every group that holds a hard line as broken (Prettier's `propagateBreaks`). */
function propagateBreaks(doc: Doc): boolean {
  if (typeof doc === "string") return false;
  if (Array.isArray(doc)) {
    let any = false;
    for (const child of doc as readonly Doc[]) {
      if (propagateBreaks(child)) any = true;
    }
    return any;
  }
  const command = doc as DocCommand;
  switch (command.kind) {
    case "line":
      return command.hard;
    case "group": {
      const inner = propagateBreaks(command.contents);
      if (inner) command.shouldBreak = true;
      return command.shouldBreak;
    }
    case "indent":
    case "fluid":
      return propagateBreaks(command.contents);
    case "ifBreak":
      // Prettier propagates from the broken contents only.
      return propagateBreaks(command.broken);
    case "conditional":
      // Its states' own groups are marked, but a conditional group is never
      // broken by its contents, nor does it break its parent: whoever builds
      // one adds a `breakParent` beside it when that is wanted.
      for (const state of command.states) propagateBreaks(state);
      return false;
    case "breakParent":
      return true;
  }
}

/** A command on the printer's stack: an indentation, a mode and a document. */
interface Frame {
  /** The indentation, in columns. */
  readonly indentation: number;
  /** Whether the enclosing group printed flat or broken. */
  readonly mode: "flat" | "break";
  /** The document. */
  readonly doc: Doc;
}

/**
 * Whether `next` fits in `width` columns, reading on into `rest` (the
 * commands after it, in break mode) up to the first line that breaks.
 */
function fits(next: Frame, rest: readonly Frame[], width: number): boolean {
  let remaining = width;
  let restIndex = rest.length;
  const stack: { mode: "flat" | "break"; doc: Doc }[] = [next];
  while (remaining >= 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      if (restIndex === 0) return true;
      restIndex -= 1;
      stack.push(rest[restIndex]);
      continue;
    }
    const { mode, doc } = frame;
    if (typeof doc === "string") {
      remaining -= doc.length;
      continue;
    }
    if (Array.isArray(doc)) {
      for (let index = doc.length - 1; index >= 0; index--)
        stack.push({ mode, doc: (doc as readonly Doc[])[index] });
      continue;
    }
    const command = doc as DocCommand;
    switch (command.kind) {
      case "group":
        stack.push({
          mode: command.shouldBreak ? "break" : mode,
          doc: command.contents,
        });
        break;
      case "indent":
        stack.push({ mode, doc: command.contents });
        break;
      case "ifBreak":
        stack.push({
          mode,
          doc: mode === "break" ? command.broken : command.flat,
        });
        break;
      case "line":
        if (mode === "break" || command.hard) return true;
        if (!command.soft) remaining -= 1;
        break;
      case "conditional":
        stack.push({
          mode,
          doc:
            mode === "break"
              ? command.states[command.states.length - 1]
              : command.states[0],
        });
        break;
      case "breakParent":
        break;
      case "fluid":
        // Its line: a break in break mode, a space when flat.
        if (mode === "break") return true;
        remaining -= 1;
        stack.push({ mode, doc: command.contents });
        break;
    }
  }
  return false;
}

/**
 * Prints a document to a string, `PRINT_WIDTH` wide, two spaces per level,
 * with trailing whitespace trimmed from every line.
 */
export function printDoc(doc: Doc): string {
  propagateBreaks(doc);
  const out: string[] = [];
  let column = 0;
  const stack: Frame[] = [{ indentation: 0, mode: "break", doc }];
  while (stack.length > 0) {
    const { indentation, mode, doc: current } = stack.pop()!;
    if (typeof current === "string") {
      out.push(current);
      column += current.length;
      continue;
    }
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--)
        stack.push({
          indentation,
          mode,
          doc: (current as readonly Doc[])[index],
        });
      continue;
    }
    const command = current as DocCommand;
    switch (command.kind) {
      case "group": {
        if (mode === "flat" && !command.shouldBreak) {
          stack.push({ indentation, mode: "flat", doc: command.contents });
          break;
        }
        const flat: Frame = {
          indentation,
          mode: "flat",
          doc: command.contents,
        };
        stack.push(
          !command.shouldBreak && fits(flat, stack, PRINT_WIDTH - column)
            ? flat
            : { indentation, mode: "break", doc: command.contents },
        );
        break;
      }
      case "indent":
        stack.push({
          indentation: indentation + (command.width ?? 2),
          mode,
          doc: command.contents,
        });
        break;
      case "ifBreak":
        stack.push({
          indentation,
          mode,
          doc: mode === "break" ? command.broken : command.flat,
        });
        break;
      case "line":
        if (mode === "flat" && !command.hard) {
          if (!command.soft) {
            out.push(" ");
            column += 1;
          }
          break;
        }
        out.push(`\n${" ".repeat(indentation)}`);
        column = indentation;
        break;
      case "conditional": {
        const { states } = command;
        if (mode === "flat") {
          stack.push({ indentation, mode: "flat", doc: states[0] });
          break;
        }
        const chosen = states.find((state) =>
          fits(
            { indentation, mode: "flat", doc: state },
            stack,
            PRINT_WIDTH - column,
          ),
        );
        stack.push(
          chosen === undefined
            ? { indentation, mode: "break", doc: states[states.length - 1] }
            : { indentation, mode: "flat", doc: chosen },
        );
        break;
      }
      case "breakParent":
        break;
      case "fluid": {
        const rhs: Frame = { indentation, mode, doc: command.contents };
        if (
          mode === "flat" ||
          fits(
            { indentation, mode: "flat", doc: line },
            [...stack, { ...rhs, mode: "break" }],
            PRINT_WIDTH - column,
          )
        ) {
          stack.push(rhs);
          out.push(" ");
          column += 1;
        } else {
          stack.push({
            indentation: indentation + 2,
            mode: "break",
            doc: [hardline, command.contents],
          });
        }
        break;
      }
    }
  }
  // Prettier trims the whitespace a broken line leaves behind (`key: ` before
  // a union that breaks); no emitted line ends in meaningful spaces.
  return out.join("").replace(/ +$/gm, "");
}
