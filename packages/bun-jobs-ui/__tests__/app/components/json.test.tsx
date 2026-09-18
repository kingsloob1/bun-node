import type { JsonEditorState } from "../../../app/components/jsonParse";
import { describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import {
  CIRCULAR_MARKER,
  safeStringify,
  toJsonSafe,
} from "../../../app/components/copy";
import { JsonEditor } from "../../../app/components/JsonEditor";
import {
  byteLength,
  jsonEditorState,
  lineColumn,
  parseJsonText,
} from "../../../app/components/jsonParse";
import { JsonView } from "../../../app/components/JsonView";
import { act, fireEvent, page, render, setupDom } from "../dom";

setupDom();

/** Stubs `navigator.clipboard` for one test. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

describe("toJsonSafe / safeStringify", () => {
  it("marks cycles but keeps shared references", () => {
    const shared = { n: 1 };
    const root: Record<string, unknown> = { a: shared, b: shared };
    root.self = root;
    expect(toJsonSafe(root)).toEqual({
      a: { n: 1 },
      b: { n: 1 },
      self: CIRCULAR_MARKER,
    });
  });

  it("handles bigint, undefined, dates and functions", () => {
    expect(
      safeStringify(
        { big: 10n, at: new Date(0), fn: () => 1, list: [undefined] },
        0,
      ),
    ).toBe('{"big":"10","at":"1970-01-01T00:00:00.000Z","list":[null]}');
    expect(safeStringify(undefined)).toBe("undefined");
  });
});

describe("JsonView", () => {
  it("renders values colour-coded, auto-expanding to expandDepth", () => {
    render(
      <JsonView
        label="Job data"
        value={{ to: "a@b.c", n: 3, ok: true, none: null, nested: { x: 1 } }}
      />,
    );
    const tree = page().getByRole("list", { name: "Job data" });
    expect(tree.querySelector(".json-string")!.textContent).toBe('"a@b.c"');
    expect(tree.querySelector(".json-number")!.textContent).toBe("3");
    expect(tree.querySelector(".json-boolean")!.textContent).toBe("true");
    expect(tree.querySelector(".json-null")!.textContent).toBe("null");
    // Depth 1 is collapsed by default: the nested object shows a summary.
    const toggles = page().getAllByRole("button", { expanded: false });
    expect(toggles).toHaveLength(1);
    expect(toggles[0]!.textContent).toContain("1 key");
    expect(tree.textContent).not.toContain("x: ");
  });

  it("collapses and expands", () => {
    render(<JsonView value={{ nested: { x: 1 } }} />);
    const root = page().getByRole("button", { name: /^\{/ });
    expect(root.getAttribute("aria-expanded")).toBe("true");
    const nested = page().getByRole("button", { name: /nested/ });
    fireEvent.click(nested);
    expect(nested.getAttribute("aria-expanded")).toBe("true");
    expect(page().getByText("x:", { exact: false })).toBeTruthy();
    fireEvent.click(root);
    expect(root.getAttribute("aria-expanded")).toBe("false");
    expect(root.textContent).toContain("1 key");
    expect(page().queryByText("x:", { exact: false })).toBeNull();
  });

  it("truncates long strings with show more", () => {
    const long = "x".repeat(500);
    render(
      <JsonView
        value={long}
        maxStringLength={50}
      />,
    );
    const text = document.querySelector(".json-string")!;
    expect(text.textContent).toBe(`"${"x".repeat(50)}…"`);
    fireEvent.click(
      page().getByRole("button", { name: "Show more (500 chars)" }),
    );
    expect(text.textContent).toBe(`"${long}"`);
    fireEvent.click(page().getByRole("button", { name: "Show less" }));
    expect(text.textContent!.length).toBe(53);
  });

  it("renders big arrays a batch at a time", () => {
    const big = Array.from({ length: 100_000 }, (_, index) => index);
    const started = performance.now();
    render(
      <JsonView
        value={big}
        maxChildren={50}
      />,
    );
    expect(document.querySelectorAll(".json-children > li")).toHaveLength(51);
    const more = page().getByRole("button", {
      name: "Show 50 more (99950 hidden)",
    });
    fireEvent.click(more);
    expect(document.querySelectorAll(".json-children > li")).toHaveLength(101);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("survives a circular object, undefined and exotic values", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    loop.list = [loop, undefined];
    render(
      <JsonView
        value={loop}
        expandDepth={5}
      />,
    );
    const circular = document.querySelectorAll(".json-circular");
    expect(circular.length).toBe(2);
    expect(circular[0]!.textContent).toBe("[Circular]");
    expect(document.querySelector(".json-undefined")!.textContent).toBe(
      "undefined",
    );
  });

  it("renders a bare undefined, bigint and Date", () => {
    render(
      <>
        <JsonView
          value={undefined}
          label="a"
        />
        <JsonView
          value={12n}
          label="b"
        />
        <JsonView
          value={new Date(0)}
          label="c"
        />
      </>,
    );
    expect(page().getByRole("list", { name: "a" }).textContent).toBe(
      "undefined",
    );
    expect(page().getByRole("list", { name: "b" }).textContent).toBe("12n");
    expect(page().getByRole("list", { name: "c" }).textContent).toBe(
      "1970-01-01T00:00:00.000Z",
    );
  });

  it("copies the value, circular-safe, and reports a refused clipboard", async () => {
    const writeText = mock(async (_text: string) => {});
    stubClipboard(writeText);
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    render(
      <JsonView
        value={loop}
        label="Data"
      />,
    );
    const button = page().getByRole("button", { name: "Copy Data" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify({ a: 1, self: CIRCULAR_MARKER }, null, 2),
    );
    expect(button.textContent).toBe("Copied");

    stubClipboard(async () => {
      throw new Error("denied");
    });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("Copy failed");
  });
});

describe("parseJsonText", () => {
  it("parses valid JSON", () => {
    expect(parseJsonText('{"a":[1,2]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it("locates errors by line and column", () => {
    const trailingComma = parseJsonText('{\n  "a": 1,\n}');
    expect(trailingComma).toEqual({
      ok: false,
      error: {
        message: "Expected a property name in double quotes but found '}'",
        line: 3,
        column: 1,
        offset: 12,
      },
    });
    const missingColon = parseJsonText('{"a" 1}');
    expect(missingColon.ok).toBe(false);
    if (!missingColon.ok) {
      expect(missingColon.error).toMatchObject({ line: 1, column: 6 });
      expect(missingColon.error.message).toContain("':'");
    }
    const unterminated = parseJsonText('["abc');
    expect(!unterminated.ok && unterminated.error.message).toBe(
      "Unterminated string",
    );
    const empty = parseJsonText("");
    expect(!empty.ok && empty.error).toMatchObject({ line: 1, column: 1 });
    const extra = parseJsonText("1 2");
    expect(!extra.ok && extra.error).toMatchObject({ column: 3 });
  });

  it("computes line/column and UTF-8 size", () => {
    expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(byteLength("é")).toBe(2);
    expect(byteLength('"€"')).toBe(5);
  });
});

describe("JsonEditor", () => {
  /** A controlled editor that records every state it emits. */
  function Editor({
    initial,
    maxBytes,
    onState,
  }: {
    /** Starting text. */
    initial: string;
    /** Size limit. */
    maxBytes?: number;
    /** Spy. */
    onState: (state: JsonEditorState) => void;
  }) {
    const [text, setText] = useState(initial);
    return (
      <JsonEditor
        aria-label="Data"
        value={text}
        maxBytes={maxBytes}
        onChange={(state) => {
          setText(state.text);
          onState(state);
        }}
      />
    );
  }

  it("shows the parse error with its position and marks the input invalid", () => {
    const onState = mock((_state: JsonEditorState) => {});
    render(
      <Editor
        initial="{}"
        onState={onState}
      />,
    );
    const input = page().getByRole("textbox", { name: "Data" });
    fireEvent.change(input, { target: { value: '{\n  "a": tru\n}' } });
    const last = onState.mock.calls.at(-1)![0];
    expect(last.valid).toBe(false);
    expect(last.value).toBeUndefined();
    expect(last.error).toMatchObject({ line: 2, column: 11 });
    const error = page().getByText(/^Line 2, column 11:/);
    expect(error.textContent).toContain("Expected 'true'");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    // Format needs valid JSON.
    const format = page().getByRole("button", { name: "Format" });
    expect((format as HTMLButtonElement).disabled).toBe(true);
  });

  it("formats and minifies, reporting value and validity", () => {
    const onState = mock((_state: JsonEditorState) => {});
    render(
      <Editor
        initial='{"a":[1,2]}'
        onState={onState}
      />,
    );
    const input = page().getByRole("textbox", {
      name: "Data",
    }) as HTMLTextAreaElement;
    expect(page().getByText("Valid JSON")).toBeTruthy();
    fireEvent.click(page().getByRole("button", { name: "Format" }));
    expect(input.value).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(onState.mock.calls.at(-1)![0]).toMatchObject({
      valid: true,
      value: { a: [1, 2] },
      error: null,
    });
    fireEvent.click(page().getByRole("button", { name: "Minify" }));
    expect(input.value).toBe('{"a":[1,2]}');
  });

  it("meters bytes and flags the over-limit state", () => {
    const onState = mock((_state: JsonEditorState) => {});
    render(
      <Editor
        initial='"ok"'
        maxBytes={10}
        onState={onState}
      />,
    );
    const input = page().getByRole("textbox", { name: "Data" });
    expect(page().getByText("4 B of 10 B")).toBeTruthy();
    fireEvent.change(input, { target: { value: '"€€€€"' } });
    const last = onState.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ bytes: 14, overLimit: true, valid: false });
    expect(last.value).toBe("€€€€");
    const size = page().getByText(/over the limit by 4 B/);
    expect(size.className).toContain("is-over");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("meter")!.getAttribute("max")).toBe("10");
  });

  it("jsonEditorState treats empty text per allowEmpty", () => {
    expect(jsonEditorState("  ", { allowEmpty: true })).toMatchObject({
      valid: true,
      value: undefined,
      error: null,
    });
    expect(jsonEditorState("").valid).toBe(false);
  });
});
