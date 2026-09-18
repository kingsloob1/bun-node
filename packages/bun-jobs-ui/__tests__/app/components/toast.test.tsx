import type { ToastApi } from "../../../app/components/toast";
import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import { TOAST_DURATION_MS, useToast } from "../../../app/components/toast";
import { ToastProvider } from "../../../app/components/ToastProvider";
import { act, fireEvent, page, render, setupDom } from "../dom";

// Registered ahead of setupDom()'s hooks, which run in order and need
// real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** Renders a provider and hands back its API. */
function renderToasts(max?: number): { api: ToastApi } {
  const holder: { api: ToastApi | null } = { api: null };
  function Grab() {
    holder.api = useToast();
    return null;
  }
  render(
    <ToastProvider max={max}>
      <Grab />
    </ToastProvider>,
  );
  return { api: holder.api! };
}

/** The polite and assertive live regions. */
function regions() {
  return {
    polite: document.querySelector<HTMLElement>('[aria-live="polite"]')!,
    assertive: document.querySelector<HTMLElement>('[aria-live="assertive"]')!,
  };
}

describe("toasts", () => {
  it("render into live regions present from the start: success/info polite, errors assertive", () => {
    const { api } = renderToasts();
    const { polite, assertive } = regions();
    expect(polite.children).toHaveLength(0);
    expect(assertive.children).toHaveLength(0);
    act(() => {
      api.success("Queue paused", { description: "emails" });
      api.info("Heads up");
      api.error("Could not drain", { description: "QUEUE_NOT_FOUND" });
    });
    expect(polite.textContent).toContain("Queue paused");
    expect(polite.textContent).toContain("emails");
    expect(polite.textContent).toContain("Heads up");
    expect(assertive.textContent).toContain("Could not drain");
    expect(polite.textContent).not.toContain("Could not drain");
  });

  it("auto-dismiss, errors later than the rest", () => {
    jest.useFakeTimers();
    const { api } = renderToasts();
    act(() => {
      api.success("Saved");
      api.error("Failed");
    });
    const { polite, assertive } = regions();
    act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS.success - 1);
    });
    expect(polite.textContent).toContain("Saved");
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(polite.textContent).not.toContain("Saved");
    expect(assertive.textContent).toContain("Failed");
    act(() => {
      jest.advanceTimersByTime(
        TOAST_DURATION_MS.error - TOAST_DURATION_MS.success,
      );
    });
    expect(assertive.textContent).not.toContain("Failed");
  });

  it("keep a duration-0 toast until dismissed, via the button or the API", () => {
    jest.useFakeTimers();
    const { api } = renderToasts();
    let id = "";
    act(() => {
      api.info("Sticky", { duration: 0 });
      id = api.info("Also sticky", { duration: 0 });
    });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(regions().polite.textContent).toContain("Sticky");
    act(() => {
      fireEvent.click(
        page().getAllByRole("button", { name: "Dismiss notification" })[0]!,
      );
    });
    expect(regions().polite.children).toHaveLength(1);
    expect(regions().polite.textContent).toContain("Also sticky");
    act(() => api.dismiss(id));
    expect(regions().polite.children).toHaveLength(0);
  });

  it("run an action, then dismiss", () => {
    const { api } = renderToasts();
    const onClick = mock(() => {});
    act(() => {
      api.success("Job removed", { action: { label: "Undo", onClick } });
    });
    fireEvent.click(page().getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(regions().polite.children).toHaveLength(0);
  });

  it("stack up to the limit, dropping the oldest", () => {
    const { api } = renderToasts(2);
    act(() => {
      api.info("one");
      api.info("two");
      api.info("three");
    });
    const text = regions().polite.textContent!;
    expect(text).not.toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
  });

  it("useToast outside a provider fails clearly", () => {
    function Orphan() {
      useToast();
      return null;
    }
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
