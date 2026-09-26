import type {
  WorkerDto,
  WorkerSummonProvenanceDto,
} from "../../../app/api/types";
import type { SummonMode } from "../../../app/screens/workers/summon";
import { describe, expect, it } from "bun:test";
import { page, setupDom, visit, within } from "../dom";
import { renderApp } from "../renderApp";
import { workerFixture } from "./fixtures";

setupDom();

/**
 * Where a summoned worker came from (`WorkerDto.summon`): the badge every
 * worker table shows in the State cell, and the worker page's Summoned card.
 *
 * The rules both must keep: **absent says nothing** (no badge, no row, no
 * card, never "not summoned"); the mode and deadline are **what the summoner
 * requested**, labelled so and never defaulted; a mode this build does not
 * know is shown as its raw string; the handle only when the API sends it.
 */

/** A deadline an hour ahead, as a whole epoch ms. */
const DEADLINE = Math.floor(Date.now() / 1_000) * 1_000 + 3_600_000;

/** A `summon` as the API sends it. */
function summon(
  rest: Partial<WorkerSummonProvenanceDto> = {},
): WorkerSummonProvenanceDto {
  return { id: "sum-7f3a", ...rest };
}

/**
 * A mode no build of the contract lists yet, as a later server might send.
 * The contract's type cannot name it, which is the point.
 */
const FUTURE_MODE = "on-demand" as SummonMode;

/** Opens `/workers` listing `items`, and resolves the list. */
async function openList(items: WorkerDto[]) {
  visit("/jobs/workers");
  renderApp({ handlers: { "GET /workers": { body: { items } } } });
  return page().findByTestId("workers-list");
}

/** Opens the page of key `api.emails` with `items` as its live instances, once its Target card is in. */
async function openWorkerPage(items: WorkerDto[]) {
  visit("/jobs/workers/emails/api.emails");
  renderApp({
    handlers: {
      "GET /workers": ({ query }) => ({
        body: {
          items: items.filter(
            (worker) =>
              !query.has("key") ||
              query.getAll("key").includes(worker.key ?? ""),
          ),
          ...(query.get("includeOffline") === "true" ? { offline: [] } : {}),
        },
      }),
    },
  });
  await page().findByTestId("worker-screen");
  // The Target card renders with the instances; the Summoned card beside it.
  await page().findByTestId("worker-target");
  return page().queryByTestId("worker-summon");
}

/** The summon badge of a row, or `null` when it shows none. */
function badgeOf(root: HTMLElement, id: string): HTMLElement | null {
  return within(within(root).getByTestId(`worker-row-${id}`)).queryByTestId(
    "worker-summon-badge",
  );
}

/** The header cells of a table, as text. */
function headers(root: HTMLElement): (string | null)[] {
  return within(root)
    .getAllByRole("columnheader")
    .map((cell) => cell.textContent);
}

describe("the summon badge in a worker table", () => {
  it("names the summoner, and its tooltip gives the attempt and what was requested, as requests", async () => {
    const list = await openList([
      workerFixture({
        id: "w-ecs",
        summon: summon({
          kind: "ecs",
          mode: "exit-on-idle",
          deadlineAt: DEADLINE,
        }),
      }),
    ]);
    await within(list).findByTestId("worker-row-w-ecs");
    const badge = badgeOf(list, "w-ecs")!;
    expect(badge.textContent).toBe("Summoned by ecs");
    expect(badge.title).toContain("attempt sum-7f3a");
    expect(badge.title).toContain("requested mode: Exit when idle");
    expect(badge.title).toContain(
      `requested deadline: ${new Date(DEADLINE).toISOString()}`,
    );
    expect(badge.title).toContain("not a setting");
    // It sits in the State cell, last, and the state is still the state.
    const cell = badge.closest("td")!;
    expect([...cell.querySelectorAll(".badge")].at(-1)).toBe(badge);
    expect(within(cell).getByTestId("worker-state").textContent).toBe(
      "Running",
    );
  });

  it("says only Summoned when the summoner gave no kind, and claims no request it did not make", async () => {
    const list = await openList([
      workerFixture({ id: "w-bare", summon: summon() }),
    ]);
    await within(list).findByTestId("worker-row-w-bare");
    const badge = badgeOf(list, "w-bare")!;
    expect(badge.textContent).toBe("Summoned");
    expect(badge.title).toContain("attempt sum-7f3a");
    expect(badge.title).not.toContain("requested");
  });

  it("shows no badge at all for a worker that reports no summon, and never says it was not summoned", async () => {
    const list = await openList([
      workerFixture({ id: "w-plain" }),
      workerFixture({ id: "w-summoned", summon: summon({ kind: "fly" }) }),
    ]);
    await within(list).findByTestId("worker-row-w-plain");
    expect(badgeOf(list, "w-plain")).toBeNull();
    const row = within(list).getByTestId("worker-row-w-plain");
    expect(row.textContent).not.toMatch(/summon/i);
    // No column was added for it.
    expect(headers(row.closest("table")!)).not.toContain("Summoned");
    // The summoned worker beside it still says so.
    expect(badgeOf(list, "w-summoned")!.textContent).toBe("Summoned by fly");
  });

  it("gives a mode this build does not know as its raw string", async () => {
    const list = await openList([
      workerFixture({ id: "w-future", summon: summon({ mode: FUTURE_MODE }) }),
    ]);
    await within(list).findByTestId("worker-row-w-future");
    expect(badgeOf(list, "w-future")!.title).toContain(
      "requested mode: on-demand",
    );
  });

  it("appears in a worker page's Instances table too", async () => {
    await openWorkerPage([
      workerFixture({ id: "api.emails.a1", summon: summon({ kind: "ecs" }) }),
    ]);
    const instances = page().getByTestId("worker-instances");
    expect(badgeOf(instances, "api.emails.a1")!.textContent).toBe(
      "Summoned by ecs",
    );
  });
});

describe("the worker page's Summoned card", () => {
  it("is absent when no instance reports a summon", async () => {
    const card = await openWorkerPage([
      workerFixture({ id: "api.emails.a1" }),
      workerFixture({ id: "api.emails.b2" }),
    ]);
    expect(card).toBeNull();
    expect(page().getByTestId("worker-screen").textContent).not.toContain(
      "Summoned",
    );
  });

  it("lists a summoned instance with its attempt, summoner, and the mode and deadline it was requested", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({
          kind: "ecs",
          mode: "until-stopped",
          deadlineAt: DEADLINE,
        }),
      }),
    ]))!;
    expect(headers(card)).toEqual([
      "Instance",
      "Summon",
      "Summoner",
      "Requested mode",
      "Requested deadline",
    ]);
    const row = within(card).getByTestId("worker-summon-row-api.emails.a1");
    const cells = [...row.children].map((cell) => cell.textContent);
    expect(cells.slice(0, 4)).toEqual([
      "api.emails.a1",
      "sum-7f3a",
      "ecs",
      "Run until stopped",
    ]);
    // The mode's meaning is on hover, and it says who asked.
    expect((row.children[3] as HTMLElement).title).toContain(
      "The summoner asked",
    );
    // The deadline is a real instant, with its absolute value on hover.
    const time = row.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(
      new Date(DEADLINE).toISOString(),
    );
    expect(time.title).toContain("As requested by the summoner.");
    // Says what the columns are, and that none of it is a setting.
    expect(card.textContent).toContain("what the summoner requested");
    // No handle was sent, so there is no column and nothing marks one withheld.
    expect(card.textContent).not.toMatch(/handle/i);
    expect(within(card).queryByTestId("worker-summon-others")).toBeNull();
  });

  it("leaves out a column no instance has a value for, rather than defaulting it", async () => {
    const card = (await openWorkerPage([
      workerFixture({ id: "api.emails.a1", summon: summon() }),
    ]))!;
    expect(headers(card)).toEqual(["Instance", "Summon"]);
    expect(card.textContent).not.toContain("Exit when idle");
  });

  it("shows the platform handle when the API sends it", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({
          kind: "ecs",
          handle: "arn:aws:ecs:eu-west-1:123456789012:task/jobs/abc",
        }),
      }),
    ]))!;
    expect(headers(card)).toContain("Handle");
    expect(card.textContent).toContain(
      "arn:aws:ecs:eu-west-1:123456789012:task/jobs/abc",
    );
  });

  it("lists only the summoned instances, and counts the rest without saying why", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({ id: "sum-1", kind: "fly", mode: "exit-on-idle" }),
      }),
      workerFixture({ id: "api.emails.b2" }),
      workerFixture({
        id: "api.emails.c3",
        summon: summon({ id: "sum-2", kind: "fly" }),
      }),
    ]))!;
    expect(
      within(card)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector("th")!.textContent),
    ).toEqual(["api.emails.a1", "api.emails.c3"]);
    // An instance with no requested mode has an empty cell, not a default.
    const c3 = within(card).getByTestId("worker-summon-row-api.emails.c3");
    expect(c3.children[3]!.textContent).toBe("");
    expect(within(card).getByTestId("worker-summon-others").textContent).toBe(
      "1 other instance of this key reports no summon.",
    );
  });

  it("shows a mode this build does not know as its raw string", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({ mode: FUTURE_MODE }),
      }),
    ]))!;
    const row = within(card).getByTestId("worker-summon-row-api.emails.a1");
    const cell = row.children[2] as HTMLElement;
    expect(cell.textContent).toBe("on-demand");
    expect(cell.title).toContain("does not know");
  });
});
