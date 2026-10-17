// typescript-eslint 8.59.4's type-aware rules (the 23 that `bun lint --type-aware` turns on), for a cross-check
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
const rules = ["await-thenable","no-array-delete","no-base-to-string","no-duplicate-type-constituents","no-floating-promises","no-for-in-array","no-implied-eval","no-misused-promises","no-redundant-type-constituents","no-unnecessary-type-assertion","no-unsafe-argument","no-unsafe-assignment","no-unsafe-call","no-unsafe-enum-comparison","no-unsafe-member-access","no-unsafe-return","no-unsafe-unary-minus","only-throw-error","prefer-promise-reject-errors","require-await","restrict-plus-operands","restrict-template-expressions","unbound-method"];
export default [
  { ignores: ["**/dist/**", "**/dts/**", "**/node_modules/**", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts"] },
  { files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser: tsParser, parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { "@typescript-eslint": tsPlugin }, linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: Object.fromEntries([...rules.map(r => [`@typescript-eslint/${r}`, "error"]), ["require-await", "off"]]) },
];
