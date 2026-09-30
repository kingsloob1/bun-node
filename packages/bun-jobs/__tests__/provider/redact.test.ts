import type { SummonCapabilities, SummonFacet } from "../../lib/provider/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { isServableFact, toSummonStatusDto } from "../../lib/api/serialize";
import {
  BunQueue,
  createDriver,
  defineSummoner,
  SummonController,
} from "../../lib/index";
import {
  defineComputeProvider,
  toStandardSchema,
} from "../../lib/provider/index";
import { redactingLogger } from "../../lib/provider/redact";
import { DEFAULT_REDACT_KEYS } from "../../lib/runner/redact";
import { isCredentialKey } from "../../lib/shared/credentialKeys";
import { makeTmpDir, testNamespace } from "../helpers";

/**
 * Redaction (plugins §13.3): what a provider logs through its call context
 * has its declared secrets and the usual credential shapes scrubbed, and a
 * `describe()` fact holding a declared secret never reaches the status.
 */

const dir = await makeTmpDir("bun-jobs-provider-redact");
afterAll(dir.cleanup);

const SECRET = "sk-live-0123456789abcdef";
const PASSWORD = "p4ssw0rd-very-secret";

describe("redactingLogger", () => {
  it("replaces declared secrets by value, in messages, fields, nested values and errors", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, [SECRET, "short"]);
    const error = new Error(`auth failed for ${SECRET}`);
    log.info(`calling with ${SECRET}`, {
      header: `x-key ${SECRET}`,
      nested: { list: [SECRET, 1, true], deep: { value: SECRET } },
      error,
      short: "short stays",
    });
    const event = events[0]!;
    const text = JSON.stringify({
      message: event.message,
      fields: event.fields,
      error: event.error?.message,
      stack: event.error?.stack,
    });
    expect(text).not.toContain(SECRET);
    expect(event.message).toBe("calling with [REDACTED]");
    expect(event.fields.nested).toEqual({
      list: ["[REDACTED]", 1, true],
      deep: { value: "[REDACTED]" },
    });
    // A secret under 8 characters is not redacted by value.
    expect(event.fields.short).toBe("short stays");
    // The error keeps its class, loses the secret; the original is untouched.
    expect(event.error).toBeInstanceOf(Error);
    expect(event.error?.message).toBe("auth failed for [REDACTED]");
    expect(error.message).toContain(SECRET);
  });

  it("applies the runner's patterns and sensitive field names with no secrets declared", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    log.warn(
      "GET https://admin:hunter22@db.example/x with Authorization: Bearer abc.def",
      {
        apiToken: "plain-value",
        region: "eu-west-1",
      },
    );
    expect(events[0]!.message).toBe(
      "GET https://admin:[REDACTED]@db.example/x with Authorization: Bearer [REDACTED]",
    );
    expect(events[0]!.fields).toEqual({
      apiToken: "[REDACTED]",
      region: "eu-west-1",
    });
  });

  it("masks a field by its name with the status route's fact rule: whole words or a credential ending", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    const masked = [
      "authToken",
      "apikey",
      "api_key",
      "apiKey",
      "sessiontoken",
      "password",
      "client-secret",
      "DB_PASSWORD",
    ];
    const kept = ["author", "authors", "keyspace", "tokenizerModel", "region"];
    log.info("fields", {
      ...Object.fromEntries(masked.map((key) => [key, "v"])),
      ...Object.fromEntries(kept.map((key) => [key, "v"])),
    });
    const fields = events[0]!.fields;
    for (const key of masked) {
      expect({ key, value: fields[key] }).toEqual({ key, value: "[REDACTED]" });
    }
    for (const key of kept) {
      expect({ key, value: fields[key] }).toEqual({ key, value: "v" });
    }
  });

  it("agrees with the status route's fact filter on every one of those names", () => {
    for (const key of [
      "authToken",
      "apikey",
      "sessiontoken",
      "password",
      "author",
      "keyspace",
      "tokenizerModel",
    ]) {
      expect({ key, credential: isCredentialKey(key) }).toEqual({
        key,
        credential: !isServableFact(key, "v", true),
      });
    }
  });

  it("the old substring rule would mask author (the control)", () => {
    const substring = (key: string) =>
      DEFAULT_REDACT_KEYS.some((word) => key.toLowerCase().includes(word));
    expect(substring("author")).toBe(true);
    expect(isCredentialKey("author")).toBe(false);
  });

  it("redacts a child's bindings and keeps the inner logger's level", () => {
    const { logger, events } = createTestLogger({ level: "info" });
    const log = redactingLogger(logger, [SECRET]).child({ key: SECRET });
    log.debug("dropped");
    log.info(new Error(SECRET));
    expect(events).toHaveLength(1);
    expect(events[0]!.bindings).toEqual({ key: "[REDACTED]" });
    expect(events[0]!.message).toBe("[REDACTED]");
    expect(log.isLevelEnabled("debug")).toBe(false);
  });

  it("fails without the wrapper (the control)", () => {
    const { logger, events } = createTestLogger();
    logger.info(`calling with ${SECRET}`);
    expect(events[0]!.message).toContain(SECRET);
  });
});

describe("a provider's call context, through a controller", () => {
  const CAPABILITIES: SummonCapabilities = {
    style: "launch",
    dedupe: { kind: "none" },
    passes: "argv",
    bootBudgetMs: 20_000,
    shutdown: { signal: "SIGTERM", graceMs: 10_000 },
    maxLifetimeMs: null,
    enforcesLifetime: false,
  };

  interface AcmeConfig {
    region: string;
    apiToken: string;
    database: { password: string };
  }

  const acme = defineComputeProvider({
    name: "test-redact-acme",
    version: "1.0.0",
    kind: "acme",
    apiVersion: { core: "0.1", summon: "0.1" },
    config: toStandardSchema<AcmeConfig>((input) => ({
      value: input as AcmeConfig,
    })),
    secrets: ["apiToken", "database.password", "missing.path"],
    describe: (config) => ({
      region: config.region,
      endpoint: `https://api.example/${config.apiToken}`,
      pass: config.database.password,
    }),
    summon: (config): SummonFacet => ({
      capabilities: CAPABILITIES,
      summon: async (request, context) => {
        context.logger.info(`starting with token ${config.apiToken}`, {
          id: request.id,
          db: `postgres://app:${config.database.password}@db/x`,
          token: config.apiToken,
        });
        context.logger.error(new Error(`refused: ${config.apiToken}`));
        return { status: "started", handles: [] };
      },
    }),
  });

  /** A controller for `summoner` over a fresh file driver, with one job waiting. */
  async function run(summoner: Parameters<typeof toController>[0]) {
    const driver = createDriver({
      type: "file",
      root: join(dir.path, testNamespace("root")),
    });
    await driver.connect();
    const namespace = testNamespace("provider-redact");
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    await queue.add("job", {});
    const { logger, events } = createTestLogger();
    const controller = toController(summoner, driver, namespace, logger);
    const result = await controller.check();
    const status = await controller.status();
    await controller.close();
    await queue.close();
    await driver.purge(namespace);
    await driver.close();
    return { result, status, events };
  }

  function toController(
    summoner: ConstructorParameters<typeof SummonController>[0]["summoner"],
    driver: ConstructorParameters<typeof SummonController>[0]["driver"],
    namespace: string,
    logger: ConstructorParameters<typeof SummonController>[0]["logger"],
  ): SummonController {
    return new SummonController({
      driver,
      namespace,
      queue: "work",
      summoner,
      logger,
      triggers: { onAdd: false, events: false, poll: false },
      cooldown: 0,
    });
  }

  it("redacts the declared secrets from what the facet logs", async () => {
    const { result, events } = await run(
      acme({
        region: "eu",
        apiToken: SECRET,
        database: { password: PASSWORD },
      }),
    );
    expect(result).toMatchObject({ outcome: "started" });
    const logged = events.filter((event) =>
      /starting with token|refused/.test(event.message),
    );
    expect(logged).toHaveLength(2);
    const text = JSON.stringify(
      logged.map((event) => ({
        message: event.message,
        fields: event.fields,
        error: event.error?.message,
        stack: event.error?.stack,
      })),
    );
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PASSWORD);
    expect(logged[0]!.message).toBe("starting with token [REDACTED]");
    expect(logged[0]!.fields.db).toBe("postgres://app:[REDACTED]@db/x");
    // Bound to the attempt, as before.
    expect(logged[0]!.bindings.attempt).toBe(logged[0]!.fields.id);
  });

  it("drops a fact holding a declared secret from status().summoner.facts, and from the DTO", async () => {
    const { status } = await run(
      acme({
        region: "eu",
        apiToken: SECRET,
        database: { password: PASSWORD },
      }),
    );
    expect(status.summoner?.facts).toEqual({ region: "eu" });
    const dto = toSummonStatusDto(status, {
      exposeHosts: true,
      exposeSummonHandles: true,
    });
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    expect(JSON.stringify(dto)).not.toContain(PASSWORD);
  });

  it("leaves a defineSummoner's facts as they were", async () => {
    const { status } = await run(
      defineSummoner({
        kind: "rec",
        describe: () => ({ region: "eu", cluster: "c1" }),
        invoke: async () => {},
      }),
    );
    expect(status.summoner?.facts).toEqual({
      kind: "rec",
      region: "eu",
      cluster: "c1",
    });
  });
});
