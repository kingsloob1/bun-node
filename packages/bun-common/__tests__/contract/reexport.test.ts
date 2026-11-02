/**
 * bun-common re-exports `@kingsleyweb/bun-contract` unchanged (typed-client
 * plan PR-K, §10.2): its `./contract` entry, every `lib/contract/<module>`
 * path and the root's contract names are the package's very objects, so a
 * contract, guard or symbol from one is the other's. The types are pinned in
 * `contractLogger.type-test.ts`.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "bun:test";
import * as contract from "@kingsleyweb/bun-contract";
import * as common from "../../lib/contract/index";
import * as root from "../../lib/index";

const SHIMS = join(import.meta.dir, "../../lib/contract");

/**
 * How `ours` differs from `theirs`: names missing from it, and names whose
 * value is a different object. Empty when it re-exports `theirs` unchanged.
 */
function differences(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
  names: readonly string[] = Object.keys(theirs),
): string[] {
  return names.flatMap((name) =>
    !(name in ours)
      ? [`missing ${name}`]
      : ours[name] !== theirs[name]
        ? [`copied ${name}`]
        : [],
  );
}

describe("the re-export", () => {
  it("./contract is the package's root, name for name and object for object", () => {
    expect(Object.keys(common).sort()).toEqual(Object.keys(contract).sort());
    expect(differences(common, contract)).toEqual([]);
  });

  it("the root's contract names are the package's objects", () => {
    const names = [
      "attachContract",
      "CONTRACT",
      "ContractError",
      "createReceiver",
      "createSender",
      "defineTransport",
      "describeContract",
      "documented",
      "forwardContract",
      "getContract",
      "mergeContracts",
      "recordOf",
      "validateStandard",
    ];
    expect(differences(root, contract, names)).toEqual([]);
  });

  it("every lib/contract/<module> path re-exports the package's module of that name", async () => {
    const modules = readdirSync(SHIMS)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => basename(file, ".ts"))
      .filter((name) => name !== "index");
    expect(modules.length).toBeGreaterThanOrEqual(12);
    for (const name of modules) {
      const ours = (await import(join(SHIMS, `${name}.ts`))) as Record<
        string,
        unknown
      >;
      const theirs = (await import(
        `@kingsleyweb/bun-contract/lib/${name}`
      )) as Record<string, unknown>;
      expect({ name, diff: differences(ours, theirs) }).toEqual({
        name,
        diff: [],
      });
    }
  });

  it("negative control: a copy, or a missing name, is caught", () => {
    const copy = { ...contract, createReceiver: () => undefined };
    expect(differences(copy, contract)).toEqual(["copied createReceiver"]);
    const { mergeContracts: _gone, ...short } = contract;
    expect(differences(short, contract)).toEqual(["missing mergeContracts"]);
  });
});
