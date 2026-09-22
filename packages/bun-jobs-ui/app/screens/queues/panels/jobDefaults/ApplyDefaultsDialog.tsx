import type { JobDefaultsApplyState } from "../../../../api/contract";
import type {
  ApplyJobDefaultsBody,
  JobDefaultsDto,
} from "../../../../api/types";
import type { ApplyOutcome, ApplyTotals } from "./applyLoop";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { JOB_DEFAULTS_APPLY_STATES } from "../../../../api/contract";
import { isApiError } from "../../../../api/errors";
import {
  applyBatchLimit,
  applyJobDefaults,
  getJobDefaults,
  jobDefaultsKey,
} from "../../../../api/jobDefaults";
import { mutationInvalidations } from "../../../../api/queues";
import { Button } from "../../../../components/Button";
import { Dialog } from "../../../../components/Dialog";
import { Checkbox } from "../../../../components/inputs";
import { KeyValue } from "../../../../components/KeyValue";
import { ProblemBanner } from "../../../../components/ProblemBanner";
import { useApiClient } from "../../../../context";
import { formatNumber, plural, STATE_LABELS } from "../../../../format";
import { useMeta } from "../../../../meta/hooks";
import { emptyTotals, runApplyLoop } from "./applyLoop";
import { describeValue, KEY_TEXT } from "./draft";
import {
  APPLY_IRREVERSIBLE,
  EXHAUSTED_WARNING,
  INCLUDE_UNMARKED_HINT,
} from "./text";

/** Props of {@link ApplyDefaultsDialog}. */
export interface ApplyDefaultsDialogProps {
  /** The queue. */
  queue: string;
  /** The defaults as read when the dialog opened: their `seq` is what every call applies, and their `pending` counts what the states offer. */
  defaults: JobDefaultsDto;
  /** Asks to close. */
  onClose: () => void;
}

/** Where the dialog is: choosing, walking, or showing how a walk ended. */
type Phase =
  | {
      /** Choosing states and options. */
      kind: "confirm";
      /** The last dry run's outcome, when one ran, to show beside the choices. */
      preview?: Finished;
    }
  | {
      /** Calls in flight, batch after batch. */
      kind: "running";
      /** Whether this walk writes nothing. */
      dryRun: boolean;
      /** Totals so far. */
      totals: ApplyTotals;
      /** Cancel was pressed: the walk stops after the batch in flight. */
      stopping: boolean;
    }
  | Finished
  | {
      /** The stored defaults moved on (409 `DEFAULTS_CHANGED`): nothing more was applied. */
      kind: "conflict";
      /** Whether the walk was a dry run. */
      dryRun: boolean;
      /** What had been done before the refusal. */
      totals: ApplyTotals;
    };

/** A walk that ended: done, cancelled, or failed. */
interface Finished {
  /** A walk that ended. */
  kind: "finished";
  /** Whether it wrote nothing. */
  dryRun: boolean;
  /** How it ended. */
  outcome: ApplyOutcome;
}

/** Whether any walked job will have `attempts` lowered: the stored value is below the code's. */
function lowersAttempts(defaults: JobDefaultsDto): boolean {
  return (
    defaults.overridden.includes("attempts") &&
    defaults.effective.attempts < defaults.code.attempts
  );
}

/**
 * Apply a queue's stored job defaults to the jobs already pending: an
 * explicit, separate action, never a side effect of saving.
 *
 * The user picks the states (`JOB_DEFAULTS_APPLY_STATES`, all ticked) and
 * whether jobs added before the explicit record are included (unticked), may
 * run a dry run first to see what WOULD change, and confirms. The walk then
 * calls the API batch by batch (`cursor` → `next`) until `done`, pinned to the
 * `seq` read when the dialog opened, showing progress, with Cancel between
 * batches. A 409 `DEFAULTS_CHANGED` stops it and asks to re-read.
 */
export function ApplyDefaultsDialog({
  queue,
  defaults: initial,
  onClose,
}: ApplyDefaultsDialogProps) {
  const api = useApiClient();
  const meta = useMeta();
  const queryClient = useQueryClient();
  const [defaults, setDefaults] = useState(initial);
  const [states, setStates] = useState<readonly JobDefaultsApplyState[]>(
    JOB_DEFAULTS_APPLY_STATES,
  );
  const [includeUnmarked, setIncludeUnmarked] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [rereading, setRereading] = useState(false);
  const [rereadError, setRereadError] = useState<unknown>(null);
  const stopRef = useRef(false);
  // A dialog unmounted mid-walk (the screen navigated away) stops the walk
  // after the batch in flight, rather than rewriting on unseen.
  useEffect(
    () => () => {
      stopRef.current = true;
    },
    [],
  );

  const running = phase.kind === "running";
  const selected = JOB_DEFAULTS_APPLY_STATES.filter((state) =>
    states.includes(state),
  );
  const upperBound = selected.reduce(
    (sum, state) => sum + defaults.pending[state],
    0,
  );
  const preview = phase.kind === "confirm" ? phase.preview : undefined;
  const warnExhausted =
    lowersAttempts(defaults) ||
    (preview !== undefined && preview.outcome.totals.exhausted > 0);

  /**
   * Runs one walk (a dry run or the real thing), updating the phase as batches
   * answer; `resume` continues a stopped or failed walk from its cursor.
   */
  const walk = async (
    dryRun: boolean,
    resume?: { cursor: string | undefined; totals: ApplyTotals },
  ) => {
    stopRef.current = false;
    const start = resume?.totals ?? emptyTotals();
    setPhase({ kind: "running", dryRun, totals: start, stopping: false });
    const outcome = await runApplyLoop({
      cursor: resume?.cursor,
      totals: start,
      request: (cursor) => {
        const body: ApplyJobDefaultsBody = {
          seq: defaults.seq,
          states: [...selected],
          limit: applyBatchLimit(meta.limits.maxApplyDefaults),
          dryRun,
          includeUnmarked,
        };
        if (cursor !== undefined) {
          body.cursor = cursor;
        }
        return applyJobDefaults(api, queue, body);
      },
      onBatch: (totals) =>
        setPhase((current) =>
          current.kind === "running" ? { ...current, totals } : current,
        ),
      shouldStop: () => stopRef.current,
    });
    if (!dryRun && outcome.totals.batches > 0) {
      // The jobs changed: re-read the counts, the table and the defaults.
      for (const queryKey of mutationInvalidations(queue)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
    if (
      outcome.status === "failed" &&
      isApiError(outcome.error) &&
      outcome.error.code === "DEFAULTS_CHANGED"
    ) {
      setPhase({ kind: "conflict", dryRun, totals: outcome.totals });
      return;
    }
    const finished: Finished = { kind: "finished", dryRun, outcome };
    setPhase(
      dryRun && outcome.status === "done"
        ? { kind: "confirm", preview: finished }
        : finished,
    );
  };

  /** Reads the defaults again and goes back to the choices. */
  const reread = async () => {
    setRereading(true);
    setRereadError(null);
    try {
      const fresh = await getJobDefaults(api, queue);
      queryClient.setQueryData(jobDefaultsKey(queue), fresh);
      setDefaults(fresh);
      setPhase({ kind: "confirm" });
    } catch (caught) {
      setRereadError(caught);
    } finally {
      setRereading(false);
    }
  };

  const toggle = (state: JobDefaultsApplyState, on: boolean) =>
    setStates((current) =>
      on ? [...current, state] : current.filter((item) => item !== state),
    );

  const nothingOverridden = defaults.overridden.length === 0;
  const applyLabel = `Apply to ${formatNumber(upperBound)} pending ${upperBound === 1 ? "job" : "jobs"}`;

  return (
    <Dialog
      open
      onClose={onClose}
      closeOnEscape={!running}
      closeOnBackdrop={!running}
      showCloseButton={!running}
      size="lg"
      role="alertdialog"
      title={`Apply the job defaults of ${queue} to pending jobs?`}
      description={APPLY_IRREVERSIBLE}
      footer={
        phase.kind === "confirm" ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              onClick={() => void walk(true)}
              disabled={selected.length === 0 || nothingOverridden}
            >
              {preview ? "Preview again" : "Preview (dry run)"}
            </Button>
            <Button
              variant="danger"
              onClick={() => void walk(false)}
              disabled={selected.length === 0 || nothingOverridden}
            >
              {applyLabel}
            </Button>
          </>
        ) : phase.kind === "running" ? (
          <Button
            onClick={() => {
              stopRef.current = true;
              setPhase({ ...phase, stopping: true });
            }}
            disabled={phase.stopping}
          >
            {phase.stopping ? "Stopping after this batch…" : "Cancel"}
          </Button>
        ) : (
          <>
            {phase.kind === "finished" && phase.outcome.status !== "done" && (
              <Button
                onClick={() => {
                  const { outcome } = phase;
                  if (outcome.status !== "done") {
                    void walk(phase.dryRun, {
                      cursor: outcome.cursor,
                      totals: outcome.totals,
                    });
                  }
                }}
              >
                Continue from where it stopped
              </Button>
            )}
            <Button
              variant="primary"
              onClick={onClose}
            >
              Close
            </Button>
          </>
        )
      }
    >
      {phase.kind === "confirm" && (
        <>
          <p>
            Writes, into each pending job whose own <code>add()</code> did not
            pass it:
          </p>
          <ul
            className="job-defaults-apply-keys"
            aria-label="Values written"
          >
            {defaults.overridden.map((key) => (
              <li key={key}>
                {KEY_TEXT[key].label}:{" "}
                {describeValue(key, defaults.effective[key])}
              </li>
            ))}
          </ul>
          {nothingOverridden && (
            <p role="alert">
              Nothing is overridden, so there is nothing to apply.
            </p>
          )}
          <fieldset className="job-defaults-apply-states">
            <legend>States</legend>
            {JOB_DEFAULTS_APPLY_STATES.map((state) => (
              <Checkbox
                key={state}
                label={`${STATE_LABELS[state]} (${formatNumber(defaults.pending[state])})`}
                checked={states.includes(state)}
                onChange={(on) => toggle(state, on)}
              />
            ))}
            {selected.length === 0 && (
              <p className="field-error">Tick at least one state.</p>
            )}
          </fieldset>
          <Checkbox
            label="Include jobs added before this version"
            hint={INCLUDE_UNMARKED_HINT}
            checked={includeUnmarked}
            onChange={setIncludeUnmarked}
          />
          <p className="muted">
            {plural(upperBound, "pending job")} is an upper bound: jobs that
            passed these options explicitly, or were added before this version,
            are counted in it and left alone. Run a preview for the exact
            figure. Active, completed and dead jobs are never touched.
          </p>
          {defaults.overridden.includes("priority") && (
            <p className="muted">
              Changing priority re-sorts the backlog: until the walk ends, some
              jobs are re-sorted and others not yet.
            </p>
          )}
          {warnExhausted && (
            <p
              className="job-defaults-warning"
              data-testid="exhausted-warning"
            >
              {EXHAUSTED_WARNING}
              {preview !== undefined &&
                preview.outcome.totals.exhausted > 0 && (
                  <>
                    {" "}
                    The preview found{" "}
                    {plural(preview.outcome.totals.exhausted, "such job")}.
                  </>
                )}
            </p>
          )}
          {preview && (
            <section
              aria-label="Preview"
              className="job-defaults-preview"
            >
              <h3>Preview: nothing was written</h3>
              <ApplyResult
                totals={preview.outcome.totals}
                dryRun
              />
            </section>
          )}
        </>
      )}
      {phase.kind === "running" && (
        <div
          role="status"
          aria-live="polite"
          data-testid="apply-progress"
        >
          <p>
            {phase.dryRun ? "Previewing" : "Applying"}… examined{" "}
            {formatNumber(phase.totals.examined)} of about{" "}
            {formatNumber(upperBound)};{" "}
            {phase.dryRun ? "would rewrite" : "rewritten"}{" "}
            {formatNumber(phase.totals.rewritten)} so far (
            {plural(phase.totals.batches, "batch", "batches")}).
          </p>
          <progress
            max={Math.max(upperBound, phase.totals.examined, 1)}
            value={phase.totals.examined}
            aria-label="Jobs examined"
          />
        </div>
      )}
      {phase.kind === "finished" && (
        <FinishedView
          dryRun={phase.dryRun}
          outcome={phase.outcome}
        />
      )}
      {phase.kind === "conflict" && (
        <div role="alert">
          <p>
            The job defaults changed since you confirmed them — someone saved or
            reset them. Nothing more was{" "}
            {phase.dryRun ? "previewed" : "applied"}.
            {!phase.dryRun &&
              phase.totals.rewritten > 0 &&
              ` ${plural(phase.totals.rewritten, "job")} had already been rewritten with the values you confirmed.`}{" "}
            Re-read them, check them, and apply again.
          </p>
          {rereadError !== null && <ProblemBanner error={rereadError} />}
          <Button
            onClick={() => void reread()}
            disabled={rereading}
            aria-busy={rereading || undefined}
          >
            {rereading ? "Re-reading…" : "Re-read the defaults"}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

/** How a walk ended, and what it did. */
function FinishedView({
  dryRun,
  outcome,
}: {
  /** Whether it wrote nothing. */
  dryRun: boolean;
  /** How it ended. */
  outcome: ApplyOutcome;
}) {
  const verb = dryRun ? "Previewed" : "Applied";
  return (
    <div data-testid="apply-result">
      {outcome.status === "done" && (
        <p role="status">{verb} to every pending job in the chosen states.</p>
      )}
      {outcome.status === "cancelled" && (
        <p role="status">
          Stopped after {plural(outcome.totals.batches, "batch", "batches")}.
          The jobs not reached yet keep their values; apply again to continue.
        </p>
      )}
      {outcome.status === "failed" && (
        <ProblemBanner
          error={outcome.error}
          title={`Stopped: a batch failed after ${plural(outcome.totals.batches, "batch", "batches")}`}
        />
      )}
      <ApplyResult
        totals={outcome.totals}
        dryRun={dryRun}
      />
    </div>
  );
}

/** The counts of a walk: the five that add up to examined, and exhausted within rewritten. */
function ApplyResult({
  totals,
  dryRun,
}: {
  /** What the walk did. */
  totals: ApplyTotals;
  /** Whether it wrote nothing ("would be rewritten"). */
  dryRun: boolean;
}) {
  return (
    <>
      <KeyValue
        className="job-defaults-result"
        items={[
          { label: "Examined", value: formatNumber(totals.examined) },
          {
            label: dryRun ? "Would be rewritten" : "Rewritten",
            value: formatNumber(totals.rewritten),
          },
          { label: "Unchanged", value: formatNumber(totals.unchanged) },
          {
            label: "Skipped as explicit",
            value: formatNumber(totals.skippedExplicit),
            hint: "their own add() passed every value that would change",
          },
          {
            label: "Skipped, added before this version",
            value: formatNumber(totals.skippedUnmarked),
          },
          {
            label: "Moved",
            value: formatNumber(totals.moved),
            hint: "left the chosen states before their write; at least this many",
          },
          {
            label: "Exhausted",
            value: formatNumber(totals.exhausted),
            hint: "part of rewritten: already at the new attempts, so one final attempt each",
          },
        ]}
      />
      {totals.exhausted > 0 && (
        <p className="job-defaults-warning">
          {plural(totals.exhausted, "job")} {dryRun ? "would get" : "got"} one
          final attempt: each has already made at least the new number of
          attempts, and dies if that attempt fails.
        </p>
      )}
    </>
  );
}
