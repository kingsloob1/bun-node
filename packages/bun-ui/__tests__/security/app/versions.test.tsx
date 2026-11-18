/**
 * The versions screen (PR-U4, ui.md §3): a scope's history, any two
 * compared, one compared with the published head, and a rollback through
 * the publish dialog (at the head read; a `409` when someone published
 * since; absent without `policy:publish`). Over the real app and a fake.
 */
import type { MockCall } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { editorApi } from "./policiesApi";
import { renderApp } from "./renderApp";

setupDom();

/** The history: the head (3) and two before it. */
const HISTORY = [
  { id: "pv_3", number: 3, message: "tighten" },
  { id: "pv_2", number: 2 },
  { id: "pv_1", number: 1, message: "first" },
];

/** The diffs asked for. */
function diffs(calls: readonly MockCall[]): string[] {
  return calls
    .filter((call) => call.path.endsWith("/diff"))
    .map((call) => `${call.query.get("from")}→${call.query.get("to")}`);
}

/** Opens the versions of global over the fake and `extra` routes. */
async function openVersions(extra = {}) {
  const fake = editorApi({ rest: {}, versions: HISTORY });
  const rendered = renderApp({
    path: "/policies/versions?scope=global",
    routes: { ...fake.routes, ...extra },
  });
  await page().findAllByTestId("version-row", {}, LOADED);
  return { ...rendered, ...fake };
}

describe("versions", () => {
  it("lists the history newest first, the published one marked", async () => {
    await openVersions();
    const rows = page().getAllByTestId("version-row");
    expect(
      rows.map((row) => row.querySelectorAll("td")[1]?.textContent),
    ).toEqual(["3 published", "2", "1"]);
  });

  it("compares any two ticked, and one with the published head", async () => {
    const { api } = await openVersions({
      "GET /policies/:scope/diff": {
        body: {
          from: "pv_1",
          to: "pv_2",
          changes: [{ path: "mode", before: "enforce", after: "dryRun" }],
        },
      },
    });
    fireEvent.click(page().getByTestId("version-pick-1"));
    expectAbsent(
      page().queryByTestId("versions-diff"),
      "a diff of one version",
    );
    fireEvent.click(page().getByTestId("version-pick-2"));
    const diff = await page().findByTestId("versions-diff", {}, LOADED);
    expect(diff.textContent).toBe('mode: "enforce" → "dryRun"');
    expect(diffs(api.calls)).toEqual(["pv_1→pv_2"]);
    fireEvent.click(page().getByTestId("version-vs-head-1"));
    await waitFor(() =>
      expect(diffs(api.calls)).toEqual(["pv_1→pv_2", "pv_1→pv_3"]),
    );
  });

  it("rolls back to a version at the head read, through the dialog", async () => {
    const { api } = await openVersions();
    fireEvent.click(page().getByTestId("version-rollback-1"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    expect(dialog.textContent).toContain("Roll Global back to version 1?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
    await page().findByText("Rolled back: published version 4", {}, LOADED);
    expect(
      api.calls
        .filter((call) => call.path.endsWith("/rollback"))
        .map((call) => call.body),
    ).toEqual([{ expectedHead: "pv_3", versionId: "pv_1" }]);
    // No publish of the draft was made.
    expect(api.calls.some((call) => call.path.endsWith("/publish"))).toBe(
      false,
    );
  });

  it("a rollback someone's publish went before is a 409, shown with a reload", async () => {
    await openVersions({
      "POST /policies/:scope/rollback": problem(409, "conflict"),
    });
    fireEvent.click(page().getByTestId("version-rollback-2"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));
    await page().findByTestId("versions-conflict", {}, LOADED);
  });

  it("without policy:publish there is no rollback", async () => {
    await openVersions({
      "GET /meta/permissions": defaultRoutes({
        permissions: { global: { "policy:read": true } },
      })["GET /meta/permissions"],
    });
    expectAbsent(page().queryByTestId("version-rollback-1"), "Roll back");
    page().getByTestId("version-vs-head-1");
  });
});
