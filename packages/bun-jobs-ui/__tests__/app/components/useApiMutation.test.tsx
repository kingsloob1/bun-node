import type { UseApiMutationResult } from "../../../app/hooks/useApiMutation";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, spyOn } from "bun:test";
import { ApiError } from "../../../app/api/errors";
import { ToastProvider } from "../../../app/components/ToastProvider";
import {
  issuesToFieldErrors,
  useApiMutation,
} from "../../../app/hooks/useApiMutation";
import { createQueryClient } from "../../../app/queryClient";
import { act, render, setupDom, waitFor } from "../dom";

setupDom();

/** Variables of the test mutation. */
interface PauseVars {
  /** The queue. */
  queue: string;
}

/** Renders a mutation under the app's providers and hands back its latest result. */
function renderMutation(
  mutationFn: (vars: PauseVars) => Promise<{ paused: boolean }>,
  options: { errorTitle?: string } = {},
) {
  const queryClient = createQueryClient({ retry: false });
  const invalidate = spyOn(queryClient, "invalidateQueries");
  const holder: {
    current: UseApiMutationResult<{ paused: boolean }, PauseVars> | null;
  } = { current: null };
  function Probe() {
    holder.current = useApiMutation({
      mutationFn,
      successMessage: (data, vars) =>
        data.paused ? `Paused ${vars.queue}` : null,
      invalidate: (_data, vars) => [["queues"], ["queue", vars.queue]],
      errorTitle: options.errorTitle,
    });
    return null;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Probe />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { holder, invalidate };
}

/** TanStack batches observer notifications on a timer; this lets them land inside `act`. */
function settleNotifications(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

/** Text of the polite and assertive toast regions. */
function toastText() {
  return {
    polite: document.querySelector('[aria-live="polite"]')!.textContent ?? "",
    assertive:
      document.querySelector('[aria-live="assertive"]')!.textContent ?? "",
  };
}

describe("useApiMutation", () => {
  it("toasts success and invalidates the given keys", async () => {
    const { holder, invalidate } = renderMutation(async () => ({
      paused: true,
    }));
    await act(async () => {
      await holder.current!.mutateAsync({ queue: "emails" });
      await settleNotifications();
    });
    expect(toastText().polite).toContain("Paused emails");
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ["queues"] },
      { queryKey: ["queue", "emails"] },
    ]);
    expect(holder.current!.fieldErrors).toEqual({});
  });

  it("maps VALIDATION issues to fieldErrors without a toast", async () => {
    const { holder, invalidate } = renderMutation(async () => {
      throw new ApiError({
        kind: "problem",
        status: 400,
        code: "VALIDATION",
        title: "Request validation failed",
        issues: [
          { target: "body", path: "opts.delay", message: "Must be >= 0" },
          { target: "body", path: "opts.delay", message: "Second message" },
          { target: "body", path: "", message: "Body required" },
          { target: "query", path: "total", message: "Must be a boolean" },
        ],
      });
    });
    await act(async () => {
      holder.current!.mutate({ queue: "emails" });
    });
    await waitFor(() => expect(holder.current!.isError).toBe(true));
    expect(holder.current!.fieldErrors).toEqual({
      "opts.delay": "Must be >= 0",
      body: "Body required",
      total: "Must be a boolean",
    });
    expect(toastText()).toEqual({ polite: "", assertive: "" });
    expect(invalidate).not.toHaveBeenCalled();
    // reset() clears them.
    await act(async () => {
      holder.current!.reset();
      await settleNotifications();
    });
    expect(holder.current!.fieldErrors).toEqual({});
  });

  it("toasts any other ApiError's title and detail, assertively", async () => {
    const { holder } = renderMutation(async () => {
      throw new ApiError({
        kind: "problem",
        status: 404,
        code: "QUEUE_NOT_FOUND",
        title: "Queue not found",
        detail: "No queue named emails.",
      });
    });
    await act(async () => {
      holder.current!.mutate({ queue: "emails" });
    });
    await waitFor(() => expect(holder.current!.isError).toBe(true));
    const { polite, assertive } = toastText();
    expect(polite).toBe("");
    expect(assertive).toContain("Queue not found");
    expect(assertive).toContain("No queue named emails.");
    expect(holder.current!.fieldErrors).toEqual({});
  });

  it("prefers errorTitle as the headline, and handles non-API errors", async () => {
    const { holder } = renderMutation(
      async () => {
        throw new Error("socket hang up");
      },
      { errorTitle: "Could not pause queue" },
    );
    await act(async () => {
      holder.current!.mutate({ queue: "emails" });
    });
    await waitFor(() => expect(holder.current!.isError).toBe(true));
    const { assertive } = toastText();
    expect(assertive).toContain("Could not pause queue");
    expect(assertive).toContain("socket hang up");
  });
});

describe("issuesToFieldErrors", () => {
  it("strips the target and keeps the first message per path", () => {
    expect(
      issuesToFieldErrors([
        { target: "body", path: "data.to", message: "Required" },
        { target: "params", path: "", message: "Bad params" },
      ]),
    ).toEqual({ "data.to": "Required", params: "Bad params" });
  });
});
