/**
 * Printing and waiting — the two things every example does besides the thing
 * it is about. Kept here so the examples themselves read as usage, not
 * scaffolding.
 */

/** When the process started, so output can say how far into a run it is. */
const started = performance.now();

/** Milliseconds since the example started, padded for alignment. */
export function elapsed(): string {
  return `${(performance.now() - started).toFixed(0).padStart(5)}ms`;
}

/** Prints an example's title. */
export function title(text: string): void {
  console.log(`\n=== ${text} ===`);
}

/** Prints the start of a section within an example. */
export function step(text: string): void {
  console.log(`\n--- ${text}`);
}

/** Prints one line of what happened, stamped with the elapsed time. */
export function show(text: string, value?: unknown): void {
  if (value === undefined) {
    console.log(`  [${elapsed()}] ${text}`);
    return;
  }

  console.log(
    `  [${elapsed()}] ${text}:`,
    typeof value === "string" ? value : Bun.inspect(value, { colors: false }),
  );
}

/**
 * Resolves once `predicate` holds, checking every `interval` milliseconds.
 *
 * Examples wait on what they are demonstrating — "three jobs completed" —
 * rather than sleeping for a guessed duration, so they finish as soon as the
 * work does and fail loudly, naming what never happened, if it does not.
 */
export async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  options: {
    /** Give up after this many milliseconds. Defaults to `15000`. */
    timeout?: number;
    /** How often to check. Defaults to `10`. */
    interval?: number;
  } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeout ?? 15_000);

  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }

    await Bun.sleep(options.interval ?? 10);
  }
}
