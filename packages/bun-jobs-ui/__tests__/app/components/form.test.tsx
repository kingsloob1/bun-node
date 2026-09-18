import { describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { Field } from "../../../app/components/Field";
import {
  Checkbox,
  DateTimeInput,
  NumberInput,
  Select,
  TextInput,
} from "../../../app/components/inputs";
import {
  fromDateTimeLocal,
  localTimeZone,
  parseNumberInput,
  toDateTimeLocal,
} from "../../../app/components/inputValues";
import { fireEvent, page, render, setupDom } from "../dom";

setupDom();

/** The first argument of a spy's last call (the controls also pass the event). */
function lastValue(spy: { mock: { calls: unknown[][] } }): unknown {
  return spy.mock.calls.at(-1)![0];
}

/** The ids an element's `aria-describedby` lists. */
function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean);
}

describe("Field", () => {
  it("wires label, hint, error and required onto the control", () => {
    render(
      <Field
        label="Queue name"
        hint="Letters and dashes."
        error="Already taken."
        required
      >
        <TextInput
          value=""
          onChange={() => {}}
        />
      </Field>,
    );
    const input = page().getByLabelText(/Queue name/);
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.hasAttribute("required")).toBe(true);
    const ids = describedBy(input);
    expect(ids.map((id) => document.getElementById(id)!.textContent)).toEqual([
      "Letters and dashes.",
      "Already taken.",
    ]);
    // The marker is visual; `required` carries it for assistive tech.
    const marker = document.querySelector(".field-required")!;
    expect(marker.getAttribute("aria-hidden")).toBe("true");
  });

  it("omits the error wiring when valid, and honours an explicit id", () => {
    render(
      <Field
        label="Delay"
        id="delay"
      >
        <NumberInput
          value={undefined}
          onChange={() => {}}
          aria-describedby="extra"
        />
      </Field>,
    );
    const input = page().getByLabelText("Delay");
    expect(input.id).toBe("delay");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.hasAttribute("required")).toBe(false);
    expect(describedBy(input)).toEqual(["extra"]);
  });

  it("hands the wiring to a render function", () => {
    render(
      <Field
        label="Notes"
        hint="Optional."
      >
        {(control) => (
          <textarea
            {...control}
            className="input"
          />
        )}
      </Field>,
    );
    const area = page().getByLabelText("Notes");
    expect(area.tagName).toBe("TEXTAREA");
    expect(document.getElementById(describedBy(area)[0]!)!.textContent).toBe(
      "Optional.",
    );
  });
});

describe("NumberInput", () => {
  it("reports empty as undefined, never 0", () => {
    const onChange = mock((_value: number | undefined) => {});
    function Harness() {
      const [value, setValue] = useState<number | undefined>(5);
      return (
        <Field label="Priority">
          <NumberInput
            value={value}
            min={0}
            max={10}
            onChange={(next) => {
              setValue(next);
              onChange(next);
            }}
          />
        </Field>
      );
    }
    render(<Harness />);
    const input = page().getByLabelText("Priority") as HTMLInputElement;
    expect(input.value).toBe("5");
    expect(input.min).toBe("0");
    expect(input.max).toBe("10");
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  it("parses input values", () => {
    expect(parseNumberInput("")).toBeUndefined();
    expect(parseNumberInput("  ")).toBeUndefined();
    expect(parseNumberInput("abc")).toBeUndefined();
    expect(parseNumberInput("0")).toBe(0);
    expect(parseNumberInput("-1.5")).toBe(-1.5);
  });
});

describe("DateTimeInput", () => {
  it("round-trips epoch ms through the local datetime-local value", () => {
    const at = new Date(2026, 8, 18, 9, 5).getTime();
    expect(toDateTimeLocal(at)).toBe("2026-09-18T09:05");
    expect(fromDateTimeLocal("2026-09-18T09:05")).toBe(at);
    const withSeconds = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(toDateTimeLocal(withSeconds, true)).toBe("2026-01-02T03:04:05");
    expect(fromDateTimeLocal(toDateTimeLocal(withSeconds, true))).toBe(
      withSeconds,
    );
    expect(toDateTimeLocal(undefined)).toBe("");
    expect(fromDateTimeLocal("")).toBeUndefined();
    expect(fromDateTimeLocal("not a date")).toBeUndefined();
  });

  it("shows the value, emits epoch ms and names the time zone", () => {
    const onChange = mock((_value: number | undefined) => {});
    const at = new Date(2026, 8, 18, 9, 5).getTime();
    render(
      <Field label="Run at">
        <DateTimeInput
          value={at}
          onChange={onChange}
        />
      </Field>,
    );
    const input = page().getByLabelText("Run at") as HTMLInputElement;
    expect(input.type).toBe("datetime-local");
    expect(input.value).toBe("2026-09-18T09:05");
    const zone = describedBy(input).map(
      (id) => document.getElementById(id)!.textContent,
    );
    expect(zone).toContain(localTimeZone());
    fireEvent.change(input, { target: { value: "2026-12-31T23:59" } });
    expect(lastValue(onChange)).toBe(new Date(2026, 11, 31, 23, 59).getTime());
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(lastValue(onChange)).toBeUndefined();
  });
});

describe("Select and Checkbox", () => {
  it("Select emits the typed option value", () => {
    const onChange = mock((_value: "asc" | "desc") => {});
    render(
      <Field label="Order">
        <Select
          value="asc"
          options={[
            { value: "asc", label: "Oldest first" },
            { value: "desc", label: "Newest first" },
          ]}
          onChange={onChange}
        />
      </Field>,
    );
    const select = page().getByLabelText("Order");
    fireEvent.change(select, { target: { value: "desc" } });
    expect(lastValue(onChange)).toBe("desc");
  });

  it("Checkbox is labelled, described and emits booleans", () => {
    const onChange = mock((_checked: boolean) => {});
    render(
      <Checkbox
        checked={false}
        label="Include delayed"
        hint="Also removes scheduled jobs."
        onChange={onChange}
      />,
    );
    const box = page().getByRole("checkbox", { name: "Include delayed" });
    expect(document.getElementById(describedBy(box)[0]!)!.textContent).toBe(
      "Also removes scheduled jobs.",
    );
    fireEvent.click(box);
    expect(lastValue(onChange)).toBe(true);
  });
});
