/**
 * Page-side helpers for `06-browser/workers.ts`, beside the shared ones in
 * `../../shared/browser.ts`. Each returns the source of a promise for
 * `view.evaluate`, and every one waits on a condition with a deadline —
 * never on time — so a step fails naming what never appeared.
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

/** Page-side: the current path and query, once the path is `path`; `null` after `ms`. */
export function at(path: string, ms = 15_000): string {
  return poll(
    `location.pathname === ${JSON.stringify(path)} ? location.pathname + location.search : null`,
    ms,
  );
}
