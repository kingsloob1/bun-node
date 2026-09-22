import type {
  RunnerConfigBody,
  RunnerConfigDto,
  RunnerInfoDto,
} from "../../../../app/api/types";
import {
  EXECUTION_MODES,
  RUNNER_CONFIG_BOUNDS,
} from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import { formatNumber } from "../../../../app/format";
import { RunnerSummary } from "../../../../app/screens/runners/RunnerScreen";
import { fireEvent, page, render, setupDom, waitFor, within } from "../../dom";
import { problem } from "../../fixtures";
import {
  actionNames,
  callTo,
  dialogButton,
  NOW,
  openAction,
  openDialog,
  renderActions,
  runnerFixture,
  toastSays,
} from "./fixtures";

setupDom();

const PATH = "/runners/nightly/config";

/** A runner configuration: every key overridden, adopted, with the code's own values beside it. */
function configFixture(
  overrides: Partial<RunnerConfigDto> = {},
): RunnerConfigDto {
  return {
    effective: {
      executionMode: "worker",
      runMode: "parallel",
      maxConcurrency: 4,
    },
    code: {
      executionMode: "spawn",
      runMode: "single",
      maxConcurrency: null,
    },
    overridden: ["executionMode", "runMode", "maxConcurrency"],
    seq: 3,
    appliedSeq: 3,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

/** A runner that reports a configuration. */
function configurable(
  config: Partial<RunnerConfigDto> = {},
  runner: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  return runnerFixture({ config: configFixture(config), ...runner });
}

/** A configuration with nothing overridden: the code's values, in force. */
function unoverridden(
  overrides: Partial<RunnerConfigDto> = {},
): Partial<RunnerConfigDto> {
  return {
    effective: {
      executionMode: "spawn",
      runMode: "parallel",
      maxConcurrency: 4,
    },
    code: {
      executionMode: "spawn",
      runMode: "parallel",
      maxConcurrency: 4,
    },
    overridden: [],
    seq: 0,
    ...overrides,
  };
}

/** The body sent to the config route. */
function sentConfig(
  calls: Awaited<ReturnType<typeof renderActions>>["calls"],
): RunnerConfigBody | undefined {
  const call = callTo(calls, "PUT", PATH);
  return call ? (JSON.parse(call.body!) as RunnerConfigBody) : undefined;
}

/** Answers the `PUT` with a configuration, so a save can succeed. */
function saveHandler(config: Partial<RunnerConfigDto> = {}) {
  return { [`PUT ${PATH}`]: { body: configFixture(config) } };
}

/** A control in the dialog, by its field label. */
function control(dialog: HTMLElement, label: string): HTMLInputElement {
  return within(dialog).getByLabelText(label) as HTMLInputElement;
}

/** Sets a control's value. */
function set(dialog: HTMLElement, label: string, value: string): void {
  fireEvent.change(control(dialog, label), { target: { value } });
}

/** The field's row (label, control, hint and error). */
function field(dialog: HTMLElement, label: string): HTMLElement {
  return control(dialog, label).closest(".field") as HTMLElement;
}

/**
 * `runners.configure` as a host that opted in answers it. The shared
 * permissions fixture prunes every opt-in action, so each test that expects
 * the editor grants it explicitly.
 */
const CONFIGURE_GRANTED = { "runners.configure": true } as const;

/** Opens the settings dialog of a configurable runner the caller may configure. */
async function openSettings(options: Parameters<typeof renderActions>[0] = {}) {
  const rendered = await renderActions({
    runner: configurable(),
    ...options,
    scoped: { ...CONFIGURE_GRANTED, ...options.scoped },
  });
  return { ...rendered, dialog: await openAction("Settings…") };
}

describe("whether the settings editor is offered", () => {
  it("offers Settings… for a configurable runner the caller may configure", async () => {
    await renderActions({
      runner: configurable(),
      scoped: { ...CONFIGURE_GRANTED },
    });
    expect(actionNames()).toContain("Settings…");
  });

  it("is absent without the opt-in runners.configure action", async () => {
    // The action is opt-in: a host that does not list it in `actions` has it
    // pruned from the map, which is the normal case, not a failure.
    await renderActions({
      runner: configurable(),
      permissions: { "runners.configure": undefined },
      scoped: { "runners.configure": undefined },
    });
    expect(actionNames()).not.toContain("Settings…");
  });

  it("is absent when the runner-scoped map denies it", async () => {
    await renderActions({
      runner: configurable(),
      permissions: { ...CONFIGURE_GRANTED },
      scoped: { "runners.configure": false },
    });
    expect(actionNames()).not.toContain("Settings…");
  });

  it("is absent on a read-only API", async () => {
    await renderActions({
      runner: configurable(),
      meta: { readOnly: true },
      scoped: { ...CONFIGURE_GRANTED },
    });
    expect(actionNames()).not.toContain("Settings…");
  });

  it("is absent for a runner that reports no config at all", async () => {
    await renderActions({
      runner: runnerFixture(),
      scoped: { ...CONFIGURE_GRANTED },
    });
    expect(actionNames()).not.toContain("Settings…");
  });

  it("is offered for a remote runner: configuring is not a local-only action", async () => {
    const { local: _local, ...remote } = configurable({}, { isLocal: false });
    await renderActions({ runner: remote, scoped: { ...CONFIGURE_GRANTED } });
    expect(actionNames()).toContain("Settings…");
  });
});

describe("the settings editor: what it shows", () => {
  it("prefills what is in force and names what the code asks for", async () => {
    const { dialog } = await openSettings();
    expect(control(dialog, "Execution mode").value).toBe("worker");
    expect(control(dialog, "Run mode").value).toBe("parallel");
    expect(control(dialog, "Max concurrency").value).toBe("4");
    expect(field(dialog, "Execution mode").textContent).toContain(
      "code asks for spawn",
    );
    expect(field(dialog, "Run mode").textContent).toContain(
      "code asks for single",
    );
    expect(field(dialog, "Max concurrency").textContent).toContain(
      "code asks for unlimited",
    );
  });

  it("says which settings are overridden and which follow the code", async () => {
    const { dialog } = await openSettings({
      runner: configurable({
        overridden: ["executionMode"],
      }),
    });
    expect(
      within(dialog).getByTestId("config-source-execution-mode").textContent,
    ).toContain("overridden here");
    expect(
      within(dialog).getByTestId("config-source-concurrency").textContent,
    ).toContain("as the runner's code asks");
  });

  it("disables the cap under single, and says empty means unlimited in parallel", async () => {
    const { dialog } = await openSettings();
    expect(field(dialog, "Max concurrency").textContent).toContain(
      "Empty means unlimited",
    );
    set(dialog, "Run mode", "single");
    expect(control(dialog, "Max concurrency").disabled).toBe(true);
    expect(field(dialog, "Max concurrency").textContent).toContain(
      "Only applies in parallel",
    );
  });

  it("offers every execution mode the contract names, in its order", async () => {
    const { dialog } = await openSettings();
    const options = Array.from(
      control(dialog, "Execution mode").querySelectorAll("option"),
      (option) => option.getAttribute("value"),
    );
    // Built from EXECUTION_MODES, not a list restated here: a mode the API
    // gains reaches the picker without an edit to the UI.
    expect(options).toEqual([...EXECUTION_MODES]);
  });

  it("offers only the modes the runner's code allows, and says why the rest are absent", async () => {
    const { dialog } = await openSettings({
      runner: configurable({ allowed: ["worker", "in-process"] }),
    });
    const options = Array.from(
      control(dialog, "Execution mode").querySelectorAll("option"),
      (option) => option.getAttribute("value"),
    );
    expect(options).toEqual(["worker", "in-process"]);
    const note = within(dialog).getByTestId("config-modes-limited");
    expect(note.textContent).toContain("spawn");
    expect(note.textContent).toContain("remoteConfig.executionModes");
    expect(note.textContent).toContain("CONFIG_NOT_ALLOWED");
  });

  it("keeps the mode in force selectable even when the code no longer allows it", async () => {
    const { dialog } = await openSettings({
      runner: configurable({ allowed: ["spawn"] }),
    });
    const options = Array.from(
      control(dialog, "Execution mode").querySelectorAll("option"),
      (option) => option.getAttribute("value"),
    );
    expect(options).toEqual(["worker", "spawn"]);
  });

  it("shows an override the owner has not adopted yet as pending", async () => {
    const { dialog } = await openSettings({
      runner: configurable({ seq: 4, appliedSeq: 2 }),
    });
    const pending = within(dialog).getByTestId("config-pending");
    expect(pending.textContent).toContain("version 4");
    expect(pending.textContent).toContain("owner is on version 2");
  });

  it("treats a stored override no owner has reported on as pending", async () => {
    const { dialog } = await openSettings({
      runner: configurable({ seq: 1, appliedSeq: undefined }),
    });
    expect(within(dialog).getByTestId("config-pending")).toBeTruthy();
  });

  it("shows nothing pending once the owner is on the stored version", async () => {
    const { dialog } = await openSettings();
    expect(within(dialog).queryByTestId("config-pending")).toBeNull();
  });

  it("shows the owner's refusal", async () => {
    const { dialog } = await openSettings({
      runner: configurable({
        error: {
          at: NOW - 30_000,
          message: "worker mode needs a bundled file",
        },
      }),
    });
    expect(within(dialog).getByTestId("config-refused").textContent).toContain(
      "worker mode needs a bundled file",
    );
  });
});

describe("the settings editor: the warnings", () => {
  it("says an execution mode change applies from the next run", async () => {
    const { dialog } = await openSettings();
    expect(
      within(dialog).queryByTestId("config-warning-execution-mode"),
    ).toBeNull();
    set(dialog, "Execution mode", "in-process");
    expect(
      within(dialog).getByTestId("config-warning-execution-mode").textContent,
    ).toContain("keeps the mode it started with");
  });

  it("says parallel → single is not immediate, and suggests pausing first", async () => {
    const { dialog } = await openSettings();
    set(dialog, "Run mode", "single");
    const warning = within(dialog).getByTestId("config-warning-to-single");
    expect(warning.textContent).toContain("not immediate across processes");
    expect(warning.textContent).toContain("Pause the runner first");
  });

  it("says a lowered cap only gates new runs", async () => {
    const { dialog } = await openSettings();
    set(dialog, "Max concurrency", "2");
    expect(
      within(dialog).getByTestId("config-warning-lower-concurrency")
        .textContent,
    ).toContain("only gates new runs");
  });

  it("does not warn about a raised cap", async () => {
    const { dialog } = await openSettings();
    set(dialog, "Max concurrency", "9");
    expect(
      within(dialog).queryByTestId("config-warning-lower-concurrency"),
    ).toBeNull();
  });

  it("warns about the code's values when an override is dropped", async () => {
    // The code asks for spawn and single: dropping both overrides changes
    // the execution mode and turns overlap off, so both warnings apply.
    const { dialog } = await openSettings();
    fireEvent.click(
      within(
        within(dialog).getByTestId("config-source-execution-mode"),
      ).getByRole("button", { name: "Use the code default" }),
    );
    fireEvent.click(
      within(within(dialog).getByTestId("config-source-concurrency")).getByRole(
        "button",
        { name: "Use the code default" },
      ),
    );
    expect(
      within(dialog).getByTestId("config-warning-execution-mode").textContent,
    ).toContain("spawn applies from the next run");
    expect(within(dialog).getByTestId("config-warning-to-single")).toBeTruthy();
  });
});

describe("the settings editor: saving", () => {
  it("sends only what changed, as a merge patch, and invalidates", async () => {
    const { calls, invalidated, dialog } = await openSettings({
      handlers: saveHandler(),
    });
    set(dialog, "Execution mode", "in-process");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    const call = callTo(calls, "PUT", PATH)!;
    expect(call.headers["content-type"]).toBe("application/json");
    expect(sentConfig(calls)).toEqual({ executionMode: "in-process" });
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("sends runMode and the cap together when either changes", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    set(dialog, "Max concurrency", "9");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({
      concurrency: { runMode: "parallel", maxConcurrency: 9 },
    });
  });

  it("sends a null cap for an empty field (unlimited)", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    set(dialog, "Max concurrency", "");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({
      concurrency: { runMode: "parallel", maxConcurrency: null },
    });
  });

  it("drops the cap from a single-mode patch, where it means nothing", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    set(dialog, "Run mode", "single");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({ concurrency: { runMode: "single" } });
  });

  it("sends null for one setting reset to the code's default", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    fireEvent.click(
      within(
        within(dialog).getByTestId("config-source-execution-mode"),
      ).getByRole("button", { name: "Use the code default" }),
    );
    expect(control(dialog, "Execution mode").value).toBe("spawn");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({ executionMode: null });
  });

  it("pins a setting that followed the code once it is chosen", async () => {
    const { calls, dialog } = await openSettings({
      runner: configurable(unoverridden()),
      handlers: saveHandler(),
    });
    set(dialog, "Execution mode", "worker");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({ executionMode: "worker" });
  });

  it("cannot be saved with nothing changed", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    expect(dialogButton(dialog, "Save settings").disabled).toBe(true);
    set(dialog, "Max concurrency", "9");
    expect(dialogButton(dialog, "Save settings").disabled).toBe(false);
    set(dialog, "Max concurrency", "4");
    expect(dialogButton(dialog, "Save settings").disabled).toBe(true);
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
  });

  it("refuses a cap outside the range the API accepts, and sends nothing", async () => {
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    const { min, max } = RUNNER_CONFIG_BOUNDS.maxConcurrency;
    // The field is built from the contract's own bounds, so the input carries
    // them and the message names them.
    expect(control(dialog, "Max concurrency").getAttribute("min")).toBe(
      String(min),
    );
    expect(control(dialog, "Max concurrency").getAttribute("max")).toBe(
      String(max),
    );
    set(dialog, "Max concurrency", String(max + 1));
    fireEvent.click(dialogButton(dialog, "Save settings"));
    expect(field(dialog, "Max concurrency").textContent).toContain(
      `Between ${min} and ${formatNumber(max)}`,
    );
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
    set(dialog, "Max concurrency", String(min - 1));
    fireEvent.click(dialogButton(dialog, "Save settings"));
    expect(field(dialog, "Max concurrency").textContent).toContain(
      `Between ${min} and ${formatNumber(max)}`,
    );
    expect(callTo(calls, "PUT", PATH)).toBeUndefined();
  });

  it("does not cap unlimited: an empty field sends maxConcurrency null", async () => {
    // The ceiling is the API's cap on a *remote* number. `null` asks for
    // unlimited, which the route does not bound — and in-code config is not
    // bounded at all.
    const { calls, dialog } = await openSettings({ handlers: saveHandler() });
    set(dialog, "Max concurrency", "");
    expect(field(dialog, "Max concurrency").textContent).not.toContain(
      "Between",
    );
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("Saved the settings of nightly");
    expect(sentConfig(calls)).toEqual({
      concurrency: { runMode: "parallel", maxConcurrency: null },
    });
  });

  it("says the owner has not adopted the save yet, when the answer says so", async () => {
    const { dialog } = await openSettings({
      handlers: saveHandler({ seq: 4, appliedSeq: 3 }),
    });
    set(dialog, "Execution mode", "in-process");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    await toastSays("its owner adopts them at its next sync");
  });
});

describe("the settings editor: resetting every override", () => {
  it("sends DELETE, toasts and invalidates", async () => {
    const { calls, invalidated, dialog } = await openSettings({
      handlers: {
        [`DELETE ${PATH}`]: { body: configFixture(unoverridden()) },
      },
    });
    fireEvent.click(dialogButton(dialog, "Reset to code defaults"));
    await toastSays("Reset nightly to its code defaults");
    expect(callTo(calls, "DELETE", PATH)).toBeTruthy();
    expect(callTo(calls, "DELETE", PATH)!.body).toBeUndefined();
    expect(invalidated).toEqual([["runner", "nightly"], ["runners"]]);
    await waitFor(() => expect(openDialog()).toBeNull());
  });

  it("is absent when nothing is overridden", async () => {
    const { dialog } = await openSettings({
      runner: configurable(unoverridden()),
    });
    expect(
      within(dialog).queryByRole("button", { name: "Reset to code defaults" }),
    ).toBeNull();
  });
});

describe("the settings editor: failures", () => {
  it("explains a mode the runner's code does not permit", async () => {
    const { dialog } = await openSettings({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 409,
          body: problem(
            409,
            "CONFIG_NOT_ALLOWED",
            "Configuration is not allowed",
          ),
        },
      },
    });
    set(dialog, "Execution mode", "in-process");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    const banner = await within(dialog).findByRole("alert");
    expect(banner.textContent).toContain("CONFIG_NOT_ALLOWED");
    expect(banner.textContent).toContain("remoteConfig.executionModes");
    expect(openDialog()).not.toBeNull();
  });

  it("explains a runner that cannot be configured remotely", async () => {
    const { dialog } = await openSettings({
      handlers: {
        [`PUT ${PATH}`]: {
          status: 409,
          body: problem(
            409,
            "RUNNER_NOT_CONFIGURABLE",
            "Runner cannot be configured remotely",
          ),
        },
      },
    });
    set(dialog, "Execution mode", "in-process");
    fireEvent.click(dialogButton(dialog, "Save settings"));
    const banner = await within(dialog).findByRole("alert");
    expect(banner.textContent).toContain("since remote configuration shipped");
  });

  it("shows a failed reset in the dialog too", async () => {
    const { dialog } = await openSettings({
      handlers: {
        [`DELETE ${PATH}`]: {
          status: 409,
          body: problem(
            409,
            "RUNNER_NOT_CONFIGURABLE",
            "Runner cannot be configured remotely",
          ),
        },
      },
    });
    fireEvent.click(dialogButton(dialog, "Reset to code defaults"));
    const banner = await within(dialog).findByRole("alert");
    expect(banner.textContent).toContain("RUNNER_NOT_CONFIGURABLE");
  });
});

describe("the runner summary's override rows", () => {
  /** A summary row's `dd` text, by its label. */
  function summaryValue(label: string): string | null {
    const row = Array.from(
      document.querySelectorAll(".runner-summary .kv-row"),
    ).find((candidate) => candidate.querySelector("dt")?.textContent === label);
    return row ? (row.querySelector("dd")?.textContent ?? "") : null;
  }

  it("marks each overridden setting and names the code's value", () => {
    render(
      <RunnerSummary
        runner={configurable({ overridden: ["executionMode"] })}
      />,
    );
    expect(summaryValue("Execution mode")).toContain(
      "Overridden here; its code asks for spawn",
    );
    expect(summaryValue("Run mode")).not.toContain("Overridden");
    expect(summaryValue("Settings override")).toBe("Execution mode");
  });

  it("says an override the owner refused is not in force, and keeps the adopted ones as overrides", () => {
    // The owner dropped `executionMode` (it cannot run a child without a
    // driver config) and adopted run mode and concurrency: `overridden`
    // names all three, but the execution mode still runs the code's value.
    render(
      <RunnerSummary
        runner={configurable(
          unoverridden({
            effective: {
              executionMode: "spawn",
              runMode: "single",
              maxConcurrency: 4,
            },
            overridden: ["executionMode", "runMode"],
            seq: 3,
            appliedSeq: 3,
            error: {
              at: 1,
              message: 'executionMode "worker" needs a driver config',
            },
          }),
        )}
      />,
    );
    expect(summaryValue("Execution mode")).toContain(
      "Override refused by the owner",
    );
    expect(summaryValue("Execution mode")).not.toContain("Overridden here");
    // Run mode was adopted: it differs from the code's, so it IS in force.
    expect(summaryValue("Run mode")).toContain("Overridden here");
  });

  it("says when nothing is overridden", () => {
    render(<RunnerSummary runner={configurable(unoverridden())} />);
    expect(summaryValue("Settings override")).toBe(
      "None: as the runner's code asks",
    );
  });

  it("shows a pending adoption, and a refusal in its place", () => {
    const { rerender } = render(
      <RunnerSummary runner={configurable({ seq: 5, appliedSeq: 4 })} />,
    );
    expect(summaryValue("Settings override")).toContain(
      "Version 5 has not been adopted yet",
    );
    rerender(
      <RunnerSummary
        runner={configurable({
          error: { at: NOW, message: "in-process is not permitted here" },
        })}
      />,
    );
    expect(summaryValue("Settings override")).toContain(
      "in-process is not permitted here",
    );
  });

  it("has no override row for a runner that reports no config", () => {
    render(<RunnerSummary runner={runnerFixture()} />);
    expect(summaryValue("Settings override")).toBeNull();
    expect(page().queryByTestId("runner-config-override")).toBeNull();
  });
});
