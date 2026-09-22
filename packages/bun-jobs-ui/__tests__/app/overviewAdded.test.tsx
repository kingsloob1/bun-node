import type { AddedByStateDto, MetaDto } from "../../app/api/types";
import type { RecordedCall } from "./mockFetch";
import { describe, expect, it } from "bun:test";
import { formatNumber } from "../../app/format";
import { page, setupDom, visit, waitFor, within } from "./dom";
import { metaFixture, problem } from "./fixtures";
import { renderApp } from "./renderApp";

setupDom();

/**
 * The Overview's "Over the range" tile, second group: the jobs added in the
 * range by the state they are in now (`GET /overview/added`). The runtime does
 * not serve the route yet and the shared meta has `features.addedByState`
 * off, so every test here that expects the group turns the flag on itself,
 * against mocked HTTP.
 */

/** `/meta` with `features.addedByState` on or off, and analytics as given. */
function meta(
  addedByState: boolean,
  analytics?: MetaDto["analytics"],
): MetaDto {
  const base = metaFixture();
  return metaFixture({
    features: { ...base.features, addedByState },
    ...(analytics === undefined ? {} : { analytics }),
  });
}

/** One `GET /overview/added` answer. */
function added(overrides: Partial<AddedByStateDto> = {}): AddedByStateDto {
  return {
    from: 0,
    to: 3_600_000,
    at: 3_600_000,
    counts: {
      waiting: 11,
      delayed: 5,
      active: 2,
      completed: 1_300,
      failed: 4,
      dead: 3,
      "waiting-children": 1,
    },
    total: 1_326,
    queues: 2,
    ...overrides,
  };
}

/** The `/overview/added` reads among `calls`. */
function addedReads(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.path === "/overview/added");
}

/** The tile, once the analytics series has filled it. */
async function tile(): Promise<HTMLElement> {
  const found = await page().findByTestId("range-stat");
  await waitFor(() => expect(found.textContent).toContain("Failed attempts"));
  return found;
}

describe("the Over the range tile's added-by-state group", () => {
  it("requests nothing and shows no group while the flag is false", async () => {
    const { calls } = renderApp({
      handlers: { "GET /meta": { body: meta(false) } },
    });
    const stat = await tile();
    // Let the rest of the page load too, then look at every request it made.
    await page().findByTestId("jobs-series");
    await page().findByTestId("queue-row-emails");
    expect(addedReads(calls)).toHaveLength(0);
    expect(within(stat).queryByTestId("range-stat-added")).toBeNull();
    expect(stat.textContent).not.toContain("Added in range");
    expect(stat.textContent).not.toContain("Retrying");
    // Group 1 alone, unlabelled, as before.
    expect(stat.textContent).not.toContain("Finished in range");
    expect(stat.textContent).toContain(`Completed${formatNumber(42)}`);
  });

  it("the shared meta fixture keeps the flag off", async () => {
    const { calls } = renderApp();
    await tile();
    await page().findByTestId("queue-row-emails");
    expect(metaFixture().features.addedByState).toBe(false);
    expect(addedReads(calls)).toHaveLength(0);
  });

  it("reads the range on screen and shows every state apart from the finished figures", async () => {
    const before = Date.now();
    const { calls } = renderApp({
      handlers: {
        "GET /meta": { body: meta(true) },
        "GET /overview/added": { body: added() },
      },
    });
    const stat = await tile();
    const group = await within(stat).findByTestId("range-stat-added");
    await waitFor(() => expect(group.textContent).toContain("Total"));
    const after = Date.now();

    // Over the page's range (the last hour by default), as from/to only.
    const [read] = addedReads(calls);
    expect([...read!.query.keys()]).toEqual(["from", "to"]);
    const from = Number(read!.query.get("from"));
    const to = Number(read!.query.get("to"));
    expect(to - from).toBe(3_600_000);
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);

    // Two labelled groups, never one list.
    expect(stat.textContent).toContain("Finished in range");
    expect(group.textContent).toContain(
      "Added in range, where they are now (still stored)",
    );
    const text = group.textContent ?? "";
    for (const [label, value] of [
      ["Waiting", 11],
      ["Delayed", 5],
      ["Active", 2],
      ["Completed", 1_300],
      ["Retrying", 4],
      ["Dead", 3],
      ["Waiting children", 1],
      ["Total", 1_326],
    ] as const) {
      expect(text).toContain(`${label}${formatNumber(value)}`);
    }
    // The `failed` state is "Retrying" here as everywhere (STATE_LABELS):
    // no "Failed" left to be read as the "Failed attempts" figure above.
    expect(text).not.toContain("Failed");
    const counts = page().getByTestId("state-counts").textContent ?? "";
    expect(counts).toContain("Retrying");
    expect(counts).not.toContain("Failed");
    // The honesty line: creation time, not finish time; still stored only.
    expect(text).toContain("added, not finished");
    expect(text).toContain("remove finished jobs");
    // Compact: nothing in the headline font.
    expect(stat.querySelector(".stat-value")).toBeNull();
  });

  it("shows the group even where no analytics are recorded", async () => {
    const { calls } = renderApp({
      handlers: {
        "GET /meta": { body: meta(true, null) },
        "GET /overview/added": { body: added() },
      },
    });
    const group = await page().findByTestId("range-stat-added");
    await waitFor(() => expect(group.textContent).toContain("Retrying4"));
    const stat = page().getByTestId("range-stat");
    expect(stat.textContent).not.toContain("Failed attempts");
    expect(calls.some((call) => call.path === "/analytics/jobs")).toBe(false);
  });

  it("says so in the tile when the read fails, and leaves the rest alone", async () => {
    renderApp({
      handlers: {
        "GET /meta": { body: meta(true) },
        "GET /overview/added": {
          status: 400,
          body: problem(400, "INVALID_ARGUMENT", "no"),
        },
      },
    });
    const group = await page().findByTestId("range-stat-added");
    await waitFor(() => expect(group.textContent).toContain("Could not load"));
    expect(page().getByTestId("range-stat").textContent).toContain(
      "Failed attempts",
    );
  });

  it("follows a section's own range", async () => {
    visit("/jobs/?rangeScope=section&jobsRange=600s");
    const { calls } = renderApp({
      handlers: {
        "GET /meta": { body: meta(true) },
        "GET /overview/added": { body: added() },
      },
    });
    await page().findByTestId("range-stat-added");
    await waitFor(() => expect(addedReads(calls).length).toBeGreaterThan(0));
    const [read] = addedReads(calls);
    expect(
      Number(read!.query.get("to")) - Number(read!.query.get("from")),
    ).toBe(600_000);
  });
});
