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
      "GET https://[REDACTED]@db.example/x with Authorization: Bearer [REDACTED]",
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

  it("replaces a URL's userinfo whole, a token alone included", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    log.info(
      "clone https://ghp_abcdef0123456789@github.com/x and report to https://0123abcd@o1.ingest.sentry.io/42",
    );
    expect(events[0]!.message).toBe(
      "clone https://[REDACTED]@github.com/x and report to https://[REDACTED]@o1.ingest.sentry.io/42",
    );
  });

  it("converts URL, Headers, URLSearchParams, Map, Set and class instances before walking them", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    class Settings {
      apiKey = "class-secret-value";
      region = "eu";
    }
    log.info("objects", {
      url: new URL("https://admin:url-password@db.example/x"),
      headers: new Headers({ authorization: "Bearer abc", accept: "json" }),
      query: new URLSearchParams({ token: "q-secret", page: "2" }),
      map: new Map<unknown, unknown>([
        ["password", "map-secret"],
        ["region", "eu"],
      ]),
      set: new Set(["https://tok@host.example/"]),
      settings: new Settings(),
      at: new Date(0),
    });
    const fields = events[0]!.fields;
    expect(fields.url).toBe("https://[REDACTED]@db.example/x");
    expect(fields.headers).toEqual({
      authorization: "[REDACTED]",
      accept: "json",
    });
    expect(fields.query).toEqual({ token: "[REDACTED]", page: "2" });
    expect(fields.map).toEqual({ password: "[REDACTED]", region: "eu" });
    expect(fields.set).toEqual(["https://[REDACTED]@host.example/"]);
    expect(fields.settings).toEqual({ apiKey: "[REDACTED]", region: "eu" });
    expect(fields.at).toEqual(new Date(0));
    expect(JSON.stringify(fields)).not.toMatch(
      /url-password|map-secret|q-secret|class-secret/,
    );
  });

  it("applies the name rule to an error's own fields", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    const error = Object.assign(new Error("refused"), {
      apiKey: "err-secret-value",
      status: 403,
    });
    log.error("call failed", { error });
    const logged = events[0]!.error as Error & Record<string, unknown>;
    expect(logged.apiKey).toBe("[REDACTED]");
    expect(logged.status).toBe(403);
    expect(logged.message).toBe("refused");
  });

  it("replaces whatever lies deeper than the walk goes, rather than passing it through", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    let deep: Record<string, unknown> = { note: "the bottom" };
    for (let i = 0; i < 12; i++) {
      deep = { next: deep };
    }
    log.info("deep", { deep });
    const text = JSON.stringify(events[0]!.fields);
    expect(text).not.toContain("the bottom");
    expect(text).toContain("[REDACTED]");
  });

  it("keeps a cyclic class instance or Map small: each cycle is cut once (round 4 #4)", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    class Node {
      token = "t";
      a: unknown = this;
      b: unknown = this;
      c: unknown = this;
      d: unknown = this;
      e: unknown = this;
      f: unknown = this;
      g: unknown = this;
    }
    const map = new Map<string, unknown>([["password", "p"]]);
    map.set("self", map);
    map.set("again", map);
    const plain: Record<string, unknown> = { region: "eu" };
    plain.self = plain;
    const shared = { region: "eu" };
    log.info("cyclic", {
      node: new Node(),
      map,
      plain,
      pair: [shared, shared],
    });
    // Serialisable: every cycle is cut, a shared (acyclic) object is not.
    const size = JSON.stringify(events[0]!.fields).length;
    expect((events[0]!.fields.plain as Record<string, unknown>).self).toBe(
      "[Circular]",
    );
    expect(events[0]!.fields.pair).toEqual([
      { region: "eu" },
      { region: "eu" },
    ]);
    expect(size).toBeLessThan(2_000);
    expect(JSON.stringify(events[0]!.fields)).not.toMatch(/"t"|"p"/);
  });

  it("never throws: a throwing getter, a revoked proxy (round 4 #4)", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, []);
    class Throwing {
      region = "eu";
      get broken(): string {
        throw new Error("getter");
      }
    }
    const instance = new Throwing();
    Object.defineProperty(instance, "own", {
      enumerable: true,
      get: () => {
        throw new Error("own getter");
      },
    });
    const plain = {
      region: "eu",
      get secret(): string {
        throw new Error("plain getter");
      },
    };
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() =>
      log.info("odd", { instance, plain, proxy, list: [proxy] }),
    ).not.toThrow();
    const fields = events[0]!.fields as Record<string, unknown> & {
      instance: Record<string, unknown>;
      plain: Record<string, unknown>;
    };
    expect(fields.instance.region).toBe("eu");
    expect(fields.instance.own).toBe("[Unreadable]");
    expect(fields.plain.secret).toBe("[REDACTED]");
    expect(fields.plain.region).toBe("eu");
    expect(fields.proxy).toBe("[Unreadable]");
  });

  it("redacts an error's getter-only own field (round 4 #4 nit)", () => {
    const { logger, events } = createTestLogger();
    const log = redactingLogger(logger, [SECRET]);
    const error = new Error("refused");
    Object.defineProperty(error, "detail", {
      enumerable: true,
      get: () => `with ${SECRET}`,
    });
    Object.defineProperty(error, "secret", {
      enumerable: true,
      get: () => "getter-secret",
    });
    log.error("failed", { error });
    const logged = events[0]!.error as Error & Record<string, unknown>;
    expect(logged.detail).toBe("with [REDACTED]");
    expect(logged.secret).toBe("[REDACTED]");
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
    expect(logged[0]!.fields.db).toBe("postgres://[REDACTED]@db/x");
    // Bound to the attempt, as before.
    expect(logged[0]!.bindings.attempt).toBe(logged[0]!.fields.id);
  });

  it("redacts a thrown provider error, its message and its cause, from the controller's own logs (round 4 #6)", async () => {
    const leaky = defineComputeProvider({
      name: "test-redact-throw",
      version: "1.0.0",
      kind: "leaky",
      apiVersion: { core: "0.1", summon: "0.1" },
      config: toStandardSchema<{ token: string }>((input) => ({
        value: input as { token: string },
      })),
      secrets: ["token"],
      summon: (config): SummonFacet => ({
        capabilities: CAPABILITIES,
        summon: async () => {
          throw new Error(`denied for ${config.token}`, {
            cause: new Error(`token ${config.token} expired`),
          });
        },
      }),
    });
    const { result, status, events } = await run(leaky({ token: SECRET }));
    expect(result).toMatchObject({ outcome: "failed" });
    const failed = events.find(
      (event) => event.message === "summoner call failed",
    );
    expect(failed).toBeDefined();
    expect(failed!.error?.message).toBe("denied for [REDACTED]");
    expect((failed!.error?.cause as Error).message).toBe(
      "token [REDACTED] expired",
    );
    const text = JSON.stringify(
      events.map((event) => ({
        message: event.message,
        fields: event.fields,
        error: event.error?.message,
        stack: event.error?.stack,
        cause: (event.error?.cause as Error | undefined)?.message,
        causeStack: (event.error?.cause as Error | undefined)?.stack,
      })),
    );
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain(SECRET);
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
