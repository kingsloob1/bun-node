import type { RecordedCall } from "../mockFetch";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { jobApiPath, jobFixture, jobMeta, logPage } from "./fixtures";
import { renderJobScreen } from "./render";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** Lines in the log, as the handler numbers them. */
const TOTAL = 250;

/** A logs handler over {@link TOTAL} lines that honours offset, limit and order. */
function logsHandler(call: RecordedCall) {
  const offset = Number(call.query.get("offset"));
  const limit = Number(call.query.get("limit"));
  const order = call.query.get("order") === "desc" ? "desc" : "asc";
  return { body: logPage(offset, limit, order, TOTAL) };
}

/** Renders a job's screen with the numbered log, and returns the log calls. */
async function renderLogs(
  state: Parameters<typeof jobFixture>[0] = "completed",
  maxLogPage = 500,
  wait = true,
) {
  const result = await renderJobScreen(jobFixture(state), {
    meta: jobMeta({ limits: { ...jobMeta().limits, maxLogPage } }),
    handlers: { [`GET ${jobApiPath()}/logs`]: logsHandler },
    wait,
  });
  const logCalls = () =>
    result.calls.filter((call) => call.path === `${jobApiPath()}/logs`);
  return { ...result, logCalls };
}

/** The visible log lines' text. */
function lines(): string[] {
  return Array.from(document.querySelectorAll(".log-text")).map(
    (line) => line.textContent ?? "",
  );
}

/** The visible line numbers. */
function numbers(): string[] {
  return Array.from(document.querySelectorAll(".log-number")).map(
    (number) => number.textContent ?? "",
  );
}

/** The query of a log call, as a plain object. */
function query(call: RecordedCall) {
  return Object.fromEntries(call.query.entries());
}

describe("the job logs", () => {
  it("loads the first page at min(100, maxLogPage), oldest first, and pages forward and back", async () => {
    const { logCalls } = await renderLogs();
    await page().findByRole("list", { name: "Log lines" });
    expect(query(logCalls()[0]!)).toEqual({
      offset: "0",
      limit: "100",
      order: "asc",
    });
    expect(lines()[0]).toBe("line 1");
    expect(numbers().slice(0, 2)).toEqual(["1", "2"]);
    const pager = page().getByRole("navigation", { name: "Log pages" });
    expect(pager.textContent).toContain("250");

    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lines()[0]).toBe("line 101"));
    expect(query(logCalls().at(-1)!)).toMatchObject({
      offset: "100",
      limit: "100",
    });

    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lines()[0]).toBe("line 201"));
    expect(lines()).toHaveLength(50);
    expect(
      (within(pager).getByRole("button", { name: "Next" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(within(pager).getByRole("button", { name: "Previous" }));
    await waitFor(() => expect(lines()[0]).toBe("line 101"));
  });

  it("offers page sizes up to limits.maxLogPage only", async () => {
    await renderLogs("completed", 150);
    await page().findByRole("list", { name: "Log lines" });
    const pager = page().getByRole("navigation", { name: "Log pages" });
    const sizes = Array.from(
      within(pager).getByLabelText("Rows per page").querySelectorAll("option"),
    ).map((option) => Number(option.value));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(150);
    expect(sizes).toContain(100);
    expect(sizes).not.toContain(200);
  });

  it("starts at maxLogPage when it is under 100", async () => {
    const { logCalls } = await renderLogs("completed", 30);
    await page().findByRole("list", { name: "Log lines" });
    expect(query(logCalls()[0]!).limit).toBe("30");
  });

  it("switches to newest first from the start, numbering lines by their place in the log", async () => {
    const { logCalls } = await renderLogs();
    await page().findByRole("list", { name: "Log lines" });
    const pager = page().getByRole("navigation", { name: "Log pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lines()[0]).toBe("line 101"));

    fireEvent.change(page().getByLabelText("Order"), {
      target: { value: "desc" },
    });
    await waitFor(() => expect(lines()[0]).toBe("line 250"));
    expect(query(logCalls().at(-1)!)).toEqual({
      offset: "0",
      limit: "100",
      order: "desc",
    });
    expect(numbers().slice(0, 2)).toEqual(["250", "249"]);
  });

  it("refreshes every 3 s while the job is active", async () => {
    jest.useFakeTimers();
    const { logCalls } = await renderLogs("active", 500, false);
    await advance(100, 10);
    expect(page().getByTestId("logs-follow").textContent).toContain("3 s");
    const before = logCalls().length;
    expect(before).toBeGreaterThanOrEqual(1);
    await advance(3_000);
    expect(logCalls().length).toBe(before + 1);
    await advance(3_000);
    expect(logCalls().length).toBe(before + 2);
  });

  it("does not refresh a finished job's logs", async () => {
    jest.useFakeTimers();
    const { logCalls } = await renderLogs("completed", 500, false);
    await advance(100, 10);
    expect(page().queryByTestId("logs-follow")).toBeNull();
    const before = logCalls().length;
    await advance(9_000);
    expect(logCalls().length).toBe(before);
  });
});

/** Advances fake time in steps, letting fetches and React settle between them. */
async function advance(ms: number, step = 250): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(step, ms - elapsed));
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });
  }
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      for (let j = 0; j < 10; j++) {
        await Promise.resolve();
      }
      jest.advanceTimersByTime(10);
    });
  }
}
