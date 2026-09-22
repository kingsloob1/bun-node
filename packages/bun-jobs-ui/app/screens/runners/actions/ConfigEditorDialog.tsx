import type { FormEvent } from "react";
import type { RunnerConfigBody, RunnerConfigDto } from "../../../api/types";
import type { ConfigForm } from "./config";
import type { RunnerDialogProps } from "./TriggerDialog";
import { useId, useState } from "react";
import { configureRunner, resetRunnerConfig } from "../../../api/runnerActions";
import { runnerInvalidations } from "../../../api/runners";
import { Button } from "../../../components/Button";
import { Dialog } from "../../../components/Dialog";
import { Field } from "../../../components/Field";
import { NumberInput, Select } from "../../../components/inputs";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { RelativeTime } from "../../../components/RelativeTime";
import { useApiClient } from "../../../context";
import { useApiMutation } from "../../../hooks/useApiMutation";
import {
  availableModes,
  codeValue,
  CONCURRENCY_BOUNDS,
  configBody,
  configWarnings,
  describeRefused,
  EXECUTION_MODE_LABELS,
  formFromConfig,
  hasConfigChanges,
  pendingAdoption,
  RUN_MODES,
  unavailableModes,
  validateConfigForm,
} from "./config";
import { explained } from "./explain";

/** Props of {@link ConfigEditorDialog}. */
export interface ConfigEditorDialogProps extends RunnerDialogProps {
  /**
   * The runner's configuration, as `GET /runners/:runner` returned it. It is
   * required rather than read off the runner: the Settings… button is offered
   * only for a runner that carries one, so there is nothing to invent here.
   */
  config: RunnerConfigDto;
}

/**
 * `PUT` / `DELETE /runners/:runner/config`: the runner's execution mode and
 * its overlap settings, with what its own code asked for beside them.
 *
 * Saving sends a **merge patch** of what changed, so an untouched setting is
 * never restated; "Use the code default" marks one setting to be cleared on
 * save (`null`), and "Reset to code defaults" is the `DELETE`, which drops
 * every override at once.
 */
export function ConfigEditorDialog({
  runner,
  config,
  onClose,
}: ConfigEditorDialogProps) {
  const api = useApiClient();
  const formId = useId();
  const [form, setForm] = useState<ConfigForm>(() => formFromConfig(config));
  const patch = (next: Partial<ConfigForm>) =>
    setForm((current) => ({ ...current, ...next }));

  const save = useApiMutation({
    mutationFn: (body: RunnerConfigBody) =>
      configureRunner(api, runner.id, body),
    successMessage: (result) =>
      pendingAdoption(result) === null
        ? `Saved the settings of ${runner.id}`
        : `Saved the settings of ${runner.id}; its owner adopts them at its next sync`,
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
    onSuccess: () => onClose(),
  });
  const reset = useApiMutation({
    mutationFn: () => resetRunnerConfig(api, runner.id),
    successMessage: `Reset ${runner.id} to its code defaults`,
    invalidate: runnerInvalidations(runner.id),
    toastErrors: false,
    onSuccess: () => onClose(),
  });

  const pending = save.isPending || reset.isPending;
  const errors = validateConfigForm(form);
  const warnings = configWarnings(form, config);
  const body = configBody(form, config);
  const changed = hasConfigChanges(form, config);
  const adoption = pendingAdoption(config);
  const modes = availableModes(config);
  const missingModes = unavailableModes(config);
  const codeMode = codeValue(config, "executionMode");
  const codeRunMode = codeValue(config, "runMode");
  const codeCap = codeValue(config, "maxConcurrency");
  const failure = save.error ?? reset.error;
  // The mode in force can be one the code no longer permits; keep it
  // selectable so the picker never silently shows a different runner.
  const modeOptions = (
    modes.includes(form.executionMode) ? modes : [form.executionMode, ...modes]
  ).map((mode) => ({ value: mode, label: EXECUTION_MODE_LABELS[mode] }));

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (Object.keys(errors).length > 0 || !changed) {
      return;
    }
    save.mutate(body);
  };

  const close = () => {
    if (!pending) {
      onClose();
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title={
        <>
          Settings of <code>{runner.id}</code>
        </>
      }
      description="Where runs execute and whether they may overlap, for every process running this runner. A setting left to the runner's code follows the code."
      size="md"
      closeOnEscape={!pending}
      closeOnBackdrop={!pending}
      footer={
        <>
          {config.overridden.length > 0 && (
            <Button
              variant="danger"
              onClick={() => reset.mutate()}
              disabled={pending}
              aria-busy={reset.isPending || undefined}
            >
              {reset.isPending ? "Resetting…" : "Reset to code defaults"}
            </Button>
          )}
          <Button
            onClick={close}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            disabled={pending || !changed}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="runner-form"
        onSubmit={onSubmit}
        noValidate
      >
        {adoption !== null && (
          <p
            className="runner-note runner-note-pending"
            role="status"
            data-testid="config-pending"
          >
            The stored settings (version {adoption.seq}) have not been adopted
            yet: the owner is on version {adoption.applied}. They take effect at
            its next sync.
          </p>
        )}
        {config.error !== undefined && (
          <p
            className="runner-note runner-note-refused"
            role="note"
            data-testid="config-refused"
          >
            The owner refused {describeRefused(config) ?? "the stored settings"}{" "}
            <RelativeTime value={config.error.at} />: {config.error.message}
          </p>
        )}

        <Field
          label="Execution mode"
          hint={
            codeMode === null
              ? "Where each run executes. It applies from the next run."
              : `Where each run executes. This runner's code asks for ${codeMode}.`
          }
          error={save.fieldErrors.executionMode}
        >
          <Select
            options={modeOptions}
            value={form.executionMode}
            onChange={(executionMode) =>
              patch({ executionMode, executionModeOverridden: true })
            }
            disabled={pending}
          />
        </Field>
        <ConfigSource
          testId="execution-mode"
          overridden={form.executionModeOverridden}
          label="Execution mode"
          canReset={config.code !== undefined}
          disabled={pending}
          onReset={() =>
            patch({
              executionModeOverridden: false,
              executionMode: config.code?.executionMode ?? form.executionMode,
            })
          }
        />
        {missingModes.length > 0 && (
          <p
            className="runner-note"
            role="note"
            data-testid="config-modes-limited"
          >
            {missingModes.join(", ")} {missingModes.length === 1 ? "is" : "are"}{" "}
            not offered: this runner's code permits only {modes.join(", ")} (its{" "}
            <code>remoteConfig.executionModes</code>). The API refuses any other
            with 409 <code>CONFIG_NOT_ALLOWED</code>.
          </p>
        )}

        <Field
          label="Run mode"
          hint={
            codeRunMode === null
              ? "Whether runs may overlap."
              : `Whether runs may overlap. This runner's code asks for ${codeRunMode}.`
          }
          error={save.fieldErrors["concurrency.runMode"]}
        >
          <Select
            options={RUN_MODES}
            value={form.runMode}
            onChange={(runMode) =>
              patch({ runMode, concurrencyOverridden: true })
            }
            disabled={pending}
          />
        </Field>

        <Field
          label="Max concurrency"
          hint={
            form.runMode === "single"
              ? "Only applies in parallel: single already allows one run at a time."
              : `Most concurrent runs, ${CONCURRENCY_BOUNDS.min} to ${CONCURRENCY_BOUNDS.max} from here. Empty means unlimited.${
                  codeCap === null
                    ? ""
                    : ` This runner's code asks for ${codeCap}.`
                }`
          }
          error={
            errors.maxConcurrency ??
            save.fieldErrors["concurrency.maxConcurrency"]
          }
        >
          <NumberInput
            value={form.maxConcurrency}
            onChange={(maxConcurrency) =>
              patch({ maxConcurrency, concurrencyOverridden: true })
            }
            min={CONCURRENCY_BOUNDS.min}
            max={CONCURRENCY_BOUNDS.max}
            placeholder="Unlimited"
            disabled={pending || form.runMode === "single"}
          />
        </Field>
        <ConfigSource
          testId="concurrency"
          overridden={form.concurrencyOverridden}
          label="Run mode and max concurrency"
          canReset={config.code !== undefined}
          disabled={pending}
          onReset={() =>
            patch({
              concurrencyOverridden: false,
              runMode: config.code?.runMode ?? form.runMode,
              maxConcurrency:
                config.code?.maxConcurrency ?? form.maxConcurrency,
            })
          }
        />

        {warnings.map((warning) => (
          <p
            key={warning.id}
            className="runner-note runner-note-pending"
            role="note"
            data-testid={`config-warning-${warning.id}`}
          >
            {warning.message}
          </p>
        ))}

        {failure !== null && (
          <ProblemBanner error={explained(failure, "configure")} />
        )}
      </form>
    </Dialog>
  );
}

/** Props of {@link ConfigSource}. */
interface ConfigSourceProps {
  /** The `data-testid` suffix, e.g. `execution-mode`. */
  testId: string;
  /** Whether the setting is an override rather than the code's. */
  overridden: boolean;
  /** What the sentence calls the setting, e.g. "Execution mode". */
  label: string;
  /** Whether the code's own value is known, so it can be gone back to. */
  canReset: boolean;
  /** Whether the reset button is unavailable (a write is in flight). */
  disabled: boolean;
  /** Drops the override, back to the code's value. */
  onReset: () => void;
}

/** Says where one setting's value comes from, with a way back to the code's. */
function ConfigSource({
  testId,
  overridden,
  label,
  canReset,
  disabled,
  onReset,
}: ConfigSourceProps) {
  return (
    <p
      className="config-source"
      data-testid={`config-source-${testId}`}
    >
      <span>
        {overridden
          ? `${label}: overridden here.`
          : `${label}: as the runner's code asks.`}
      </span>
      {overridden && canReset && (
        <Button
          size="sm"
          onClick={onReset}
          disabled={disabled}
        >
          Use the code default
        </Button>
      )}
    </p>
  );
}
