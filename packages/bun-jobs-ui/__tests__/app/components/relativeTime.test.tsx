import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import {
  formatRelativeTime,
  toEpochMs,
} from "../../../app/components/formatRelative";
import { RelativeTime } from "../../../app/components/RelativeTime";
import { NOW_TICK_MS, sharedClockState } from "../../../app/hooks/useNow";
import { act, page, render, setupDom } from "../dom";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatRelativeTime", () => {
  it("reads an instant just ahead of the cached clock as now", () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, {
      numeric: "auto",
      style: "narrow",
    });
    // Every relative time renders against `useNow`'s shared clock, which
    // ticks every NOW_TICK_MS; a heartbeat written since its last tick is
    // ahead of it. It reads "now", not "in 2s".
    expect(formatRelativeTime(NOW + 2_000, NOW)).toBe(rtf.format(0, "second"));
    expect(formatRelativeTime(NOW + NOW_TICK_MS, NOW)).toBe(
      rtf.format(0, "second"),
    );
    // Beyond one tick it is a real future time, shown as one.
    expect(formatRelativeTime(NOW + NOW_TICK_MS + 1_000, NOW)).toBe(
      rtf.format(11, "second"),
    );
    expect(formatRelativeTime(NOW + 5 * MIN, NOW)).toBe(
      rtf.format(5, "minute"),
    );
  });

  it("picks the unit and direction", () => {
    const rtf = new Intl.RelativeTimeFormat(undefined, {
      numeric: "auto",
      style: "narrow",
    });
    expect(formatRelativeTime(NOW - 3 * MIN, NOW)).toBe(
      rtf.format(-3, "minute"),
    );
    expect(formatRelativeTime(NOW + 2 * HOUR, NOW)).toBe(rtf.format(2, "hour"));
    expect(formatRelativeTime(NOW - 10_000, NOW)).toBe(
      rtf.format(-10, "second"),
    );
    expect(formatRelativeTime(NOW, NOW)).toBe(rtf.format(0, "second"));
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe(rtf.format(-1, "day"));
    expect(formatRelativeTime(NOW - 14 * DAY, NOW)).toBe(
      rtf.format(-2, "week"),
    );
    expect(formatRelativeTime(NOW - 400 * DAY, NOW)).toBe(
      rtf.format(-1, "year"),
    );
  });

  it("formats in English as '3m ago' / 'in 2h'", () => {
    expect(formatRelativeTime(NOW - 3 * MIN, NOW, "en")).toBe("3m ago");
    expect(formatRelativeTime(NOW + 2 * HOUR, NOW, "en")).toBe("in 2h");
  });

  it("normalises inputs", () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
    expect(toEpochMs("garbage")).toBeNull();
    expect(toEpochMs(new Date(NOW))).toBe(NOW);
    expect(toEpochMs(new Date(NOW).toISOString())).toBe(NOW);
    expect(toEpochMs(NOW)).toBe(NOW);
  });
});

describe("RelativeTime", () => {
  it("renders a <time> with the ISO instant in dateTime and title", () => {
    const at = Date.now() - 3 * MIN;
    render(<RelativeTime value={at} />);
    const time = document.querySelector("time")!;
    const iso = new Date(at).toISOString();
    expect(time.getAttribute("dateTime")).toBe(iso);
    expect(time.getAttribute("title")).toBe(iso);
    expect(time.textContent).toBe(formatRelativeTime(at, Date.now()));
  });

  it("renders a dash for null and undefined, without joining the clock", () => {
    render(
      <>
        <RelativeTime value={null} />
        <RelativeTime value={undefined} />
      </>,
    );
    expect(page().getAllByText("—")).toHaveLength(2);
    expect(document.querySelector("time")).toBeNull();
    expect(sharedClockState()).toEqual({ subscribers: 0, running: false });
  });

  it("shares one interval across instances and updates them together", () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const setIntervalSpy = spyOn(globalThis, "setInterval");
    const view = render(
      <>
        <RelativeTime value={NOW - 30_000} />
        <RelativeTime value={NOW - 40_000} />
        <RelativeTime value={NOW - 50_000} />
      </>,
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(sharedClockState()).toEqual({ subscribers: 3, running: true });
    const texts = () =>
      Array.from(document.querySelectorAll("time")).map(
        (time) => time.textContent,
      );
    expect(texts()).toEqual([
      formatRelativeTime(NOW - 30_000, NOW),
      formatRelativeTime(NOW - 40_000, NOW),
      formatRelativeTime(NOW - 50_000, NOW),
    ]);
    act(() => {
      jest.advanceTimersByTime(6 * NOW_TICK_MS);
    });
    const later = NOW + 6 * NOW_TICK_MS;
    expect(texts()).toEqual([
      formatRelativeTime(NOW - 30_000, later),
      formatRelativeTime(NOW - 40_000, later),
      formatRelativeTime(NOW - 50_000, later),
    ]);
    expect(texts()[0]).not.toBe(formatRelativeTime(NOW - 30_000, NOW));
    view.unmount();
    expect(sharedClockState()).toEqual({ subscribers: 0, running: false });
    setIntervalSpy.mockRestore();
  });
});
