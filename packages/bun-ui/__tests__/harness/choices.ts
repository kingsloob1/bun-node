/**
 * A select's choices: its options without the empty "Choose a …" one every
 * select shows first (BU-placeholders: disabled, value `""`). A test that
 * lists what a select offers reads these; the empty option is the kit's
 * `Select` test's to check.
 */

/** The options of `select` a user can choose, in order. */
export function choices(
  select: HTMLSelectElement | Element,
): HTMLOptionElement[] {
  return [...select.querySelectorAll("option")].filter(
    (option) => !(option.value === "" && option.disabled),
  );
}
