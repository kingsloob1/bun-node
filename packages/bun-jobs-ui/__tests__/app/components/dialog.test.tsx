import { describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { ApiError } from "../../../app/api/errors";
import { ConfirmDialog } from "../../../app/components/ConfirmDialog";
import { Dialog } from "../../../app/components/Dialog";
import { act, fireEvent, page, render, setupDom, waitFor } from "../dom";

setupDom();

/** A button that opens a dialog with two inputs and a footer button. */
function Harness({
  closeOnEscape,
  closeOnBackdrop,
}: {
  /** Passed through. */
  closeOnEscape?: boolean;
  /** Passed through. */
  closeOnBackdrop?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
      >
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Edit limits"
        description="Changes apply to every worker."
        closeOnEscape={closeOnEscape}
        closeOnBackdrop={closeOnBackdrop}
        footer={
          <button
            type="button"
            onClick={() => setOpen(false)}
          >
            Save
          </button>
        }
      >
        <input aria-label="First" />
        <input aria-label="Second" />
      </Dialog>
    </>
  );
}

/** Opens the harness dialog from its button, which then has focus. */
function openHarness(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
  const opener = page().getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe("Dialog", () => {
  it("is a modal labelled by its title and described by its description", () => {
    openHarness();
    const dialog = page().getByRole("dialog", { name: "Edit limits" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const describedBy = dialog.getAttribute("aria-describedby")!;
    expect(document.getElementById(describedBy)!.textContent).toBe(
      "Changes apply to every worker.",
    );
    expect((dialog as HTMLDialogElement).open).toBe(true);
  });

  it("focuses the first body control on open", () => {
    openHarness();
    expect(document.activeElement).toBe(page().getByLabelText("First"));
  });

  it("traps Tab and Shift+Tab inside", () => {
    openHarness();
    const dialog = page().getByRole("dialog");
    const close = page().getByRole("button", { name: "Close" });
    const save = page().getByRole("button", { name: "Save" });
    // DOM order: Close (header), First, Second, Save (footer).
    save.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    // In the middle, Tab is left to the browser.
    page().getByLabelText("First").focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    page().getByLabelText("First").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("closes on Escape and restores focus to the opener", () => {
    const opener = openHarness();
    fireEvent.keyDown(page().getByRole("dialog"), { key: "Escape" });
    expect(page().queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a backdrop click but not a click inside", () => {
    openHarness();
    fireEvent.click(page().getByLabelText("First"));
    expect(page().queryByRole("dialog")).not.toBeNull();
    fireEvent.click(page().getByRole("dialog"));
    expect(page().queryByRole("dialog")).toBeNull();
  });

  it("can refuse Escape and the backdrop", () => {
    openHarness({ closeOnEscape: false, closeOnBackdrop: false });
    const dialog = page().getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(dialog);
    expect(page().queryByRole("dialog")).not.toBeNull();
    fireEvent.click(page().getByRole("button", { name: "Close" }));
    expect(page().queryByRole("dialog")).toBeNull();
  });
});

describe("ConfirmDialog", () => {
  it("keeps Confirm disabled until the typed confirmation matches", async () => {
    const onConfirm = mock(() => {});
    const onClose = mock(() => {});
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Drain queue emails?"
        variant="danger"
        confirmLabel="Drain"
        confirmText="emails"
        onConfirm={onConfirm}
      />,
    );
    const dialog = page().getByRole("alertdialog", {
      name: "Drain queue emails?",
    });
    expect(dialog).toBeTruthy();
    const input = page().getByLabelText("Type emails to confirm");
    expect(document.activeElement).toBe(input);
    const drain = page().getByRole("button", { name: "Drain" });
    expect((drain as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "email" } });
    expect((drain as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "emails" } });
    expect((drain as HTMLButtonElement).disabled).toBe(false);
    expect(drain.className).toContain("btn-danger");
    await act(async () => {
      fireEvent.click(drain);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows a pending state for an async confirm, then closes", async () => {
    let resolve!: () => void;
    const onClose = mock(() => {});
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Pause queue?"
        confirmLabel="Pause"
        onConfirm={() =>
          new Promise<void>((done) => {
            resolve = done;
          })
        }
      />,
    );
    fireEvent.click(page().getByRole("button", { name: "Pause" }));
    const pending = await waitFor(() =>
      page().getByRole("button", { name: "Pause…" }),
    );
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
    const cancel = page().getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    // Escape is ignored while pending.
    fireEvent.keyDown(page().getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("shows a failed confirm's ApiError inline and stays open", async () => {
    const onClose = mock(() => {});
    const onConfirm = mock(async () => {
      throw new ApiError({
        kind: "problem",
        status: 409,
        code: "JOB_ACTIVE",
        title: "Job is active",
        detail: "Job 42 is being processed.",
        context: { queue: "emails" },
      });
    });
    render(
      <ConfirmDialog
        open
        onClose={onClose}
        title="Remove job?"
        variant="danger"
        confirmLabel="Remove"
        onConfirm={onConfirm}
      />,
    );
    // A danger dialog without typed confirmation focuses Cancel first.
    expect(document.activeElement).toBe(
      page().getByRole("button", { name: "Cancel" }),
    );
    await act(async () => {
      fireEvent.click(page().getByRole("button", { name: "Remove" }));
    });
    const alert = await waitFor(() => page().getByRole("alert"));
    expect(alert.textContent).toContain("Job is active");
    expect(alert.textContent).toContain("JOB_ACTIVE");
    expect(alert.textContent).toContain("Job 42 is being processed.");
    expect(alert.textContent).toContain("queue=emails");
    expect(onClose).not.toHaveBeenCalled();
    // Retrying is possible: the button is enabled again.
    const remove = page().getByRole("button", { name: "Remove" });
    expect((remove as HTMLButtonElement).disabled).toBe(false);
  });

  it("submits on Enter in the typed confirmation", async () => {
    const onConfirm = mock(() => {});
    render(
      <ConfirmDialog
        open
        onClose={() => {}}
        title="Clean?"
        confirmText="q"
        onConfirm={onConfirm}
      />,
    );
    const input = page().getByLabelText("Type q to confirm");
    fireEvent.change(input, { target: { value: "q" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(
      <ConfirmDialog
        open={false}
        onClose={() => {}}
        title="Hidden"
        onConfirm={() => {}}
      />,
    );
    expect(page().queryByRole("dialog")).toBeNull();
  });
});
