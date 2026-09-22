import type {
  BunRunnerOptions,
  ExecutionMode,
  RunLogLine,
  RunLogPage,
  RunnerDriver,
  RunRecord,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunRunner,
  DEFAULT_RUN_LOG_MAX_LINE_BYTES,
  MemoryDriver,
  runnerKey,
} from "../lib/index";
import {
  createRedactor,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_REPLACEMENT,
} from "../lib/runner/index";
import {
  REDACTION_FAILED_TEXT,
  RunLogCapture,
} from "../lib/runner/runLogCapture";
import { testNamespace } from "./helpers";

/**
 * Redaction of captured run-log lines.
 *
 * The rules are asserted one by one against `createRedactor`, then end to end
 * through real runs on a real driver — every stream, every realm — and against
 * the caps, because the order is the point: a line is redacted **before** the
 * per-line cut and before any byte of it is counted, so every cap measures it
 * exactly as stored.
 */

const R = DEFAULT_REDACT_REPLACEMENT;

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const started: BunRunner<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    started.map((runner) => runner.stop({ force: true })),
  );
  started.length = 0;
});

/** A runner over a fresh memory driver running the `secrets` fixture. */
function makeRunner(options: Partial<BunRunnerOptions<any>> = {}): {
  runner: BunRunner<any, any>;
  driver: RunnerDriver;
} {
  const driver = new MemoryDriver();
  const runner = new BunRunner({
    id: "secrets",
    namespace: testNamespace("redact"),
    file: fixture("secrets"),
    executionMode: "in-process",
    waitToExit: false,
    logger: noopLogger,
    syncInterval: 0,
    driver,
    ...options,
  } as BunRunnerOptions<any>);
  started.push(runner);
  return { runner, driver };
}

/** Triggers one run and resolves with its record once it has settled. */
async function runOnce(
  runner: BunRunner<any, any>,
  args: unknown,
): Promise<RunRecord> {
  const settled = new Promise<RunRecord>((resolve) => {
    runner.once("finished", (entry) => resolve(entry));
    runner.once("failed", (entry) => resolve(entry));
  });
  await runner.start();
  await runner.trigger({ args });
  return await settled;
}

/** Everything one run's log holds. */
async function readLog(
  driver: RunnerDriver,
  runner: BunRunner<any, any>,
  runId: string,
): Promise<RunLogPage> {
  return await driver.getRunLog!(
    runner.namespace,
    runnerKey(runner.id),
    runId,
    {
      offset: 0,
      limit: 10_000,
      order: "asc",
    },
  );
}

/** The text of every line from one stream. */
function textOf(lines: RunLogLine[], stream: RunLogLine["stream"]): string[] {
  return lines
    .filter((line) => line.stream === stream)
    .map((line) => line.text);
}

describe("redaction: the default rules", () => {
  const redact = createRedactor(true)!;

  it("scrubs key=value and key: value, keeping the key and the separator", () => {
    expect(redact("password=hunter2 user=bob")).toBe(`password=${R} user=bob`);
    expect(redact("secret: s3cr3t next")).toBe(`secret: ${R} next`);
    expect(redact("token = abc123")).toBe(`token = ${R}`);
    expect(redact("apiKey=AKIA123;other=1")).toBe(`apiKey=${R};other=1`);
  });

  it("matches a sensitive word anywhere in the key, in any case", () => {
    expect(redact("DB_PASSWORD=abc")).toBe(`DB_PASSWORD=${R}`);
    expect(redact("x-api-key: 0123")).toBe(`x-api-key: ${R}`);
    expect(redact("githubToken=ghp_x&next=2")).toBe(`githubToken=${R}&next=2`);
    expect(redact("CLIENT_SECRET=zzz")).toBe(`CLIENT_SECRET=${R}`);
    expect(redact("Cookie: sid=abc")).toBe(`Cookie: ${R}`);
    expect(redact("session_id=77")).toBe(`session_id=${R}`);
    expect(redact("aws_access_key=AK")).toBe(`aws_access_key=${R}`);
  });

  it("scrubs quoted and JSON values, keeping the quotes", () => {
    expect(redact(`token="a b c" user="x"`)).toBe(`token="${R}" user="x"`);
    expect(redact("token='quoted val'")).toBe(`token='${R}'`);
    expect(
      redact(`config {"password": "p a s", "user":"x", "apiKey":12345}`),
    ).toBe(`config {"password": "${R}", "user":"x", "apiKey":${R}}`);
    expect(redact(`{"secret":"with \\"escaped\\" quotes","ok":1}`)).toBe(
      `{"secret":"${R}","ok":1}`,
    );
    // A value cut off before its closing quote is still hidden.
    expect(redact(`password="half a secr`)).toBe(`password="${R}"`);
  });

  it("keeps an authorization scheme readable and hides the credential", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe(
      `Authorization: Bearer ${R}`,
    );
    expect(redact("authorization=Basic dXNlcjpwYXNz")).toBe(
      `authorization=Basic ${R}`,
    );
  });

  it("scrubs a bare bearer token anywhere", () => {
    expect(redact("calling with Bearer eyabc123-_.~+/xyz== now")).toBe(
      `calling with Bearer ${R} now`,
    );
  });

  it("scrubs the password in a URL's credentials, keeping the user", () => {
    expect(redact("connecting to postgres://app:pa55@db:5432/prod")).toBe(
      `connecting to postgres://app:${R}@db:5432/prod`,
    );
    expect(redact("redis://:onlypass@cache:6379")).toBe(
      `redis://:${R}@cache:6379`,
    );
    // No credentials, nothing to do.
    expect(redact("https://example.com:8443/path")).toBe(
      "https://example.com:8443/path",
    );
  });

  it("scrubs a JWT anywhere", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redact(`got ${jwt} back`)).toBe(`got ${R} back`);
  });

  it("finds a key after a separator that is not its own", () => {
    // `Error:` is a key too, but not a sensitive one — its value must still be
    // scanned rather than swallowed.
    expect(redact("Error: password=x failed")).toBe(
      `Error: password=${R} failed`,
    );
    expect(redact(`creds={"secret":"s"}`)).toBe(`creds={"secret":"${R}"}`);
  });

  it("leaves lines without secrets untouched", () => {
    for (const line of [
      "no secrets here",
      "cacheKey=abc user=bob count=3",
      "the password is hunter2", // prose: documented as not caught
      "",
    ]) {
      expect(redact(line)).toBe(line);
    }
  });

  it("names the default key words the README documents", () => {
    expect([...DEFAULT_REDACT_KEYS]).toEqual([
      "password",
      "passwd",
      "pwd",
      "secret",
      "token",
      "apikey",
      "api_key",
      "api-key",
      "authorization",
      "auth",
      "credential",
      "cookie",
      "session",
      "private_key",
      "privatekey",
      "access_key",
      "accesskey",
    ]);
    expect(R).toBe("[REDACTED]");
  });

  it("runs in linear time on hostile megabyte lines", () => {
    for (const line of [
      "a".repeat(1_000_000),
      "token".repeat(200_000),
      "token=".repeat(160_000),
      "token: ".repeat(140_000),
      "password ".repeat(110_000),
      `password="`.repeat(100_000),
      '"'.repeat(1_000_000),
      "x=".repeat(500_000),
      "http://".repeat(140_000),
      "eyJ".repeat(330_000),
    ]) {
      const begun = performance.now();
      redact(line);
      // Generous: a quadratic backtrack here takes minutes, not a second.
      expect(performance.now() - begun).toBeLessThan(1_500);
    }
  });
});

describe("redaction: the option", () => {
  it("is off with false, on by default", () => {
    expect(createRedactor(false)).toBeNull();
    expect(createRedactor(undefined)!("password=x")).toBe(`password=${R}`);
    expect(createRedactor(true)!("password=x")).toBe(`password=${R}`);
  });

  it("adds keys and patterns to the defaults", () => {
    const redact = createRedactor({
      keys: ["SSN"],
      patterns: [/sk_live_\w+/, /card-\d{4}/g],
    })!;
    expect(redact("ssn=123-45-6789 password=x")).toBe(`ssn=${R} password=${R}`);
    // A pattern without `g` still scrubs every match on the line.
    expect(redact("sk_live_abc and sk_live_def, card-1234 card-5678")).toBe(
      `${R} and ${R}, ${R} ${R}`,
    );
  });

  it("replaces the defaults with defaults: false", () => {
    const redact = createRedactor({ defaults: false, keys: ["ssn"] })!;
    expect(redact("ssn=1 password=x Bearer abc")).toBe(
      `ssn=${R} password=x Bearer abc`,
    );
    expect(createRedactor({ defaults: false })).toBeNull();
  });

  it("uses the replacement given, literally, even with $ in it", () => {
    const redact = createRedactor({ replacement: "$1***" })!;
    expect(redact("password=x")).toBe("password=$1***");
    expect(redact("Bearer abc")).toBe("Bearer $1***");
    expect(redact("postgres://u:p@h")).toBe("postgres://u:$1***@h");
  });
});

describe("redaction: through real runs", () => {
  const line = `boot password=hunter2 Authorization: Bearer tok.en url=postgres://app:pa55@db/prod`;
  const scrubbed = `boot password=${R} Authorization: Bearer ${R} url=postgres://app:${R}@db/prod`;

  for (const mode of ["in-process", "worker", "spawn"] as ExecutionMode[]) {
    it(`scrubs every stream of a ${mode} run before it is stored`, async () => {
      const { runner, driver } = makeRunner({ executionMode: mode });
      const record = await runOnce(runner, {
        lines: [line],
        fields: { apiKey: "k-123", count: 2 },
      });
      const page = await readLog(driver, runner, record.runId);

      expect(record.status).toBe("success");
      expect(textOf(page.lines, "stdout")).toEqual([scrubbed]);
      expect(textOf(page.lines, "stderr")).toEqual([scrubbed]);
      // The rendered `log` line — message and fields — is scrubbed too.
      expect(textOf(page.lines, "log")).toEqual([
        `${scrubbed} apiKey=${R} count=2`,
      ]);
      const stored = JSON.stringify(page.lines);
      for (const secret of ["hunter2", "tok.en", "pa55", "k-123"]) {
        expect(stored).not.toContain(secret);
      }
    });
  }

  it("stores lines verbatim with redact: false", async () => {
    const { runner, driver } = makeRunner({
      captureLogs: { redact: false },
    });
    const record = await runOnce(runner, { lines: ["password=hunter2"] });
    const page = await readLog(driver, runner, record.runId);
    expect(textOf(page.lines, "stdout")).toEqual(["password=hunter2"]);
  });

  it("honours the runner's own keys, patterns and replacement", async () => {
    const { runner, driver } = makeRunner({
      captureLogs: {
        redact: { keys: ["pin"], patterns: [/acct-\d+/], replacement: "###" },
      },
    });
    const record = await runOnce(runner, {
      lines: ["pin=4321 acct-998877 password=x"],
    });
    const page = await readLog(driver, runner, record.runId);
    expect(textOf(page.lines, "stdout")).toEqual(["pin=### ### password=###"]);
  });
});

describe("redaction: before the caps", () => {
  it("measures a line after redaction: a long secret that redacts short is not truncated", async () => {
    const { runner, driver } = makeRunner({
      captureLogs: { maxLineBytes: 40 },
    });
    const secret = "x".repeat(500);
    const record = await runOnce(runner, { lines: [`token=${secret} ok`] });
    const page = await readLog(driver, runner, record.runId);

    const stdout = page.lines.filter((entry) => entry.stream === "stdout");
    expect(stdout.map((entry) => entry.text)).toEqual([`token=${R} ok`]);
    // Cut first, it would have been 40 bytes of `token=xxxx…`, flagged, and
    // redacted to nothing useful — or, worse, cut and then left unredacted.
    expect(stdout[0]!.truncated).toBeUndefined();
  });

  it("cuts after redaction, so a cut can never expose half a secret", async () => {
    const { runner, driver } = makeRunner({
      captureLogs: { maxLineBytes: 12 },
    });
    const record = await runOnce(runner, { lines: ["password=abcdefghijkl"] });
    const page = await readLog(driver, runner, record.runId);

    const stdout = page.lines.find((entry) => entry.stream === "stdout")!;
    expect(stdout.truncated).toBe(true);
    expect(stdout.text).toBe("password=[RE");
    expect(stdout.text).not.toContain("abc");
  });

  it("counts redacted bytes against captureBytes and the store's maxBytes", async () => {
    // Each line is 1,007 bytes raw and 17 (`secret=[REDACTED]`) stored. Ten of
    // them, three streams each, is 510 bytes stored — inside both caps below —
    // where the raw text would pass either cap on its first line.
    const { runner, driver } = makeRunner({
      captureLogs: { captureBytes: 600, maxBytes: 600 },
    });
    const lines = Array.from(
      { length: 10 },
      () => `secret=${"s".repeat(1_000)}`,
    );
    const record = await runOnce(runner, { lines });
    const page = await readLog(driver, runner, record.runId);

    expect(page.dropped).toBe(0);
    expect(page.lines).toHaveLength(30);
    expect(page.lines.every((entry) => entry.text === `secret=${R}`)).toBe(
      true,
    );
    // No capture-ceiling notice: the ceiling never came near.
    expect(
      page.lines.some((entry) => entry.text.includes("captureBytes")),
    ).toBe(false);
    expect(record.logsDropped).toBe(0);
  });

  it("withholds a line whose redaction throws, rather than storing it raw", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("redact");
    const capture = new RunLogCapture({
      driver,
      namespace,
      key: runnerKey("unit"),
      runId: "run-redact-fails",
      caps: { maxLines: 0, maxBytes: 0, keepRuns: 10 },
      options: {
        enabled: true,
        maxLines: 0,
        maxBytes: 0,
        maxLineBytes: DEFAULT_RUN_LOG_MAX_LINE_BYTES,
        captureBytes: 0,
        console: false,
        redact: () => {
          throw new Error("redactor broke");
        },
      },
      logger: noopLogger,
    });

    capture.line("password=hunter2");
    capture.output("stdout", "token=abc\n");
    await capture.close();

    const page = await driver.getRunLog!(
      namespace,
      runnerKey("unit"),
      "run-redact-fails",
      { offset: 0, limit: 10, order: "asc" },
    );
    expect(page.lines.map((entry) => entry.text)).toEqual([
      REDACTION_FAILED_TEXT,
      REDACTION_FAILED_TEXT,
    ]);
  });
});
