/**
 * Layer L8's trap form fields (layers.md L8): a field people never see and
 * bots fill in. {@link trapField} renders it; {@link isTrapFilled} checks a
 * submission; an app that finds it filled refuses the submission and calls
 * `security.signal(facts, "trap.filled")`, which scores the client address
 * (weight 10 by default, so the ladder bans it on the first fill).
 *
 * Honeypot routes and canary credentials are evaluated by the engine.
 */

/** The default trap field's name: one a form-filling bot fills. */
export const DEFAULT_TRAP_FIELD = "website";

/** A trap field's name: a letter, then letters, digits, `_` and `-`. */
const NAME_RE = /^[a-z][\w-]{0,63}$/i;

/** Options for {@link trapField}. */
export interface TrapFieldOptions {
  /** The field's name. Default {@link DEFAULT_TRAP_FIELD}. */
  readonly name?: string;
  /** The label a screen reader would read, telling a person to leave it empty. Default `"Leave this field empty"`. */
  readonly label?: string;
}

/** A rendered trap field. */
export interface TrapField {
  /** The field's name, for {@link isTrapFilled}. */
  readonly name: string;
  /** The HTML to put inside the form: a text input moved off screen, out of the tab order, with autocomplete off. */
  readonly html: string;
}

/** `text` escaped for an HTML attribute or text. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A trap field to render in a form. Throws a `TypeError` for a name outside
 * the grammar (a letter, then up to 63 letters, digits, `_` and `-`).
 *
 * @example
 * ```ts
 * const trap = trapField();
 * const form = `<form method="post">…${trap.html}</form>`;
 * ```
 */
export function trapField(options: TrapFieldOptions = {}): TrapField {
  const name = options.name ?? DEFAULT_TRAP_FIELD;
  if (!NAME_RE.test(name)) {
    throw new TypeError(
      `trapField(): ${JSON.stringify(name)} is not a field name (a letter, then letters, digits, "_" and "-")`,
    );
  }
  const label = escapeHtml(options.label ?? "Leave this field empty");
  return Object.freeze({
    name,
    html: `<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><label>${label}<input type="text" name="${name}" value="" tabindex="-1" autocomplete="off"></label></div>`,
  });
}

/** A form submission as an app holds it. */
export type TrapSubmission =
  FormData | URLSearchParams | Readonly<Record<string, unknown>>;

/**
 * Whether a submission filled the trap field `name`: a non-empty value
 * (after trimming), in any of the forms an app holds a submission.
 */
export function isTrapFilled(
  submission: TrapSubmission,
  name: string = DEFAULT_TRAP_FIELD,
): boolean {
  const values: unknown[] =
    submission instanceof FormData || submission instanceof URLSearchParams
      ? submission.getAll(name)
      : [submission[name]];
  return values.some((value) =>
    typeof value === "string"
      ? value.trim() !== ""
      : Array.isArray(value)
        ? value.some((item) => typeof item === "string" && item.trim() !== "")
        : value !== undefined &&
          value !== null &&
          !(value instanceof Blob && value.size === 0),
  );
}
