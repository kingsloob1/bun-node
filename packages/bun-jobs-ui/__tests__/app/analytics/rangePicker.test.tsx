import type { TimeRange } from "../../../app/analytics/range";
import { describe, expect, it } from "bun:test";
import { RangePicker } from "../../../app/analytics/RangePicker";
import { fireEvent, page, render, setupDom, within } from "../dom";

setupDom();

/** Renders the picker and reports what it last chose. */
function mount(range: TimeRange) {
  const chosen: TimeRange[] = [];
  render(
    <RangePicker
      range={range}
      onChange={(next) => chosen.push(next)}
      label="Jobs range"
    />,
  );
  const group = page().getByRole("group", { name: "Jobs range" });
  return { group, chosen };
}

/** The `datetime-local` value for an instant, to the second, in local time. */
function localValue(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe("the range picker", () => {
  it("applies a preset as soon as it is chosen", () => {
    const { group, chosen } = mount({ kind: "preset", seconds: 3600 });
    fireEvent.change(within(group).getByRole("combobox"), {
      target: { value: "600" },
    });
    expect(chosen).toEqual([{ kind: "preset", seconds: 600 }]);
  });

  it("offers every preset and the custom entry", () => {
    const { group } = mount({ kind: "preset", seconds: 3600 });
    const labels = [
      ...within(group).getByRole("combobox").querySelectorAll("option"),
    ].map((option) => option.textContent);
    expect(labels[0]).toBe("Last 60 seconds");
    expect(labels).toContain("Last hour");
    expect(labels.at(-1)).toBe("Custom range…");
  });

  it("opens the custom fields on what is on screen, and applies only on Apply", () => {
    const now = Date.now();
    const { group, chosen } = mount({ kind: "preset", seconds: 600 });
    fireEvent.change(within(group).getByRole("combobox"), {
      target: { value: "custom" },
    });
    // Nothing is read until Apply: switching to custom changes no range.
    expect(chosen).toEqual([]);
    const from = within(group).getByLabelText(/From/) as HTMLInputElement;
    const to = within(group).getByLabelText(/To/) as HTMLInputElement;
    // It opened on the preset's own bounds, so the chart does not empty.
    expect(from.value.slice(0, 16)).toBe(
      localValue(now - 600_000).slice(0, 16),
    );
    expect(to.value.slice(0, 16)).toBe(localValue(now).slice(0, 16));

    const start = now - 7_200_000;
    fireEvent.change(from, { target: { value: localValue(start) } });
    fireEvent.change(to, { target: { value: localValue(now) } });
    fireEvent.click(within(group).getByRole("button", { name: "Apply" }));
    expect(chosen).toHaveLength(1);
    const range = chosen[0]!;
    expect(range.kind).toBe("custom");
    if (range.kind === "custom") {
      expect(range.from).toBeLessThan(range.to);
      expect(Math.abs(range.from - start)).toBeLessThan(1_000);
    }
  });

  it("refuses a backwards range, saying why, and applies nothing", () => {
    const now = Date.now();
    const { group, chosen } = mount({
      kind: "custom",
      from: now - 600_000,
      to: now,
    });
    const from = within(group).getByLabelText(/From/) as HTMLInputElement;
    fireEvent.change(from, { target: { value: localValue(now + 600_000) } });
    const apply = within(group).getByRole("button", { name: "Apply" });
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(group.textContent).toContain("The end must be after the start.");
    fireEvent.click(apply);
    expect(chosen).toEqual([]);
  });
});
