/**
 * The console patch itself, shared by the two places a run's `console.*`
 * output is captured: `consoleCapture.ts` (an `in-process` run, attributed by
 * `AsyncLocalStorage`) and `realmConsole.ts` (a `worker-thread` run, alone in its
 * realm, so attributed by a plain module variable).
 *
 * It has **no runtime imports**, and must keep it that way: a worker realm
 * loads it once per run, and `node:util` alone costs a few milliseconds to load
 * there. {@link formatConsoleArgs} reaches for `node:util` only for arguments
 * it cannot format exactly by itself.
 *
 * Three rules keep the patch harmless:
 *
 * - **It tees, never redirects.** The original method is always called, with
 *   the original arguments, so what reaches the terminal is exactly what did
 *   before.
 * - **Capture cannot fail the call.** The sink runs first, inside a
 *   `try`/`catch`, behind a re-entrancy guard — a sink that itself logs (or a
 *   listener it triggers that does) passes straight through rather than
 *   recursing.
 * - **Removing it undoes only our own layer.** A method something else wrapped
 *   after us (a test spy, another library) is left alone, and our wrapper
 *   underneath it simply passes through once no sink is current.
 */

/** Which stream each captured console method writes to, as Bun itself routes them. */
export const CONSOLE_STREAMS = {
  log: "stdout",
  info: "stdout",
  debug: "stdout",
  warn: "stderr",
  error: "stderr",
} as const satisfies Record<string, "stdout" | "stderr">;

/** A console method this module captures. */
export type CapturedConsoleMethod = keyof typeof CONSOLE_STREAMS;

/**
 * Where one run's console output goes: called with the stream and the text of
 * one call, formatted as `util.format` formats it and ending in a newline.
 */
export type ConsoleSink = (stream: "stdout" | "stderr", text: string) => void;

/** A console method's signature, as the patch wraps it. */
type ConsoleMethod = (...args: unknown[]) => void;

/** `node:util`'s `format`, loaded the first time an argument needs it. */
let utilFormat: ((...args: unknown[]) => string) | undefined;

/** Formats `args` with `util.format`, loading it on first use. */
function slowFormat(args: readonly unknown[]): string {
  utilFormat ??= (
    import.meta.require("node:util") as {
      format: (...args: unknown[]) => string;
    }
  ).format;
  return utilFormat(...args);
}

/**
 * The text `util.format(...args)` produces, byte for byte.
 *
 * Arguments that are all strings, numbers, booleans, bigints, `null` or
 * `undefined` — with no `%` in a leading string, which would make it a format
 * string — are joined here directly: what the overwhelming majority of log
 * lines are, and exactly what `util.format` would answer. Anything else (an
 * object, a function, a symbol, a format string) goes to `util.format` itself,
 * which is loaded then and not before. `Bun.inspect` is not a substitute: it
 * renders objects differently (multi-line, double quotes, no depth limit), so
 * captured lines would change.
 */
export function formatConsoleArgs(args: readonly unknown[]): string {
  let text = "";

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let piece: string;

    switch (typeof arg) {
      case "string":
        if (index === 0 && arg.includes("%")) {
          return slowFormat(args);
        }
        piece = arg;
        break;
      case "number":
        // `String(-0)` is "0"; `util.format` keeps the sign.
        piece = Object.is(arg, -0) ? "-0" : String(arg);
        break;
      case "boolean":
        piece = arg ? "true" : "false";
        break;
      case "undefined":
        piece = "undefined";
        break;
      case "bigint":
        piece = `${arg}n`;
        break;
      default:
        if (arg === null) {
          piece = "null";
          break;
        }
        return slowFormat(args);
    }

    text = index === 0 ? piece : `${text} ${piece}`;
  }

  return text;
}

/** Set while a sink runs, so console output it causes is not captured again. */
let inSink = false;

/** Builds the patch for one method. */
function patchFor(
  method: CapturedConsoleMethod,
  original: ConsoleMethod,
  currentSink: () => ConsoleSink | undefined,
): ConsoleMethod {
  const stream = CONSOLE_STREAMS[method];

  return function capturedConsole(this: unknown, ...args: unknown[]): void {
    const sink = currentSink();
    if (sink !== undefined && !inSink) {
      inSink = true;
      try {
        sink(stream, `${formatConsoleArgs(args)}\n`);
      } catch {
        // Capture never changes what the call does, or how the run ends.
      } finally {
        inSink = false;
      }
    }

    original.apply(this ?? console, args);
  };
}

/**
 * Replaces each method in {@link CONSOLE_STREAMS} with a patch that tees every
 * call to `currentSink()`, when it returns one, and returns the function that
 * puts back each original still covered by our patch.
 */
export function patchConsole(
  /** The sink the current call belongs to, or `undefined` for none. */
  currentSink: () => ConsoleSink | undefined,
): () => void {
  const target = console as unknown as Record<
    CapturedConsoleMethod,
    ConsoleMethod
  >;
  const patched: {
    method: CapturedConsoleMethod;
    original: ConsoleMethod;
    patch: ConsoleMethod;
  }[] = [];

  for (const method of Object.keys(
    CONSOLE_STREAMS,
  ) as CapturedConsoleMethod[]) {
    const original = target[method];
    if (typeof original !== "function") {
      continue;
    }
    const patch = patchFor(method, original, currentSink);
    patched.push({ method, original, patch });
    target[method] = patch;
  }

  return () => {
    for (const { method, original, patch } of patched) {
      // Only undo our own layer: a wrapper added on top of it since belongs to
      // someone else, and ours beneath it passes through with no sink current.
      if (target[method] === patch) {
        target[method] = original;
      }
    }
    patched.length = 0;
  };
}
