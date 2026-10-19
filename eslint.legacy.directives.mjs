// Shared by every `eslint.legacy.config.mjs` while ESLint and `bun lint` run
// side by side (docs/plans/bun-lint-fmt/ §7, PR A to PR E); removed with ESLint
// in PR F.
//
// `bun lint` runs rules our ESLint configs never enable: the type-aware ones
// (`@typescript-eslint/unbound-method`, `only-throw-error`,
// `no-floating-promises`, ...; the ESLint configs are not type-checked) and the
// canonical names of rules ESLint knows under another (`n/no-top-level-await`
// for `antfu/no-top-level-await`). A disable directive naming one of them is
// one ESLint can never see used, so ESLint reports it as an "Unused
// eslint-disable directive", and `eslint --fix` deletes it. This keeps
// `reportUnusedDisableDirectives` on for every rule ESLint does run, and drops
// that report only for a rule no config here enables. `bun lint`'s own
// `reportUnusedDisableDirectives = "warn"` still reports those directives when
// they are unused.

const UNUSED = /^Unused eslint-disable directive \(no problems were reported from '([^']+)'\)\.?$/;
const CODE = ["**/*.?([cm])[jt]s?(x)"];

/**
 * The rule ids some config object turns on, at any severity but `off`.
 * @param {import("eslint").Linter.Config[]} configs The resolved configs.
 * @returns {Set<string>} The enabled rule ids.
 */
function enabledRules(configs) {
  const enabled = new Set();
  for (const config of configs) {
    for (const [id, entry] of Object.entries(config.rules ?? {})) {
      const severity = Array.isArray(entry) ? entry[0] : entry;
      if (severity !== "off" && severity !== 0) enabled.add(id);
    }
  }
  return enabled;
}

/**
 * An `onResolved` hook for an antfu composer: appends a pass-through processor
 * for code files whose postprocess drops the unused-directive report of a rule
 * no config enables. Code files only, so the Markdown and Vue processors stay
 * where they are; a Markdown code block is linted under it as well.
 * @param {import("eslint").Linter.Config[]} configs The resolved configs.
 * @returns {import("eslint").Linter.Config[]} The configs, plus the processor.
 */
export function keepBunLintDirectives(configs) {
  const enabled = enabledRules(configs);
  /**
   * Whether ESLint should still report this message.
   * @param {import("eslint").Linter.LintMessage} message A lint message.
   * @returns {boolean} False for an unused directive of a rule ESLint never runs.
   */
  const keep = (message) => {
    if (message.ruleId !== null) return true;
    const rule = UNUSED.exec(message.message)?.[1];
    return rule === undefined || enabled.has(rule);
  };
  return [
    ...configs,
    {
      name: "bun-node/bun-lint-directives",
      files: CODE,
      processor: {
        meta: { name: "bun-node/bun-lint-directives" },
        preprocess: (text) => [text],
        postprocess: (messageLists) => messageLists.flat().filter(keep),
        supportsAutofix: true,
      },
    },
  ];
}
