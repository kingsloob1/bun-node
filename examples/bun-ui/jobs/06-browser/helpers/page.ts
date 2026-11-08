/**
 * Page-side helpers for `06-browser/workers.ts`, `overview-range.ts`,
 * `runner-and-job-tools.ts` and `pause-and-retry.ts`, beside the shared ones
 * in `../../shared/browser.ts`. Each returns the source of a promise for
 * `view.evaluate`, and every one waits on a condition with a deadline — never
 * on time — so a step fails naming what never appeared.
 */

/**
 * Page-side: re-evaluates the expression `expr` every 50 ms until it gives a
 * value that is not `null`, `undefined` or `false`, and resolves with it; or
 * with `null` after `ms`. The workhorse the others are built on.
 */
export function poll(expr: string, ms = 15_000): string {
  return `new Promise((resolve) => {
    const deadline = Date.now() + ${ms};
    const attempt = () => {
      let value;
      try { value = (${expr}); } catch { value = null; }
      if (value !== null && value !== undefined && value !== false) return resolve(value);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(attempt, 50);
    };
    attempt();
  })`;
}

/**
 * Page-side expression: the form control labelled exactly `label` inside
 * `scope` (a `<label for>` pointing at it), or `null`.
 */
function control(scope: string, label: string): string {
  return `(() => {
    for (const root of document.querySelectorAll(${JSON.stringify(scope)})) {
      for (const element of root.querySelectorAll("label")) {
        if (element.textContent.trim() === ${JSON.stringify(label)} && element.htmlFor) {
          const found = document.getElementById(element.htmlFor);
          if (found) return found;
        }
      }
    }
    return null;
  })()`;
}

/**
 * Page-side: chooses `value` in the `<select>` labelled `label` inside
 * `scope`, the way a user's pick reaches React (the native value setter, then
 * a `change` event). Resolves whether the select was found.
 */
export function choose(scope: string, label: string, value: string): string {
  return poll(`(() => {
    const select = ${control(scope, label)};
    if (!select) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

/**
 * Page-side: types `value` into the input labelled `label` inside `scope`
 * (the native value setter, then an `input` event, which is what React's
 * `onChange` listens to). Resolves whether the input was found.
 */
export function typeInto(scope: string, label: string, value: string): string {
  return poll(`(() => {
    const input = ${control(scope, label)};
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

/** Page-side: the options of the `<select>` labelled `label` inside `scope`, as `[value, text]` pairs, once it exists. */
export function optionsOf(scope: string, label: string): string {
  return poll(`(() => {
    const select = ${control(scope, label)};
    return select ? [...select.options].map((option) => [option.value, option.textContent.trim()]) : null;
  })()`);
}

/**
 * Page-side: the texts of every element matching `selector`, once
 * `ready(texts)` (a JS expression over `texts`) holds; `null` after `ms`.
 */
export function textsWhen(
  selector: string,
  ready: string,
  ms = 15_000,
): string {
  return poll(
    `(() => {
      const texts = [...document.querySelectorAll(${JSON.stringify(selector)})].map((element) => element.textContent.trim());
      return (${ready}) ? texts : null;
    })()`,
    ms,
  );
}

/** Page-side: whether nothing matches `selector` any more, within `ms`. */
export function gone(selector: string, ms = 15_000): string {
  return poll(`!document.querySelector(${JSON.stringify(selector)})`, ms);
}

/**
 * Page-side: clicks the element matching `selector` once it exists, and
 * resolves with its `href` attribute (or `true` when it has none); `null`
 * after `ms`.
 */
export function clickOn(selector: string, ms = 15_000): string {
  return poll(
    `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const href = element.getAttribute("href");
    element.click();
    return href ?? true;
  })()`,
    ms,
  );
}

/**
 * Page-side: the newest toast whose message contains `text`, as
 * `[message, description]`, once one shows; `null` after `ms`.
 */
export function toast(text: string, ms = 15_000): string {
  return poll(
    `(() => {
    const found = [...document.querySelectorAll(".toast")].reverse().find((element) =>
      element.querySelector(".toast-message")?.textContent.includes(${JSON.stringify(text)}));
    return found
      ? [found.querySelector(".toast-message").textContent.trim(),
         found.querySelector(".toast-description")?.textContent.trim() ?? ""]
      : null;
  })()`,
    ms,
  );
}

/** Page-side: the text of every button inside `scope`, in order (empty when there is none). */
export function buttonsIn(scope: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].map((button) => button.textContent.trim())`;
}

/** The Page control a pager offers, when it offers one. */
export interface PageControlView {
  /**
   * `"select"` for a listbox of every page (up to the pager's
   * `pageSelectMax`), `"input"` for the bounded number box beyond it.
   */
  kind: "select" | "input";
  /** The page it holds now, as the control's own value. */
  value: string;
  /** Every page it offers, for a `select`; `null` for the input. */
  options: string[] | null;
  /** The input's `max` — the last page — or `null` for the select. */
  max: string | null;
}

/** What a `Pager` shows: its range, its controls and which way it can move. */
export interface PagerView {
  /** The range text: `"1–20 of 345"`, or `"1–20"` where the route counts no total. */
  range: string;
  /** The rows-per-page in force. */
  size: number;
  /** Every size the "Rows per page" select offers, in order. */
  sizes: number[];
  /** The Page control, or `null` where there is no total to build one from. */
  pageControl: PageControlView | null;
  /** The `"of N"` beside the Page control, or `null` when there is none. */
  pageCount: string | null;
  /**
   * The muted text naming the page where there is no Page control — `"Page 3"`
   * — or `null`. Shown only while there is another page to go to.
   */
  pageText: string | null;
  /** Whether Previous is there and enabled (`null` when there is no such button). */
  prev: boolean | null;
  /** Whether Next is there and enabled (`null` when there is no such button). */
  next: boolean | null;
}

/** Page-side expression: the pager named `label` as a {@link PagerView}, or `null`. */
function readPager(label: string): string {
  return `(() => {
    const nav = document.querySelector(${JSON.stringify(`nav.pager[aria-label="${label}"]`)});
    if (!nav) return null;
    const size = nav.querySelector(".pager-size select");
    if (!size) return null;
    const pageSelect = nav.querySelector(".pager-page select");
    const pageInput = nav.querySelector(".pager-page input");
    const named = (text) => [...nav.querySelectorAll(".pager-buttons button")]
      .find((candidate) => candidate.textContent.trim() === text) ?? null;
    const prev = named("Previous");
    const next = named("Next");
    return {
      range: nav.querySelector(".pager-range")?.textContent.trim() ?? "",
      size: Number(size.value),
      sizes: [...size.options].map((option) => Number(option.value)),
      pageControl: pageSelect
        ? { kind: "select", value: pageSelect.value, options: [...pageSelect.options].map((option) => option.value), max: null }
        : pageInput
          ? { kind: "input", value: pageInput.value, options: null, max: pageInput.getAttribute("max") }
          : null,
      pageCount: nav.querySelector(".pager-page-count")?.textContent.trim() ?? null,
      pageText: nav.querySelector(".pager-page-static")?.textContent.trim() ?? null,
      prev: prev ? !prev.disabled : null,
      next: next ? !next.disabled : null,
    };
  })()`;
}

/**
 * Page-side: the pager whose accessible name is `label` (`Pager`'s `label`
 * prop, e.g. "Runner pages"), as a {@link PagerView}, once it is on screen;
 * `null` after `ms`.
 */
export function pagerOf(label: string, ms = 15_000): string {
  return poll(readPager(label), ms);
}

/**
 * Page-side: the same, once `ready(pager)` holds for it — a page-side
 * expression over `pager`, a {@link PagerView}. For reading a pager *after* a
 * move, where the wait is for the move to land rather than for the pager to
 * exist; `null` after `ms`, so a failure prints what the pager last said.
 */
export function pagerWhen(label: string, ready: string, ms = 15_000): string {
  return poll(
    `(() => {
      const pager = ${readPager(label)};
      return pager && (${ready}) ? pager : null;
    })()`,
    ms,
  );
}

/**
 * Page-side: the accessible name of every pager on screen, in document order,
 * once `ready(labels)` holds (a page-side expression over `labels`); `null`
 * after `ms`. A table that fits one page must grow no pager, so the check for
 * one that is *absent* has to wait for the screen it is absent from.
 */
export function pagersWhen(ready: string, ms = 15_000): string {
  return poll(
    `(() => {
      const labels = [...document.querySelectorAll("nav.pager")].map((nav) => nav.getAttribute("aria-label"));
      return (${ready}) ? labels : null;
    })()`,
    ms,
  );
}

/** Page-side: the current path and query, once the path is `path`; `null` after `ms`. */
export function at(path: string, ms = 15_000): string {
  return poll(
    `location.pathname === ${JSON.stringify(path)} ? location.pathname + location.search : null`,
    ms,
  );
}
