import type {
  WorkerDto,
  WorkerSummonProvenanceDto,
} from "../../../app/api/types";
import type { SummonMode } from "../../../app/screens/workers/summon";
import { describe, expect, it } from "bun:test";
import { INVALID_TEXT } from "../../../app/format";
import {
  summonUnitHint,
  summonUnitLabel,
} from "../../../app/screens/workers/summon";
import { expectAbsent } from "../assert";
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

/** The unit badge of a row, or `null` when it shows none. */
function unitOf(root: HTMLElement, id: string): HTMLElement | null {
  return within(within(root).getByTestId(`worker-row-${id}`)).queryByTestId(
    "worker-summon-unit",
  );
}

/** What the unit badge's tooltip says for the group `media`. */
const MEDIA_UNIT_HINT =
  "This worker runs in the shared unit summoned for the summon group media: one process serving its member queues.";

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
    expectAbsent(badgeOf(list, "w-plain"));
    const row = within(list).getByTestId("worker-row-w-plain");
    expect(row.textContent).not.toMatch(/summon/i);
    // No column was added for it.
    expect(headers(row.closest("table")!)).not.toContain("Summoned");
    // The summoned worker beside it still says so.
    expect(badgeOf(list, "w-summoned")!.textContent).toBe("Summoned by fly");
  });

  it("says the mode the worker actually runs as, apart from what was requested", async () => {
    const list = await openList([
      workerFixture({
        id: "w-resolved",
        summon: summon({ resolvedMode: "until-stopped", mode: "exit-on-idle" }),
      }),
    ]);
    await within(list).findByTestId("worker-row-w-resolved");
    const hint = badgeOf(list, "w-resolved")!.title;
    expect(hint).toContain("Runs as: Run until stopped.");
    expect(hint).toContain("requested mode: Exit when idle");
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

  it("names the summon group whose shared unit a worker runs in, right after the summon badge, and nothing without one", async () => {
    const list = await openList([
      workerFixture({
        id: "w-unit",
        summon: summon({ kind: "ecs", group: "media" }),
      }),
      workerFixture({ id: "w-single", summon: summon({ kind: "ecs" }) }),
    ]);
    await within(list).findByTestId("worker-row-w-unit");
    expect(badgeOf(list, "w-unit")!.textContent).toBe("Summoned by ecs");
    const unit = unitOf(list, "w-unit")!;
    expect(unit.textContent).toBe("Unit of media");
    expect(unit.title).toBe(MEDIA_UNIT_HINT);
    // Right after the summon badge, and last in the State cell.
    const badges = [...unit.closest("td")!.querySelectorAll(".badge")];
    expect(badges.at(-1)).toBe(unit);
    expect(badges.at(-2)).toBe(badgeOf(list, "w-unit")!);
    // A worker summoned for one queue names no group, so it has no unit badge.
    expect(badgeOf(list, "w-single")!.textContent).toBe("Summoned by ecs");
    expectAbsent(unitOf(list, "w-single"));
    expect(
      within(list).getByTestId("worker-row-w-single").textContent,
    ).not.toContain("Unit of");
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

  it("names the unit's summon group in a worker page's Instances table too", async () => {
    await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({ kind: "ecs", group: "media" }),
      }),
    ]);
    const instances = page().getByTestId("worker-instances");
    expect(unitOf(instances, "api.emails.a1")!.textContent).toBe(
      "Unit of media",
    );
  });
});

describe("the summon unit's label and hint", () => {
  it("names the group, in the badge and in its tooltip", () => {
    expect(summonUnitLabel("media")).toBe("Unit of media");
    expect(summonUnitHint("media")).toBe(MEDIA_UNIT_HINT);
  });

  it("passes the group through displayText, as the kind does", () => {
    // The listing is not shape-checked: a group that is not text still reads.
    const odd = { name: "media" } as unknown as string;
    expect(summonUnitLabel(odd)).toBe(`Unit of ${INVALID_TEXT}`);
    expect(summonUnitHint(odd)).toContain(`the summon group ${INVALID_TEXT}:`);
  });
});

describe("the worker page's Summoned card", () => {
  it("is absent when no instance reports a summon", async () => {
    const card = await openWorkerPage([
      workerFixture({ id: "api.emails.a1" }),
      workerFixture({ id: "api.emails.b2" }),
    ]);
    expectAbsent(card);
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
    expectAbsent(within(card).queryByTestId("worker-summon-others"));
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
    expect(c3.children[3].textContent).toBe("");
    expect(within(card).getByTestId("worker-summon-others").textContent).toBe(
      "1 other instance of this key reports no summon.",
    );
  });

  it("shows the mode each instance actually runs as, in a column of its own", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        // Runs until stopped although the summoner asked for none: its own option.
        summon: summon({ resolvedMode: "until-stopped" }),
      }),
    ]))!;
    expect(headers(card)).toEqual(["Instance", "Summon", "Runs as"]);
    const row = within(card).getByTestId("worker-summon-row-api.emails.a1");
    expect(row.children[2].textContent).toBe("Run until stopped");
    expect((row.children[2] as HTMLElement).title).toContain("actually runs");
  });

  it("shows the summon group whose unit each instance runs in, and a dash for one without", async () => {
    const card = (await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        summon: summon({ id: "sum-1", kind: "ecs", group: "media" }),
      }),
      workerFixture({
        id: "api.emails.b2",
        summon: summon({ id: "sum-2", kind: "ecs" }),
      }),
    ]))!;
    expect(headers(card)).toEqual([
      "Instance",
      "Summon",
      "Summoner",
      "Unit of",
    ]);
    const a1 = within(card).getByTestId("worker-summon-row-api.emails.a1");
    expect(a1.children[3].textContent).toBe("media");
    expect((a1.children[3] as HTMLElement).title).toBe(MEDIA_UNIT_HINT);
    const b2 = within(card).getByTestId("worker-summon-row-api.emails.b2");
    expect(b2.children[3].textContent).toBe("—");
  });

  it("has no Unit of column when no instance names a summon group", async () => {
    const card = (await openWorkerPage([
      workerFixture({ id: "api.emails.a1", summon: summon({ kind: "ecs" }) }),
    ]))!;
    expect(headers(card)).toEqual(["Instance", "Summon", "Summoner"]);
    expect(card.textContent).not.toContain("Unit of");
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
