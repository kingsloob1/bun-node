import { readFileSync } from "node:fs";
/**
 * The management API's reference tables in the README, pinned to the code
 * they describe: the routes, the actions, the error codes and the feature
 * flags. Each drifted before: ten routes, seven actions, ten error codes and
 * a feature flag were missing when the tables were last checked by hand. A
 * row added to the code now fails here until the README says so, and a row
 * the code no longer has fails too.
 */
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import {
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
} from "../../lib/api/contract/constants";
import { createJobsApi } from "../../lib/api/createJobsApi";
import { API_ERROR_STATUS } from "../../lib/api/errors";
import { FEATURE_ROUTES } from "../../lib/api/routes/meta";
import { MemoryDriver } from "../../lib/index";
import { jobsContext, openContexts } from "./fixtures";

/** The README, read once. */
const README = readFileSync(
  new URL("../../README.md", import.meta.url),
  "utf8",
);

/** The rows of the first table after `heading`, as trimmed cells, header and divider dropped. */
function tableAfter(heading: string): string[][] {
  const start = README.indexOf(`\n${heading}\n`);
  expect(start).toBeGreaterThan(-1);
  const lines = README.slice(start + heading.length + 2).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

/**
 * Feature flags in the code that the README's table does not list yet: for a
 * flag that enters the contract ahead of its runtime, when the README is
 * written with the runtime. Empty now. Remove an entry in the change that adds
 * its row: the test below fails once the row exists, so this cannot go stale.
 */
const UNDOCUMENTED_FEATURES: ReadonlySet<string> = new Set<string>([]);

/** A cell's code-spanned text, backticks removed. */
function code(cell: string): string {
  return cell.replace(/^`|`$/g, "");
}

afterAll(async () => {
  await Promise.all(openContexts.map((jobs) => jobs.close()));
});

describe("the README's management API tables", () => {
  it("lists exactly the routes a full API registers, each with its action and kind", () => {
    const api = createJobsApi({
      jobs: jobsContext("readme-tables-routes", new MemoryDriver()),
      basePath: "/b",
      actions: [...JOBS_API_ACTIONS],
      authorize: () => true,
      logger: noopLogger,
    });
    const registered = api.routes
      .map(
        (route) =>
          `${route.method} ${route.path.slice("/b".length)} ${route.action} ${
            JOBS_API_MUTATIONS.has(route.action) ? "yes" : "no"
          }`,
      )
      .sort();
    const documented = tableAfter("### Routes")
      .map(
        ([method, path, action, mutation]) =>
          `${method} ${code(path!)} ${code(action!)} ${mutation}`,
      )
      .sort();
    expect(documented).toEqual(registered);
  });

  it("lists every action, with its kind and whether it is off by default", () => {
    const documented = tableAfter("### Authorization")
      .map(([action, kind, note]) => `${code(action!)} ${kind} ${note ?? ""}`)
      .sort();
    const actual = JOBS_API_ACTIONS.map(
      (action) =>
        `${action} ${JOBS_API_MUTATIONS.has(action) ? "mutation" : "read"} ${
          JOBS_API_OPT_IN_ACTIONS.has(action) ? "off by default" : ""
        }`,
    ).sort();
    expect(documented).toEqual(actual);
  });

  it("lists every error code the API answers with, at its status", () => {
    // Two codes per row, side by side.
    const documented = tableAfter("### Errors")
      .flatMap(([a, aStatus, , b, bStatus]) => [
        [a, aStatus],
        [b, bStatus],
      ])
      .filter(([name]) => name)
      .map(([name, status]) => `${code(name!)} ${status}`)
      .sort();
    const actual = Object.entries(API_ERROR_STATUS)
      .map(([name, status]) => `${name} ${status}`)
      .sort();
    expect(documented).toEqual(actual);
  });

  it("lists every feature flag", () => {
    const documented = tableAfter("### Features that need driver support")
      .map(([feature]) => code(feature!))
      .sort();
    expect(documented).toEqual(
      Object.keys(FEATURE_ROUTES)
        .filter((feature) => !UNDOCUMENTED_FEATURES.has(feature))
        .sort(),
    );
  });

  it("documents no flag still waived as undocumented (delete the waiver once it is)", () => {
    const documented = new Set(
      tableAfter("### Features that need driver support").map(([feature]) =>
        code(feature!),
      ),
    );
    for (const feature of UNDOCUMENTED_FEATURES) {
      expect({ feature, inCode: feature in FEATURE_ROUTES }).toEqual({
        feature,
        inCode: true,
      });
      expect({ feature, documented: documented.has(feature) }).toEqual({
        feature,
        documented: false,
      });
    }
  });
});
