import type { LogEvent } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
  consoleSink,
  createLogger,
  createTestLogger,
  noopLogger,
} from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { BunQueue, createDriver, SummonController } from "../../lib/index";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  toStandardSchema,
} from "../../lib/provider/index";
import { redactingLogger, textRedactor } from "../../lib/provider/redact";
import { makeTmpDir, testNamespace } from "../helpers";

/**
 * The redactor, round 2 of #250's review: an error copy is readable whatever
 * its class (a `DOMException`'s brand-checked getters included), keys,
 * functions, boxed strings, symbols, blobs and a `Date` with its own
 * `toJSON` fail closed, a secret no encoding can take still configures, and
 * a few more text shapes are matched.
 */

const SECRET = "sk-live-0123456789abcdef";

const dir = await makeTmpDir("bun-jobs-provider-redact-shapes");
afterAll(dir.cleanup);

/** Logs `fields` through a redacting logger declaring `secrets`, and returns the event. */
function logged(
  fields: Record<string, unknown>,
  secrets: readonly unknown[] = [SECRET],
): LogEvent {
  const { logger, events } = createTestLogger();
  redactingLogger(logger, secrets).info("m", fields);
  return events[0]!;
}

/** A DOMException `AbortSignal.timeout(0)` aborts with, once it has. */
async function timeoutReason(): Promise<DOMException> {
  const signal = AbortSignal.timeout(0);
  await Bun.sleep(10);
  return signal.reason as DOMException;
}

/** A provider whose asynchronous schema rejects with `reason()`. */
function rejectingWith(reason: () => Promise<unknown>) {
  return defineComputeProvider<{ apiToken: string }>({
    name: "rejecting-dom",
    version: "1.0.0",
    kind: "rejecting-dom",
    apiVersion: { ...COMPUTE_PROVIDER_API },
    config: toStandardSchema<{ apiToken: string }, { apiToken: string }>(
      async () => {
        throw await reason();
      },
    ),
    secrets: ["apiToken"],
    summon: () => {
      throw new Error("never built");
    },
  });
}

describe("B1: a redacted error stays readable, a DOMException's included", () => {
  it("ready's rejection with AbortSignal.timeout's reason: name, message, code and String() all read", async () => {
    const configured = rejectingWith(timeoutReason)({ apiToken: SECRET });
    const error = (await configured.ready.then(
      () => {
        throw new Error("ready resolved");
      },
      (reason: unknown) => reason,
    )) as DOMException;
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBeString();
    expect(error.code).toBe(23);
    expect(String(error)).toStartWith("TimeoutError: ");
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      name: "TimeoutError",
    });
  });

  it("a real controller's check records a failed attempt rather than throwing", async () => {
    const driver = createDriver({
      type: "file",
      root: join(dir.path, testNamespace("root")),
    });
    await driver.connect();
    const namespace = testNamespace("redact-dom");
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const controller = new SummonController({
      logger: noopLogger,
      driver,
      namespace,
      queue: "work",
      summoner: rejectingWith(timeoutReason)({ apiToken: SECRET }),
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      backoff: { initial: 5, max: 5 },
    });
    try {
      await queue.add("job", {});
      expect(await controller.check()).toMatchObject({
        action: "summoned",
        outcome: "failed",
      });
      expect((await controller.status()).last).toMatchObject({
        outcome: "failed",
        detail: "TimeoutError",
      });
    } finally {
      await controller.close();
      await queue.close();
      await driver.purge(namespace);
      await driver.close();
    }
  });

  it("a DOMException carrying a secret, logged into a JSON console sink: written, redacted", () => {
    const lines: string[] = [];
    const sinkConsole = {
      log: (line: string) => lines.push(line),
      info: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
      debug: (line: string) => lines.push(line),
      trace: (line: string) => lines.push(line),
    } as unknown as Console;
    const log = redactingLogger(
      createLogger({
        sink: consoleSink({ console: sinkConsole, format: "json" }),
      }),
      [SECRET],
    );
    log.error("aborted", {
      error: new DOMException(`gave up on ${SECRET}`, "TimeoutError"),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
    expect(JSON.parse(lines[0]!).err).toMatchObject({
      name: "TimeoutError",
      message: "gave up on [REDACTED]",
    });
  });

  it("a toJSON on the error's prototype never runs: the copy serialises its own redacted view", () => {
    const hidden = { value: SECRET };
    class Leaky extends Error {
      /** Serialises a value the copy's fields do not hold. */
      toJSON(): unknown {
        return { hidden: hidden.value };
      }
    }
    const event = logged({ error: new Leaky(`failed ${SECRET}`) });
    const text = JSON.stringify(event.error ?? event.fields.error);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({
      name: "Error",
      message: "failed [REDACTED]",
    });
  });

  it("an error class whose toString is brand-checked falls back to a plain Error with its name", () => {
    class Branded extends Error {
      readonly #tag = "branded";
      constructor(message: string) {
        super(message);
        this.name = "Branded";
      }

      /** Reads a private field: throws on anything but a real instance. */
      override toString(): string {
        return `${this.#tag}: ${this.message}`;
      }
    }
    const event = logged({ error: new Branded(`failed ${SECRET}`) });
    const error = (event.error ?? event.fields.error) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(Branded);
    expect(String(error)).toBe("Branded: failed [REDACTED]");
  });
});

describe("S1: a secret no encoding can take", () => {
  const lone = "\uD800abcdefghij";

  it("redactingLogger still builds, and redacts it raw", () => {
    const event = logged({ value: `x ${lone} y` }, [lone]);
    expect(event.fields.value).toBe("x [REDACTED] y");
  });

  it("provider(config) still configures", () => {
    const provider = defineComputeProvider<{ apiToken: string }>({
      name: "lone",
      version: "1.0.0",
      kind: "lone",
      apiVersion: { ...COMPUTE_PROVIDER_API },
      secrets: ["apiToken"],
      summon: () => ({
        capabilities: {
          style: "launch",
          dedupe: { kind: "none" },
          passes: "argv",
          bootBudgetMs: 1_000,
          shutdown: { signal: "SIGTERM", graceMs: 1_000 },
          maxLifetimeMs: null,
          enforcesLifetime: false,
        },
        summon: async () => ({ status: "started", handles: [] }),
      }),
    });
    expect(provider({ apiToken: lone }).config.apiToken).toBe(lone);
  });
});

describe("S2: what the walk used to pass through fails closed", () => {
  it("a secret used as an object key or a Map key is redacted", () => {
    const event = logged({
      record: { [SECRET]: 1 },
      map: new Map([[`k ${SECRET}`, 2]]),
    });
    expect(event.fields).toEqual({
      record: { "[REDACTED]": 1 },
      map: { "k [REDACTED]": 2 },
    });
  });

  it("a Date subclass with its own toJSON is logged as what it returns; a plain Date passes", () => {
    class Stamped extends Date {
      /** Serialises the secret. */
      override toJSON(): string {
        return `stamp ${SECRET}`;
      }
    }
    const at = new Date(0);
    const event = logged({ stamped: new Stamped(0), at });
    expect(event.fields.stamped).toBe("stamp [REDACTED]");
    expect(event.fields.at).toBe(at);
  });

  it("a function is a placeholder, so its toJSON cannot run", () => {
    const fn = Object.assign(() => {}, { toJSON: () => SECRET });
    const event = logged({ fn, list: [fn] });
    expect(event.fields).toEqual({ fn: "[Function]", list: ["[Function]"] });
    expect(JSON.stringify(event.fields)).not.toContain(SECRET);
  });
});

describe("minor: more shapes and patterns", () => {
  it("a String object is its text, a Symbol its description, a Blob or File a placeholder", () => {
    const event = logged({
      // A boxed string, as `Object(text)` makes one.
      boxed: new Object(`x ${SECRET}`) as object,
      symbol: Symbol(SECRET),
      blob: new Blob(["hello"]),
      file: new File(["abc"], "f.txt"),
    });
    expect(event.fields).toEqual({
      boxed: "x [REDACTED]",
      symbol: "[REDACTED]",
      blob: "[Binary 5 bytes]",
      file: "[Binary 3 bytes]",
    });
  });

  it("a RegExp built from a secret with metacharacters, escaped, is redacted", () => {
    const secret = "sk.live+key(1)/x?y";
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escape = (RegExp as { escape?: (text: string) => string }).escape;
    const event = logged(
      {
        helper: new RegExp(escaped),
        ...(escape === undefined ? {} : { native: new RegExp(escape(secret)) }),
      },
      [secret],
    );
    expect(event.fields.helper).toBe("/[REDACTED]/");
    if (escape !== undefined) {
      expect(event.fields.native).toBe("/[REDACTED]/");
    }
  });

  it("Basic: a base64url credential is replaced whole, and the run ends where the base64 does", () => {
    const redact = textRedactor([]);
    // Chosen so the base64url form holds `-` and `_`.
    const b64url = Buffer.from("user:p>>?secret~~").toString("base64url");
    expect(b64url).toMatch(/[-_]/);
    expect(redact(`Basic ${b64url}`)).toBe("Basic [REDACTED]");
    const b64 = Buffer.from("admin:hunter22").toString("base64");
    expect(redact(`Basic ${b64}, then more`)).toBe(
      "Basic [REDACTED], then more",
    );
    expect(redact(`Basic ${b64}\nnext line`)).toBe(
      "Basic [REDACTED]\nnext line",
    );
  });

  it("sig= only inside a query; X-Goog-Signature=; the x-amz-signature header", () => {
    const redact = textRedactor([]);
    expect(redact("the sig=verified flag")).toBe("the sig=verified flag");
    expect(redact("https://a.blob/c?sig=abc&x=1")).toBe(
      "https://a.blob/c?sig=[REDACTED]&x=1",
    );
    expect(
      redact("https://storage.googleapis.com/b/o?X-Goog-Signature=0a1b2c&x=1"),
    ).toBe(
      "https://storage.googleapis.com/b/o?X-Goog-Signature=[REDACTED]&x=1",
    );
    expect(redact("x-amz-signature: 0a1b2c3d4e, host: h")).toBe(
      "x-amz-signature: [REDACTED], host: h",
    );
  });

  it("a declared secret percent-encoded in lower case", () => {
    const secret = "p@ss/w0rd+long";
    const toLower = (hex: string): string => hex.toLowerCase();
    const lower = encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, toLower);
    expect(lower).not.toBe(encodeURIComponent(secret));
    expect(textRedactor([secret])(`q=${lower}`)).toBe("q=[REDACTED]");
  });
});

describe("(a) describe()'s facts filter matches the URL-encoded forms", () => {
  it("a fact holding the secret URL-encoded is dropped; the others stay", () => {
    const secret = "p@ss/w0rd+long";
    const provider = defineComputeProvider<{ apiToken: string }>({
      name: "facts",
      version: "1.0.0",
      kind: "facts",
      apiVersion: { core: COMPUTE_PROVIDER_API.core },
      secrets: ["apiToken"],
      describe: (config) => ({
        endpoint: `https://api.example/?t=${encodeURIComponent(config.apiToken)}`,
        region: "eu",
      }),
    });
    expect(provider({ apiToken: secret }).describe()).toEqual({
      region: "eu",
    });
  });
});
