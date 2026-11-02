/**
 * The core on its own, with no other package loaded: a transport, a
 * contract, the receiver parsing and the sender checking, the error a
 * failing message becomes, a description and a merge. bun-common's suite
 * (`packages/bun-common/__tests__/contract/`) is the full one, run through
 * its re-export; this shows the package works without it.
 */
import { describe, expect, it } from "bun:test";
import {
  CONTRACT,
  ContractError,
  createReceiver,
  createSender,
  defineTransport,
  describeContract,
  getContract,
  mergeContracts,
  validateStandard,
} from "../lib/index";
import { numeric, shortString } from "./schemas";

const broker = defineTransport({
  name: "broker",
  inbound: { key: "t", parts: ["payload"] },
  outbound: { key: "t", parts: ["payload"] },
});

const contract = broker.contract({
  inbound: { add: { payload: numeric } },
  outbound: { added: { payload: shortString } },
});

describe("the core without bun-common", () => {
  it("parses what a receiver gets", async () => {
    const receive = createReceiver(contract, "inbound");
    expect(await receive({ t: "add", payload: "42" })).toEqual({
      t: "add",
      payload: 42,
    });
  });

  it("returns a ContractError, with the issue located, for a failing message", async () => {
    const receive = createReceiver(contract, "inbound");
    const result = await receive({ t: "add", payload: "forty-two" });
    expect(result).toBeInstanceOf(ContractError);
    expect((result as ContractError).issues).toEqual([
      {
        target: "payload",
        message: "Expected a number",
        path: "",
        key: "add",
      },
    ]);
  });

  it("negative control: an undeclared key is refused on the key field", async () => {
    const receive = createReceiver(contract, "inbound");
    const result = await receive({ t: "remove", payload: 1 });
    expect(result).toBeInstanceOf(ContractError);
    expect((result as ContractError).issues.map((i) => i.target)).toEqual([
      "t",
    ]);
  });

  it("checks what a sender sends, and hands on the very message", async () => {
    const send = createSender(contract, "outbound");
    const message = { t: "added" as const, payload: "ok" };
    expect(await send(message)).toBe(message);
    expect(
      await send({ t: "added", payload: "far too long a string" }),
    ).toBeInstanceOf(ContractError);
  });

  it("validates one value against a schema", async () => {
    expect(await validateStandard(numeric, "7", "body")).toEqual({
      ok: true,
      value: 7,
    });
  });

  it("describes and merges contracts", () => {
    expect(
      describeContract(contract).entries.map((e) => [e.side, e.key, e.part]),
    ).toEqual([
      ["inbound", "add", "payload"],
      ["outbound", "added", "payload"],
    ]);
    const merged = mergeContracts([
      { contract, origin: "outer" },
      { contract: broker.contract({}), origin: "inner" },
    ]);
    expect(describeContract(merged).entries).toHaveLength(2);
  });

  it("carries a contract under the shared symbol", () => {
    const carrier = {};
    Object.defineProperty(carrier, CONTRACT, { value: contract });
    expect<symbol>(CONTRACT).toBe(Symbol.for("bun-validate.contract"));
    expect(getContract(carrier)).toBe(contract);
  });
});
