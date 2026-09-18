import type { TabItem } from "../../../app/components/Tabs";
import { describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { Tabs, UrlTabs } from "../../../app/components/Tabs";
import { useUrlTab } from "../../../app/hooks/useUrlTab";
import { RouterProvider } from "../../../app/router";
import { act, fireEvent, page, render, setupDom, visit } from "../dom";

setupDom();

type State = "waiting" | "active" | "failed" | "completed";

const TABS: readonly TabItem<State>[] = [
  { value: "waiting", label: "Waiting", count: 3 },
  { value: "active", label: "Active", count: 0 },
  { value: "failed", label: "Failed", count: 1234, disabled: false },
  { value: "completed", label: "Completed", disabled: true },
];

/** Controlled tabs with local state. */
function Controlled({
  onChange,
}: {
  /** Spy. */ onChange?: (v: State) => void;
}) {
  const [value, setValue] = useState<State>("waiting");
  return (
    <Tabs
      tabs={TABS}
      value={value}
      label="Job states"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    >
      <p>Panel for {value}</p>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("renders the tabs pattern with counts and one tab stop", () => {
    render(<Controlled />);
    const list = page().getByRole("tablist", { name: "Job states" });
    expect(list).toBeTruthy();
    const tabs = page().getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(tabs[0]!.textContent).toBe("Waiting3");
    expect(tabs[2]!.querySelector(".tab-count")!.getAttribute("title")).toBe(
      "1234",
    );
    const panel = page().getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0]!.id);
    expect(tabs[0]!.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.textContent).toBe("Panel for waiting");
  });

  it("moves with the arrow keys, wrapping and skipping disabled tabs", () => {
    const onChange = mock((_value: State) => {});
    render(<Controlled onChange={onChange} />);
    const tab = (name: string) =>
      page().getByRole("tab", { name: new RegExp(name) });
    tab("Waiting").focus();
    fireEvent.keyDown(tab("Waiting"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Active"));
    expect(tab("Active").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Active"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Failed"));
    // Completed is disabled: Right from Failed wraps to Waiting.
    fireEvent.keyDown(tab("Failed"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Waiting"));
    fireEvent.keyDown(tab("Waiting"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Failed"));
    fireEvent.keyDown(tab("Failed"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Waiting"));
    fireEvent.keyDown(tab("Waiting"), { key: "End" });
    expect(document.activeElement).toBe(tab("Failed"));
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      "active",
      "failed",
      "waiting",
      "failed",
      "waiting",
      "failed",
    ]);
    expect(page().getByRole("tabpanel").textContent).toBe("Panel for failed");
  });

  it("with manual activation, arrows only move focus", () => {
    const onChange = mock((_value: State) => {});
    render(
      <Tabs
        tabs={TABS}
        value="waiting"
        label="States"
        activation="manual"
        onChange={onChange}
      />,
    );
    const [waiting, active] = page().getAllByRole("tab");
    waiting!.focus();
    fireEvent.keyDown(waiting!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(active!);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(active!);
    expect(onChange).toHaveBeenCalledWith("active");
    // No children: no panel.
    expect(page().queryByRole("tabpanel")).toBeNull();
  });
});

describe("UrlTabs", () => {
  /** URL tabs plus a readout of the value the screen would use. */
  function UrlHarness() {
    const state = useUrlTab("state", TABS, "waiting");
    return (
      <UrlTabs
        tabs={TABS}
        label="Job states"
        param="state"
        defaultValue="waiting"
        resetParams={["offset"]}
      >
        <p>Showing {state}</p>
      </UrlTabs>
    );
  }

  function renderAt(url: string) {
    visit(url);
    return render(
      <RouterProvider basePath="/jobs">
        <UrlHarness />
      </RouterProvider>,
    );
  }

  it("reads the tab from the query string", () => {
    renderAt("/jobs/queues/emails?state=failed&name=send");
    expect(
      page()
        .getByRole("tab", { name: /Failed/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(page().getByRole("tabpanel").textContent).toBe("Showing failed");
  });

  it("falls back to the default for a missing or unknown value", () => {
    renderAt("/jobs/queues/emails?state=bogus");
    expect(page().getByRole("tabpanel").textContent).toBe("Showing waiting");
  });

  it("writes the tab with replace, keeps other params and drops resetParams", () => {
    renderAt("/jobs/queues/emails?name=send&offset=40");
    const before = window.history.length;
    act(() => {
      fireEvent.click(page().getByRole("tab", { name: /Active/ }));
    });
    expect(window.location.pathname).toBe("/jobs/queues/emails");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("state")).toBe("active");
    expect(params.get("name")).toBe("send");
    expect(params.has("offset")).toBe(false);
    expect(window.history.length).toBe(before);
    expect(page().getByRole("tabpanel").textContent).toBe("Showing active");
    // Back to the default removes the parameter.
    act(() => {
      fireEvent.click(page().getByRole("tab", { name: /Waiting/ }));
    });
    expect(window.location.search).toBe("?name=send");
  });
});
