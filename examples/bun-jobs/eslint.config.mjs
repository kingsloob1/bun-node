import config from "../../packages/bun-jobs/eslint.config.mjs";

/**
 * The package's own lint rules, with the two that fight what an example is.
 *
 * An example is a script: it prints what it is doing, and it awaits at the top
 * level because that is how a script reads from top to bottom.
 *
 * `overrideRules` rather than `append`: the package config ends with its own
 * `overrideRules`, which is applied to every config — an appended one included
 * — so only a later `overrideRules` wins.
 */
export default config.overrideRules({
  "no-console": "off",
  "antfu/no-top-level-await": "off",
});
