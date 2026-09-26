import type {
  WorkerDto,
  WorkerTargetInfoDto,
  WorkerTargetKind,
} from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { WORKER_TARGET_KINDS } from "../../../app/api/contract";
import { page, setupDom, visit, within } from "../dom";
import { renderApp } from "../renderApp";
import { workerFixture } from "./fixtures";

setupDom();

/**
 * Where a worker's attempts run (`WorkerDto.target`): the badge every worker
 * table shows beside the state, and the worker page's Target card.
 *
 * The rule both must keep: **absent is "too old to say", never "in
 * process"**, and a kind this build does not know is shown as its raw string.
 */

/** A `target` as the API sends it. */
function target(
  kind: WorkerTargetKind,
  rest: Partial<WorkerTargetInfoDto> = {},
): WorkerTargetInfoDto {
  return {
    kind,
    processor: kind === "in-process" || kind === "custom" ? "function" : "file",
    ...rest,
  };
}

/**
 * A kind no build of the contract lists yet, as a later server might send.
 * The contract's type cannot name it, which is the point.
 */
const FUTURE_KIND = "remote-pool" as WorkerTargetKind;

/** Opens `/workers` listing `items`, and resolves the list. */
async function openList(items: WorkerDto[]) {
  visit("/jobs/workers");
  renderApp({ handlers: { "GET /workers": { body: { items } } } });
  return page().findByTestId("workers-list");
}

/** Opens the page of key `api.emails` with `items` as its live instances. */
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
  return page().findByTestId("worker-target");
}

/** The target badge of a row, or `null` when it shows none. */
function badgeOf(root: HTMLElement, id: string): HTMLElement | null {
  return within(root)
    .getByTestId(`worker-row-${id}`)
    .querySelector<HTMLElement>(".worker-target");
}

describe("the target badge in a worker table", () => {
  it("names every kind the contract lists in plain words", async () => {
    const expected: Record<WorkerTargetKind, string> = {
      "in-process": "In process",
      "worker-thread": "Worker thread",
      "child-process": "Child process",
      custom: "Custom",
    };
    const list = await openList(
      WORKER_TARGET_KINDS.map((kind) =>
        workerFixture({ id: `w-${kind}`, target: target(kind) }),
      ),
    );
    await within(list).findByTestId("worker-row-w-in-process");
    for (const kind of WORKER_TARGET_KINDS) {
      const badge = badgeOf(list, `w-${kind}`);
      expect(badge).not.toBeNull();
      // The visually hidden prefix says what the badge is to a screen reader.
      expect(badge!.textContent).toBe(`Runs in: ${expected[kind]}`);
      // A fact about the build, and its tooltip says so.
      expect(badge!.title).toContain("not a setting");
    }
    // It sits in the State cell, after the state itself.
    const cell = badgeOf(list, "w-child-process")!.closest("td")!;
    const badges = [...cell.querySelectorAll(".badge")];
    expect(badges.at(-1)).toBe(badgeOf(list, "w-child-process")!);
    expect(within(cell).getByTestId("worker-state").textContent).toBe(
      "Running",
    );
    // Never a runner's vocabulary.
    expect(list.textContent).not.toMatch(/\bspawn\b/i);
  });

  it("shows a custom target by its own name, and plain Custom when it has none", async () => {
    const list = await openList([
      workerFixture({
        id: "w-named",
        target: target("custom", { name: "grpc-pool" }),
      }),
      workerFixture({ id: "w-unnamed", target: target("custom") }),
    ]);
    await within(list).findByTestId("worker-row-w-named");
    expect(badgeOf(list, "w-named")!.textContent).toBe("Runs in: grpc-pool");
    expect(badgeOf(list, "w-named")!.title).toContain('Named "grpc-pool"');
    expect(badgeOf(list, "w-unnamed")!.textContent).toBe("Runs in: Custom");
  });

  it("shows a kind this build does not know as its raw string", async () => {
    const list = await openList([
      workerFixture({ id: "w-future", target: target(FUTURE_KIND) }),
    ]);
    await within(list).findByTestId("worker-row-w-future");
    const badge = badgeOf(list, "w-future")!;
    expect(badge.textContent).toBe("Runs in: remote-pool");
    expect(badge.title).toContain("does not know");
  });

  it("shows no badge at all for a worker too old to report one — not a dash, not In process", async () => {
    const list = await openList([
      workerFixture({ id: "w-old" }),
      workerFixture({ id: "w-new", target: target("worker-thread") }),
    ]);
    await within(list).findByTestId("worker-row-w-old");
    expect(badgeOf(list, "w-old")).toBeNull();
    const row = within(list).getByTestId("worker-row-w-old");
    expect(row.textContent).not.toContain("In process");
    // No column was added for it: the dash convention is the columns'.
    expect(
      within(row.closest("table")!)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).not.toContain("Runs in");
    // The upgraded worker beside it still says where it runs.
    expect(badgeOf(list, "w-new")!.textContent).toBe("Runs in: Worker thread");
  });

  it("leaves the state badge findable by name, holding the state alone, beside every other badge", async () => {
    const now = Date.now();
    const list = await openList([
      workerFixture({
        id: "w-busy",
        state: "paused",
        paused: true,
        control: { ...workerFixture().control!, pending: true },
        stale: true,
        expiresAt: now - 1_000,
        target: target("child-process"),
      }),
    ]);
    const row = await within(list).findByTestId("worker-row-w-busy");
    // Four badges in one cell: the state, Change pending, Not reporting and
    // the target. The state is the one named, and its text is the state only.
    expect(row.querySelectorAll("td .badge")).toHaveLength(4);
    const states = within(row).getAllByTestId("worker-state");
    expect(states).toHaveLength(1);
    expect(states[0]!.textContent).toBe("Paused");
    expect(states[0]!.classList.contains("worker-target")).toBe(false);
  });

  it("appears in a worker page's Instances table too", async () => {
    await openWorkerPage([
      workerFixture({ id: "api.emails.a1", target: target("child-process") }),
    ]);
    const instances = page().getByTestId("worker-instances");
    expect(badgeOf(instances, "api.emails.a1")!.textContent).toBe(
      "Runs in: Child process",
    );
    expect(
      within(
        within(instances).getByTestId("worker-row-api.emails.a1"),
      ).getByTestId("worker-state").textContent,
    ).toBe("Running");
  });
});

describe("the worker page's Target card", () => {
  it("shows where it runs and what it runs, and no file when the API sent none", async () => {
    const card = await openWorkerPage([
      workerFixture({ id: "api.emails.a1", target: target("child-process") }),
      workerFixture({ id: "api.emails.b2", target: target("child-process") }),
    ]);
    expect(within(card).getByTestId("worker-target-kind").textContent).toBe(
      "Child process",
    );
    expect(
      within(card).getByTestId("worker-target-processor").textContent,
    ).toBe("File");
    // The path was withheld: nothing hints that one exists.
    expect(within(card).queryByTestId("worker-target-file")).toBeNull();
    expect(within(card).queryByText("File", { selector: "dt" })).toBeNull();
    // Not custom: no name.
    expect(within(card).queryByTestId("worker-target-name")).toBeNull();
    // A fact, not a setting: the card says so, and offers nothing to change.
    expect(card.textContent).toContain("not a setting");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(within(card).queryByTestId("worker-target-differs")).toBeNull();
  });

  it("shows the file's path when the API sent it", async () => {
    const card = await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        target: target("worker-thread", { file: "/srv/app/jobs/email.ts" }),
      }),
    ]);
    expect(within(card).getByTestId("worker-target-kind").textContent).toBe(
      "Worker thread",
    );
    expect(within(card).getByTestId("worker-target-file").textContent).toBe(
      "/srv/app/jobs/email.ts",
    );
  });

  it("names a custom target, and what it runs", async () => {
    const custom = await openWorkerPage([
      workerFixture({
        id: "api.emails.a1",
        target: target("custom", { name: "grpc-pool" }),
      }),
    ]);
    expect(within(custom).getByTestId("worker-target-kind").textContent).toBe(
      "Custom",
    );
    expect(within(custom).getByTestId("worker-target-name").textContent).toBe(
      "grpc-pool",
    );
    expect(
      within(custom).getByTestId("worker-target-processor").textContent,
    ).toBe("Function");
  });

  it("shows an unknown kind as its raw string", async () => {
    const card = await openWorkerPage([
      workerFixture({ id: "api.emails.a1", target: target(FUTURE_KIND) }),
    ]);
    expect(within(card).getByTestId("worker-target-kind").textContent).toBe(
      "remote-pool",
    );
  });

  it("says a worker too old to report it predates target reporting — a dash, never In process", async () => {
    const card = await openWorkerPage([workerFixture({ id: "api.emails.a1" })]);
    expect(within(card).getByTestId("worker-target-kind").textContent).toBe(
      "—",
    );
    expect(
      within(card).getByTestId("worker-target-predates").textContent,
    ).toContain("predates target reporting");
    expect(card.textContent).not.toContain("In process");
    expect(within(card).queryByTestId("worker-target-processor")).toBeNull();
  });

  it("lists every target when the instances disagree, each with the instances that report it", async () => {
    const card = await openWorkerPage([
      // Mid-rollout: the old build, the new one, and one too old to say.
      workerFixture({ id: "api.emails.a1", target: target("in-process") }),
      workerFixture({
        id: "api.emails.b2",
        target: target("child-process", { file: "/srv/app/jobs/email.ts" }),
      }),
      workerFixture({ id: "api.emails.c3", target: target("in-process") }),
      workerFixture({ id: "api.emails.d4" }),
    ]);
    expect(
      within(card).getByTestId("worker-target-differs").textContent,
    ).toContain("Not every instance of this key runs the same way");
    const rows = within(card).getAllByTestId("worker-target-group");
    expect(rows.map((row) => row.textContent)).toEqual([
      "In processFunction2 instances: api.emails.a1, api.emails.c3",
      "Child processFile/srv/app/jobs/email.ts1 instance: api.emails.b2",
      "——1 instance: api.emails.d4",
    ]);
    // Not the first instance's answer standing for all of them.
    expect(within(card).queryByTestId("worker-target-kind")).toBeNull();
  });

  it("names the first five instances of a target and counts the rest", async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `api.emails.n${index}`);
    const card = await openWorkerPage([
      ...ids.map((id) => workerFixture({ id, target: target("in-process") })),
      workerFixture({ id: "api.emails.odd", target: target("worker-thread") }),
    ]);
    const [group] = within(card).getAllByTestId("worker-target-group");
    expect(group!.textContent).toContain("7 instances:");
    expect(group!.textContent).toContain("api.emails.n4");
    expect(group!.textContent).not.toContain("api.emails.n5");
    expect(group!.textContent).toContain("and 2 more");
  });

  it("waits for an instance when none is live", async () => {
    const card = await openWorkerPage([]);
    expect(card.textContent).toContain("known once an instance reports");
    expect(card.textContent).not.toContain("In process");
  });
});
