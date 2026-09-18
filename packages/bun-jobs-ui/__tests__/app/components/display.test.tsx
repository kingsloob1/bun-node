import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import { ApiError } from "../../../app/api/errors";
import { COPY_FEEDBACK_MS } from "../../../app/components/copy";
import { CopyButton } from "../../../app/components/CopyButton";
import { KeyValue } from "../../../app/components/KeyValue";
import { ProblemBanner } from "../../../app/components/ProblemBanner";
import { act, fireEvent, page, render, setupDom } from "../dom";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

describe("ProblemBanner", () => {
  it("shows an ApiError's title, code, status, detail, context and issues", () => {
    const onRetry = mock(() => {});
    const onDismiss = mock(() => {});
    render(
      <ProblemBanner
        error={
          new ApiError({
            kind: "problem",
            status: 409,
            code: "LIMITS_CONTENDED",
            title: "Limits contended",
            detail: "Another writer changed the limits.",
            context: { queue: "emails", attempts: 3 },
            issues: [{ target: "body", path: "rate", message: "Too high" }],
          })
        }
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    const alert = page().getByRole("alert");
    expect(alert.textContent).toContain("Limits contended");
    expect(alert.textContent).toContain("LIMITS_CONTENDED · 409");
    expect(alert.textContent).toContain("Another writer changed the limits.");
    const context = page().getByRole("list", { name: "Context" });
    expect(context.textContent).toBe("queue=emailsattempts=3");
    expect(alert.textContent).toContain("body.rate Too high");
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    fireEvent.click(page().getByRole("button", { name: "Dismiss" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a plain error's message under a title override", () => {
    render(
      <ProblemBanner
        error={new Error("boom")}
        title="Could not save"
      />,
    );
    const alert = page().getByRole("alert");
    expect(alert.textContent).toBe("Could not saveboom");
  });
});

describe("KeyValue", () => {
  it("renders label/value rows, skipping falsy items and dashing empty values", () => {
    render(
      <KeyValue
        items={[
          { label: "State", value: <strong>failed</strong> },
          false,
          { label: "Worker", value: null },
          { label: "Attempts", value: 2, hint: "of 5" },
        ]}
      />,
    );
    const terms = Array.from(document.querySelectorAll("dt")).map(
      (dt) => dt.textContent,
    );
    const values = Array.from(document.querySelectorAll("dd")).map(
      (dd) => dd.textContent,
    );
    expect(terms).toEqual(["State", "Worker", "Attempts"]);
    expect(values).toEqual(["failed", "—", "2of 5"]);
    expect(document.querySelector("dl")!.className).toBe("kv kv-grid");
  });
});

describe("CopyButton", () => {
  it("copies, confirms, then resets after the feedback delay", async () => {
    jest.useFakeTimers();
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const onCopied = mock((_ok: boolean) => {});
    render(
      <CopyButton
        text="job-42"
        ariaLabel="Copy job id"
        onCopied={onCopied}
      />,
    );
    const button = page().getByRole("button", { name: "Copy job id" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("job-42");
    expect(onCopied).toHaveBeenCalledWith(true);
    expect(button.textContent).toBe("Copied");
    act(() => {
      jest.advanceTimersByTime(COPY_FEEDBACK_MS);
    });
    expect(button.textContent).toBe("Copy");
  });

  it("reports failure when there is no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<CopyButton text="x" />);
    const button = page().getByRole("button", { name: "Copy" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.textContent).toBe("Copy failed");
  });
});
