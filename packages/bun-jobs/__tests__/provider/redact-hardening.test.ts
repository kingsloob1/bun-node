import type { LogEvent } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import {
  BunQueue,
  ConfigError,
  createDriver,
  SummonController,
} from "../../lib/index";
import { providerErrorFacts } from "../../lib/provider/errors";
import {
  COMPUTE_PROVIDER_API,
  defineComputeProvider,
  ProviderError,
  toStandardSchema,
} from "../../lib/provider/index";
import {
  MIN_SECRET_LENGTH,
  redactingLogger,
  textRedactor,
} from "../../lib/provider/redact";
import { makeTmpDir, testNamespace } from "../helpers";

/**
 * The redactor fails closed on the shapes it used to pass through (binary,
 * `RegExp`, an object with a `toJSON`), matches four more credential
 * shapes, and a config failure — synchronous, or `ready`'s rejection — is
 * redacted before anyone sees it.
 */

const SECRET = "sk-live-0123456789abcdef";

/** Logs `fields` through a redacting logger declaring `secrets`, and returns the event. */
function logged(
  fields: Record<string, unknown>,
  secrets: readonly unknown[] = [SECRET],
): LogEvent {
  const { logger, events } = createTestLogger();
  redactingLogger(logger, secrets).info("m", fields);
  return events[0]!;
}

describe("binary values become a placeholder", () => {
  it("Buffer, Uint8Array, other typed arrays, ArrayBuffer and DataView", () => {
    const bytes = Buffer.from(`token ${SECRET}`);
    const event = logged({
      buffer: bytes,
      uint8: new Uint8Array(bytes),
      float64: new Float64Array(3),
      arrayBuffer: new ArrayBuffer(5),
      view: new DataView(new ArrayBuffer(7)),
      nested: [{ bytes }],
    });
    expect(event.fields).toEqual({
      buffer: `[Binary ${bytes.length} bytes]`,
      uint8: `[Binary ${bytes.length} bytes]`,
      float64: "[Binary 24 bytes]",
      arrayBuffer: "[Binary 5 bytes]",
      view: "[Binary 7 bytes]",
      nested: [{ bytes: `[Binary ${bytes.length} bytes]` }],
    });
  });
});

describe("a RegExp is logged as its text, redacted", () => {
  it("the declared secret inside a pattern is replaced", () => {
    const event = logged({ pattern: new RegExp(`^${SECRET}$`, "i") });
    expect(event.fields.pattern).toBe("/^[REDACTED]$/i");
  });
});

describe("an object with a toJSON is logged as what toJSON returns, redacted", () => {
  it("an own toJSON returning the secret: JSON.stringify of the fields cannot bring it back", () => {
    const event = logged({
      value: { safe: "x", toJSON: () => ({ note: `the key is ${SECRET}` }) },
    });
    expect(event.fields.value).toEqual({ note: "the key is [REDACTED]" });
    expect(JSON.stringify(event.fields)).not.toContain(SECRET);
  });

  it("a class's toJSON returning a string", () => {
    class Token {
      /** Serialised with the secret in it. */
      toJSON(): string {
        return `Token(${SECRET})`;
      }
    }
    const event = logged({ item: new Token() });
    expect(event.fields.item).toBe("Token([REDACTED])");
  });

  it("a toJSON that throws, or a toJSON getter that throws, is [Unreadable]", () => {
    const event = logged({
      throws: {
        toJSON: () => {
          throw new Error(SECRET);
        },
      },
      getter: {
        get toJSON(): never {
          throw new Error(SECRET);
        },
      },
    });
    expect(event.fields).toEqual({
      throws: "[Unreadable]",
      getter: "[Unreadable]",
    });
  });

  it("toJSON's result is walked like any value: a throwing getter in it is [Unreadable], a secret in it redacted", () => {
    const event = logged({
      value: {
        toJSON: () => ({
          get bad(): never {
            throw new Error("boom");
          },
          good: SECRET,
        }),
      },
    });
    expect(event.fields.value).toEqual({
      bad: "[Unreadable]",
      good: "[REDACTED]",
    });
  });

  it("a toJSON returning its own object terminates, cut as [Circular]", () => {
    const self: Record<string, unknown> = { secret: SECRET };
    self.toJSON = () => self;
    const event = logged({ self });
    expect(event.fields.self).toBe("[Circular]");
    expect(JSON.stringify(event.fields)).not.toContain(SECRET);
  });

  it("a toJSON returning a fresh toJSON each time terminates at the depth limit", () => {
    const endless = (): object => ({ toJSON: endless });
    const event = logged({ endless: endless() });
    expect(event.fields.endless).toBe("[REDACTED]");
  });

  it("a cycle through toJSON's result terminates", () => {
    const outer: Record<string, unknown> = {};
    outer.toJSON = () => ({ back: outer, note: SECRET });
    const event = logged({ outer });
    expect(event.fields.outer).toEqual({
      back: "[Circular]",
      note: "[REDACTED]",
    });
  });

  it("a Date and a URL keep their own handling", () => {
    const at = new Date(0);
    const event = logged({
      at,
      url: new URL(`https://api.example/?q=${SECRET}`),
    });
    expect(event.fields.at).toBe(at);
    expect(event.fields.url).toBe("https://api.example/?q=[REDACTED]");
  });
});

describe("the text redactor's added patterns", () => {
  const redact = textRedactor([]);

  it("a bare Basic credential", () => {
    const basic = Buffer.from("admin:hunter22").toString("base64");
    expect(redact(`sent Basic ${basic} upstream`)).toBe(
      "sent Basic [REDACTED] upstream",
    );
    expect(redact(`-H "authorization: basic ${basic}"`)).toBe(
      '-H "authorization: basic [REDACTED]"',
    );
    // Prose is not a credential: nothing in it decodes to user:password.
    expect(redact("Basic authentication failed")).toBe(
      "Basic authentication failed",
    );
  });

  it("an S3 presigned URL's X-Amz-Signature, other parameters kept", () => {
    expect(
      redact(
        "GET https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=0f1e2d3c4b5a69788796a5b4c3d2e1f0&X-Amz-Expires=60",
      ),
    ).toBe(
      "GET https://b.s3.amazonaws.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=[REDACTED]&X-Amz-Expires=60",
    );
    expect(redact("x-amz-signature=abcdef012345")).toBe(
      "x-amz-signature=[REDACTED]",
    );
  });

  it("an Azure SAS sig, in a URL and in a connection string", () => {
    expect(
      redact(
        "https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sr=b&sp=r&sig=abc%2Bdef%3D&se=2026",
      ),
    ).toBe(
      "https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sr=b&sp=r&sig=[REDACTED]&se=2026",
    );
    expect(redact("SharedAccessSignature=sv=2022&sig=Zm9vYmFy;x=1")).toBe(
      "SharedAccessSignature=sv=2022&sig=[REDACTED];x=1",
    );
    // Only the whole key: `xsig=` and `signal=` are something else.
    expect(redact("xsig=1&signal=abort")).toBe("xsig=1&signal=abort");
  });

  it("a declared secret URL-encoded, as encodeURIComponent and as a form (URLSearchParams) writes it", () => {
    const secret = "p@ss/w0rd+with space&=~!";
    const redactSecret = textRedactor([secret]);
    const encoded = encodeURIComponent(secret);
    const form = new URLSearchParams({ q: secret }).toString().slice(2);
    expect(encoded).not.toBe(secret);
    expect(form).not.toBe(encoded);
    expect(redactSecret(`a=${encoded}`)).toBe("a=[REDACTED]");
    expect(redactSecret(`a=${form}`)).toBe("a=[REDACTED]");
    expect(redactSecret(`raw ${secret}`)).toBe("raw [REDACTED]");
  });

  it("keeps the existing matches: key=value, Bearer, a URL's password, a JWT", () => {
    expect(
      redact(
        "password=hunter22 Bearer abc.def https://u:pw@h/x eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      ),
    ).toBe(
      "password=[REDACTED] Bearer [REDACTED] https://[REDACTED]@h/x [REDACTED]",
    );
  });

  it(`a declared secret under ${MIN_SECRET_LENGTH} characters stays as it is, raw or encoded`, () => {
    const short = "a b/c+d";
    expect(short.length).toBeLessThan(MIN_SECRET_LENGTH);
    expect(textRedactor([short])(`${short} ${encodeURIComponent(short)}`)).toBe(
      `${short} ${encodeURIComponent(short)}`,
    );
  });
});

describe("a synchronous config failure is redacted before provider(config) throws it", () => {
  /** A provider whose sync schema, or whose facet builder, throws with the token in its message. */
  const provider = (
    where: "schema" | "summon",
    error: (token: string) => Error,
  ) =>
    defineComputeProvider<{ apiToken: string }>({
      name: "throwing",
      version: "1.0.0",
      kind: "throwing",
      apiVersion: { ...COMPUTE_PROVIDER_API },
      config: toStandardSchema<{ apiToken: string }, { apiToken: string }>(
        (input) => {
          const config = input as { apiToken: string };
          if (where === "schema") {
            throw error(config.apiToken);
          }
          return { value: config };
        },
      ),
      secrets: ["apiToken"],
      summon: (config) => {
        throw error(config.apiToken);
      },
    });

  /** What `provider(config)` threw. */
  const thrown = (make: () => unknown): Error => {
    try {
      make();
    } catch (error) {
      return error as Error;
    }
    throw new Error("did not throw");
  };

  it("a schema throwing an Error: same class, the secret gone from its message, stack and cause", () => {
    class SchemaError extends Error {}
    const error = thrown(() =>
      provider(
        "schema",
        (token) =>
          new SchemaError(`bad token ${token}`, {
            cause: new Error(`cause ${token}`),
          }),
      )({ apiToken: SECRET }),
    );
    expect(error).toBeInstanceOf(SchemaError);
    expect(error.message).toBe("bad token [REDACTED]");
    expect(error.stack ?? "").not.toContain(SECRET);
    expect((error.cause as Error).message).toBe("cause [REDACTED]");
  });

  it("a schema throwing a ConfigError: still a ConfigError, its message and context redacted", () => {
    const error = thrown(() =>
      provider(
        "schema",
        (token) => new ConfigError(`refused ${token}`, { given: token }),
      )({ apiToken: SECRET }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe("refused [REDACTED]");
    expect(JSON.stringify((error as ConfigError).context)).not.toContain(
      SECRET,
    );
  });

  it("the facet builder throwing, with the validated secret in its message", () => {
    const error = thrown(() =>
      provider(
        "summon",
        (token) => new Error(`cannot build ${token}`),
      )({
        apiToken: SECRET,
      }),
    );
    expect(error.message).toBe("cannot build [REDACTED]");
  });
});

const dir = await makeTmpDir("bun-jobs-provider-redact-ready");
afterAll(dir.cleanup);

describe("an asynchronous config failure: ready rejects with the same redacted copy", () => {
  /** A provider whose async schema rejects with a throttled ProviderError quoting the token. */
  const rejecting = (where: "schema" | "summon") =>
    defineComputeProvider<{ apiToken: string }>({
      name: "rejecting",
      version: "1.0.0",
      kind: "rejecting",
      apiVersion: { ...COMPUTE_PROVIDER_API },
      config: toStandardSchema<{ apiToken: string }, { apiToken: string }>(
        async (input) => {
          const config = input as { apiToken: string };
          await Bun.sleep(1);
          if (where === "schema") {
            throw Object.assign(
              new ProviderError(
                `token ${config.apiToken} refused`,
                "throttled",
                {
                  platformCode: "Throttled",
                  retryAfterMs: 60_000,
                  cause: new Error(`cause ${config.apiToken}`),
                },
              ),
              { given: config.apiToken },
            );
          }
          return { value: config };
        },
      ),
      secrets: ["apiToken"],
      summon: (config) => {
        throw new Error(`cannot build ${config.apiToken}`);
      },
    });

  it("a schema's rejection: no secret in message, stack, cause or fields; still a classifiable ProviderError", async () => {
    const error = (await rejecting("schema")({ apiToken: SECRET }).ready.then(
      () => {
        throw new Error("ready resolved");
      },
      (reason: unknown) => reason,
    )) as ProviderError & { given?: unknown };
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe("token [REDACTED] refused");
    expect(error.stack ?? "").not.toContain(SECRET);
    expect((error.cause as Error).message).toBe("cause [REDACTED]");
    expect(error.given).toBe("[REDACTED]");
    expect(providerErrorFacts(error)).toEqual({
      kind: "throttled",
      code: "PROVIDER_THROTTLED",
      platformCode: "Throttled",
      retryAfterMs: 60_000,
    });
  });

  it("a facet build failing after an async validation: ready rejects redacted", async () => {
    const configured = rejecting("summon")({ apiToken: SECRET });
    await expect(configured.ready).rejects.toThrow("cannot build [REDACTED]");
  });

  it("the controller still classifies it: throttled, its platform code, the platform's wait, nothing logged with the secret", async () => {
    const driver = createDriver({
      type: "file",
      root: join(dir.path, testNamespace("root")),
    });
    await driver.connect();
    const namespace = testNamespace("redact-ready");
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const { logger, events } = createTestLogger();
    const controller = new SummonController({
      logger,
      driver,
      namespace,
      queue: "work",
      summoner: rejecting("schema")({ apiToken: SECRET }),
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
      backoff: { initial: 5, max: 5 },
    });
    try {
      await queue.add("job", {});
      // Throttled is unavailable, not failed: the kind was read off the copy.
      expect(await controller.check()).toMatchObject({
        action: "summoned",
        outcome: "unavailable",
      });
      const status = await controller.status();
      expect(status.last).toMatchObject({
        outcome: "unavailable",
        detail: "Throttled",
      });
      // The platform's 60 s wait, not the 5 ms backoff: the kind was read.
      expect(status.backoffUntil! - Date.now()).toBeGreaterThan(30_000);
      expect(JSON.stringify(events)).not.toContain(SECRET);
    } finally {
      await controller.close();
      await queue.close();
      await driver.purge(namespace);
      await driver.close();
    }
  });
});
