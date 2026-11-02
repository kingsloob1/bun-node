/**
 * The logger cut, bun-common's side (typed-client plan PR-K): bun-contract
 * asks for a minimal logger, and bun-common's contract entry installs its
 * own `resolveLogger` as the resolution, so a guard's or a merge's `logger`
 * option means what it did before the core moved out. The package's own
 * resolution is tested in `packages/bun-contract/__tests__/logger.test.ts`.
 */
import type { ContractLoggerLike } from "../../lib/contract/index";
import type { LogEvent, PinoLike } from "../../lib/logging";
import { describe, expect, it } from "bun:test";
import {
  createReceiver,
  defineTransport,
  mergeContracts,
} from "../../lib/contract/index";
import {
  resolveContractLogger,
  setLoggerResolver,
} from "../../lib/contract/logger";
import { createTestLogger, isLogger } from "../../lib/logging";

const t = defineTransport({ name: "t", inbound: { parts: ["data"] } });
const failing = {
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: () => ({ issues: [{ message: "Rejected", path: [] }] }),
  },
};
const contract = t.contract({ inbound: { data: failing } });

/** A pino logger as far as `resolveLogger` detects one: it takes its fields first. */
function pinoLike() {
  const calls: [string, ...unknown[]][] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push([level, ...args]);
  const pino: PinoLike = {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    child: () => pino,
    level: "info",
  };
  return { pino, calls };
}

describe("bun-common's resolution of a contract logger option", () => {
  it("adapts pino: its fields first, then the message", () => {
    const { pino, calls } = pinoLike();
    void createReceiver(contract, "inbound", {
      policy: "warn",
      logger: pino,
    })({ data: 1 });
    expect(calls).toHaveLength(1);
    const [level, fields, message] = calls[0];
    expect(level).toBe("warn");
    expect(fields).toMatchObject({ transport: "t", side: "inbound" });
    expect(message).toBe("contract mismatch");
  });

  it("gives a LogSink bun-common's full record", () => {
    const events: LogEvent[] = [];
    void createReceiver(contract, "inbound", {
      policy: "warn",
      logger: (event: LogEvent) => events.push(event),
    })({ data: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      message: "contract mismatch",
      bindings: {},
    });
  });

  it("logs a merge's refinement to a bun-common Logger", () => {
    const { logger, events } = createTestLogger();
    mergeContracts(
      [
        { contract, origin: "outer" },
        { contract, origin: "inner" },
      ],
      { logger },
    );
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ["warn", "contract part refined by an inner layer"],
    ]);
  });

  it("defaults to bun-common's console logger", () => {
    expect(isLogger(resolveContractLogger(undefined))).toBe(true);
  });

  it("takes a bare ContractLogger, which resolveLogger alone refuses", () => {
    const seen: string[] = [];
    const bare: ContractLoggerLike = {
      warn: (message) => seen.push(`warn ${message}`),
      error: (message) => seen.push(`error ${message}`),
    };
    void createReceiver(contract, "inbound", { policy: "warn", logger: bare })({
      data: 1,
    });
    expect(seen).toEqual(["warn contract mismatch"]);
  });

  it("still refuses what is no logger, with resolveLogger's message", () => {
    expect(() =>
      resolveContractLogger({
        warn: () => {},
      } as unknown as ContractLoggerLike),
    ).toThrow(/Unrecognised logger.*pino/);
  });

  it("negative control: without bun-common's resolver, pino is called message first", () => {
    const installed = setLoggerResolver(undefined);
    try {
      expect(installed).toBeDefined();
      const { pino, calls } = pinoLike();
      void createReceiver(contract, "inbound", {
        policy: "warn",
        logger: pino,
      })({ data: 1 });
      expect(calls[0][1]).toBe("contract mismatch");
    } finally {
      setLoggerResolver(installed);
    }
  });
});
