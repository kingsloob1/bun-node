import config from "../../packages/bun-nest/eslint.config.mjs";

/**
 * The package's own lint rules, with the two that fight what an example is.
 *
 * An example is a script: it prints what it is doing, and it awaits at the top
 * level because that is how a script reads from top to bottom.
 *
 * `overrideRules` rather than `append`: a later `overrideRules` is the only
 * thing that wins over one the package config already applies.
 */
export default config.overrideRules({
  "no-console": "off",
  "antfu/no-top-level-await": "off",
});
