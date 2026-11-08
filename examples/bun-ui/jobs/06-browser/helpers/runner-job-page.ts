/**
 * Page-side helpers of `06-browser/runner-and-job-tools.ts`, beside the ones
 * `shared/browser.ts` has: each returns a script for `view.evaluate()` that
 * polls the DOM until its condition holds (or gives up), never a fixed wait.
 */

/**
 * Page-side: whether a button whose text is `text` exists inside `scope`
 * and is disabled, waiting up to `ms` for one to appear (`null` if none).
 */
export function disabledButton(
  scope: string,
  text: string,
  ms = 10_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const candidate of document.querySelectorAll(${JSON.stringify(`${scope} button`)})) {
        if (candidate.textContent.trim() === ${JSON.stringify(text)}) return resolve(candidate.disabled);
      }
      if (Date.now() > deadline) return resolve(null);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}

/**
 * Page-side: whether a button whose text is `text` exists inside `scope`
 * right now, enabled or not. No waiting: call it once the scope is complete.
 */
export function hasButton(scope: string, text: string): string {
  return `Array.from(document.querySelectorAll(${JSON.stringify(`${scope} button`)}))
    .some((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)})`;
}

/**
 * Page-side: resolves `true` once some element matching `selector` has text
 * including `text`, `false` after `ms`.
 */
export function textIncludes(
  selector: string,
  text: string,
  ms = 15_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
        if (element.textContent.includes(${JSON.stringify(text)})) return resolve(true);
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: resolves `true` once no element matches `selector`, `false`
 * after `ms`.
 */
export function gone(selector: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      if (!document.querySelector(${JSON.stringify(selector)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** One row of a summary (`KeyValue`): its value's text and its hint's. */
export interface SummaryRow {
  /** The value, without the hint. */
  value: string;
  /** The hint under the value, or `null` when there is none. */
  hint: string | null;
}

/**
 * Page-side: the row labelled `label` in the summary `scope` (a `KeyValue`
 * `<dl>`), once `ready` holds for it or `ms` passes (then whatever is there,
 * `null` for no such row). `ready` is a page-side expression over `row` (a
 * {@link SummaryRow}); by default any row will do.
 */
export function summaryRow(
  scope: string,
  label: string,
  ready = "true",
  ms = 15_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const read = () => {
      for (const element of document.querySelectorAll(${JSON.stringify(`${scope} .kv-row`)})) {
        if (element.querySelector("dt")?.textContent.trim() !== ${JSON.stringify(label)}) continue;
        const dd = element.querySelector("dd");
        const hint = dd.querySelector(".kv-hint");
        const clone = dd.cloneNode(true);
        clone.querySelector(".kv-hint")?.remove();
        return { value: clone.textContent.trim(), hint: hint ? hint.textContent.trim() : null };
      }
      return null;
    };
    const poll = () => {
      const row = read();
      if (row && ((row) => ${ready})(row)) return resolve(row);
      if (Date.now() > deadline) return resolve(row);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: resolves `true` once the summary `scope` has no row labelled
 * `label`, `false` after `ms`. The summary must be on screen already.
 */
export function noSummaryRow(
  scope: string,
  label: string,
  ms = 15_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const poll = () => {
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(`${scope} .kv-row dt`)}));
      if (rows.length > 0 && !rows.some((dt) => dt.textContent.trim() === ${JSON.stringify(label)})) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/** One line of a run's log, as the view draws it. */
export interface RunLogLine {
  /** The `seq` in the gutter. */
  seq: number;
  /** The stream's label: `logger`, `stdout` or `stderr`. */
  stream: string;
  /** The line's text. */
  text: string;
}

/**
 * Page-side: the lines of run `runId`'s open log, once `ready` holds for
 * them (a page-side expression over `lines`, a {@link RunLogLine} array), or
 * whatever is there after `ms`.
 */
export function runLogLines(runId: string, ready: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const read = () => Array.from(
      document.querySelectorAll(${JSON.stringify(`[data-testid="run-logs-${runId}"] ol.log-lines > li`)}),
      (line) => ({
        seq: Number(line.querySelector(".log-number")?.textContent),
        stream: line.querySelector(".run-log-stream")?.textContent ?? "",
        text: line.querySelector(".log-text")?.textContent ?? "",
      }),
    );
    const poll = () => {
      const lines = read();
      if (((lines) => ${ready})(lines) || Date.now() > deadline) return resolve(lines);
      setTimeout(poll, 50);
    };
    poll();
  })`;
}

/**
 * Page-side: picks `value` in the `<select>` whose `<label>` inside `scope`
 * starts with `label`, as a change from the keyboard reaches React (a
 * `change` event). Resolves whether the select took the value.
 */
export function chooseOption(
  scope: string,
  label: string,
  value: string,
  ms = 10_000,
): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const element of document.querySelectorAll(${JSON.stringify(`${scope} label`)})) {
        if (!element.textContent.trim().startsWith(${JSON.stringify(label)})) continue;
        const select = document.getElementById(element.htmlFor);
        if (select instanceof HTMLSelectElement) {
          select.value = ${JSON.stringify(value)};
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return resolve(select.value === ${JSON.stringify(value)});
        }
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}

/**
 * Page-side: focuses the enabled field whose `<label>` inside `scope` starts
 * with `label`, so `view.type()` types into it. Resolves whether it got focus.
 */
export function focusField(scope: string, label: string, ms = 10_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      for (const element of document.querySelectorAll(${JSON.stringify(`${scope} label`)})) {
        if (!element.textContent.trim().startsWith(${JSON.stringify(label)})) continue;
        const input = document.getElementById(element.htmlFor);
        if (input && !input.disabled) {
          input.focus();
          return resolve(document.activeElement === input);
        }
      }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}
