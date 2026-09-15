import process from "node:process";

/**
 * Checks for the option tours in `10-options/`.
 *
 * The other examples *show* behaviour; a tour also *asserts* it, so running
 * one is a test of the option it covers. A failed check prints what was
 * expected and what happened, and marks the process as failed — but does not
 * stop it, so one run reports every broken option rather than the first.
 * `bun run-all.ts` then reports the file as FAIL.
 *
 * ```ts
 * checkEqual("attempts made", job.attemptsMade, 3);
 * check("ran after its delay", ranAt - addedAt >= 200, { ranAt, addedAt });
 * await checkRejects("add after close", () => queue.add("x", {}), {
 *   name: "QueueClosedError",
 * });
 * summary();
 * ```
 */

/** How many checks passed. */
let passed = 0;

/** Labels of the checks that failed, in order. */
const failures: string[] = [];

/** Records a failure: printed now, counted by `summary()`, exit code set. */
function fail(label: string, detail: unknown): void {
  failures.push(label);
  process.exitCode = 1;
  console.log(`  ✗ ${label}`);
  console.log(
    `      ${Bun.inspect(detail, { colors: false }).split("\n").join("\n      ")}`,
  );
}

/** Records a pass. */
function pass(label: string): void {
  passed++;
  console.log(`  ✓ ${label}`);
}

/** Passes when `condition` holds; `detail` is printed if it does not. */
export function check(
  label: string,
  condition: boolean,
  detail?: unknown,
): void {
  if (condition) {
    pass(label);
  } else {
    fail(label, detail ?? "condition was false");
  }
}

/** Passes when `actual` deeply equals `expected`. */
export function checkEqual<T>(label: string, actual: T, expected: T): void {
  if (Bun.deepEquals(actual, expected)) {
    pass(label);
  } else {
    fail(label, { expected, actual });
  }
}

/** What a rejection is expected to look like; every given field must match. */
export interface ExpectedError {
  /** The error's `name`, e.g. `"QueueClosedError"`. */
  name?: string;
  /** The error's `code`, for errors from this package, e.g. `"CONFIG"`. */
  code?: string;
  /** A pattern the message must match. */
  message?: RegExp;
}

/**
 * Passes when `run` throws or rejects with an error matching `expected`.
 * Answers with the error, so a caller can check more of it.
 */
export async function checkRejects(
  label: string,
  run: () => unknown,
  expected: ExpectedError = {},
): Promise<Error | undefined> {
  let error: unknown;

  try {
    await run();
  } catch (caught) {
    error = caught;
  }

  if (!(error instanceof Error)) {
    fail(label, { expected, actual: error ?? "did not throw" });
    return undefined;
  }

  const code = (error as Error & { code?: unknown }).code;
  const matches =
    (expected.name === undefined || error.name === expected.name) &&
    (expected.code === undefined || code === expected.code) &&
    (expected.message === undefined || expected.message.test(error.message));

  if (matches) {
    pass(`${label} — ${error.name}${code ? ` (${String(code)})` : ""}`);
  } else {
    fail(label, {
      expected,
      actual: { name: error.name, code, message: error.message },
    });
  }

  return error;
}

/**
 * Prints how many checks passed and failed. Call it last; the exit code is
 * already set by any failure, so a tour that crashes before it still fails.
 */
export function summary(): void {
  console.log(
    failures.length === 0
      ? `\n${passed} checks passed.`
      : `\n${passed} checks passed, ${failures.length} FAILED:\n${failures
          .map((label) => `  - ${label}`)
          .join("\n")}`,
  );
}
