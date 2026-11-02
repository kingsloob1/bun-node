/**
 * The logger cut (typed-client plan §10.1): the core asks for a
 * `ContractLogger` or a sink, resolves either on its own, and lets a host
 * package install its own resolution (bun-common installs `resolveLogger`;
 * its suite checks that side, `contract/loggerResolution.test.ts`).
 */
import type {
  ContractLogEvent,
  ContractLogger,
  ContractLoggerLike,
  ContractLoggerResolver,
} from "../lib/logger";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createReceiver, defineTransport, mergeContracts } from "../lib/index";
import {
  defaultLoggerResolver,
  resolveContractLogger,
  setLoggerResolver,
} from "../lib/logger";
import { numeric } from "./schemas";

const t = defineTransport({ name: "t", inbound: { parts: ["data"] } });
const contract = t.contract({ inbound: { data: numeric } });

/** A logger recording every call, message first. */
function recording() {
  const calls: [string, string, Record<string, unknown> | undefined][] = [];
  const logger: ContractLogger = {
    warn: (message, fields) => calls.push(["warn", message, fields]),
    error: (message, fields) => calls.push(["error", message, fields]),
  };
  return { logger, calls };
}

afterEach(() => {
  setLoggerResolver(undefined);
});

describe("the package's own resolution", () => {
  it("writes to the console when no logger is given", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      createReceiver(contract, "inbound", { policy: "warn" })({ data: "x" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe("contract mismatch");
      expect(warn.mock.calls[0][1]).toMatchObject({
        transport: "t",
        side: "inbound",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("calls an object's warn and error with the message first", () => {
    const { logger, calls } = recording();
    const receive = createReceiver(contract, "inbound", {
      policy: "warn",
      logger,
      onIssues: () => {
        throw new Error("hook broke");
      },
    });
    receive({ data: "x" });
    expect(calls.map(([level, message]) => [level, message])).toEqual([
      ["error", "contract onIssues hook failed"],
      ["warn", "contract mismatch"],
    ]);
    expect(calls[0][2]?.error).toBeInstanceOf(Error);
  });

  it("hands a sink each record, the error lifted out of its fields", () => {
    const events: ContractLogEvent[] = [];
    const sink: ContractLoggerLike = (event) => events.push(event);
    createReceiver(contract, "inbound", {
      policy: "warn",
      logger: sink,
      onIssues: () => {
        throw new Error("hook broke");
      },
    })({ data: "x" });
    expect(events.map((e) => [e.level, e.message])).toEqual([
      ["error", "contract onIssues hook failed"],
      ["warn", "contract mismatch"],
    ]);
    expect(events[0].error?.message).toBe("hook broke");
    expect(events[1].error).toBeUndefined();
    expect(events[1]).toMatchObject({
      fields: { transport: "t", side: "inbound" },
      bindings: {},
      time: expect.any(Number),
    });
  });

  it("logs a merge's refinement to the logger given", () => {
    const { logger, calls } = recording();
    mergeContracts(
      [
        { contract, origin: "outer" },
        { contract, origin: "inner" },
      ],
      { logger },
    );
    expect(calls.map(([level, message]) => [level, message])).toEqual([
      ["warn", "contract part refined by an inner layer"],
    ]);
  });

  it("negative control: refuses something that is not a logger, naming what is", () => {
    expect(() =>
      defaultLoggerResolver({ warn: () => {} } as unknown as ContractLogger),
    ).toThrow(/Unrecognised logger/);
    expect(() =>
      defaultLoggerResolver(42 as unknown as ContractLoggerLike),
    ).toThrow(TypeError);
  });

  it('negative control: an "error" policy writes nothing', () => {
    const { logger, calls } = recording();
    void createReceiver(contract, "inbound", { logger })({ data: "x" });
    expect(calls).toEqual([]);
  });
});

describe("an installed resolver", () => {
  it("resolves every logger option, and an absent one", () => {
    const { logger, calls } = recording();
    const seen: (ContractLoggerLike | undefined)[] = [];
    setLoggerResolver((input) => {
      seen.push(input);
      return logger;
    });
    const given = recording().logger;
    createReceiver(contract, "inbound", { policy: "warn" })({ data: "x" });
    createReceiver(contract, "inbound", { policy: "warn", logger: given })({
      data: "x",
    });
    expect(seen).toEqual([undefined, given]);
    expect(calls).toHaveLength(2);
  });

  it("is resolved once per guard, on its first record", () => {
    let resolved = 0;
    const { logger } = recording();
    setLoggerResolver(() => {
      resolved++;
      return logger;
    });
    const receive = createReceiver(contract, "inbound", { policy: "warn" });
    expect(resolved).toBe(0);
    receive({ data: "x" });
    receive({ data: "y" });
    expect(resolved).toBe(1);
  });

  it("returns the one it replaced, and undefined restores the default", () => {
    const first: ContractLoggerResolver = () => recording().logger;
    expect(setLoggerResolver(first)).toBeUndefined();
    expect(setLoggerResolver(undefined)).toBe(first);
    const { logger } = recording();
    expect(resolveContractLogger(logger)).toBe(logger);
  });
});
