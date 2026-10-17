import antfu from "@antfu/eslint-config";
import eslintConfigPrettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import reactRefresh from "eslint-plugin-react-refresh";

export default antfu({
  lessOpinionated: true,
  stylistic: {
    indent: 2,
    quotes: "double",
    jsx: true,
    semi: true,
  },
  typescript: true,
  jsonc: true,
  yaml: true,
  toml: true,
  test: true,
})
  .override("antfu/stylistic/rules", {
    rules: {
      "style/operator-linebreak": "off",
      "style/brace-style": "off",
      "style/indent": "off",
      "style/quote-props": "off",
      "style/arrow-parens": "off",
      "style/indent-binary-ops": "off",
    },
  })
  .append({
    // What antfu's `react: true` gave us besides `@eslint-react`, which is
    // gone: `unmountLeaks.test.tsx` checks for leaked handles at runtime,
    // and Bun's native `react/*` rules take over the rest with `bun lint`.
    // The options are the ones antfu chose here (no Vite, Next.js or Remix).
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    name: "bun-jobs-ui/react-refresh",
    plugins: {
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: false, allowExportNames: [] },
      ],
    },
  })
  .append({
    // `react/no-array-index-key` is a native `bun lint` rule now, and the
    // `eslint-disable-next-line` comments that mark a deliberate index key
    // are kept for it. ESLint lost the rule with `@eslint-react` and reports
    // a directive naming an undefined rule as an error, so this defines the
    // name and nothing else, in the files that carry one. Their directives
    // suppress nothing under ESLint, and `--fix` would delete them as unused,
    // so unused directives are not reported in these files. It goes when
    // ESLint does.
    files: [
      "app/screens/docs/schema/Prose.tsx",
      "app/screens/docs/ws/InlineText.tsx",
      "app/screens/docs/ws/items.tsx",
      "app/screens/job/ErrorDetails.tsx",
      "app/screens/job/JobScreen.tsx",
      "app/screens/queues/panels/SummonPanel.tsx",
    ],
    name: "bun-jobs-ui/react-directive-names",
    plugins: {
      react: {
        rules: {
          "no-array-index-key": {
            meta: { type: "problem", schema: [] },
            create: () => ({}),
          },
        },
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
  })
  .override("antfu/typescript/rules", {
    rules: {
      "ts/ban-types": "off",
      "ts/explicit-function-return-type": "off",
      "ts/explicit-module-boundary-types": "off",
      "ts/no-explicit-any": "off",
    },
  })
  .append({
    // Scoped to the files Prettier should actually format. Left unscoped, the
    // rule applies to everything ESLint sees — including Markdown, which it
    // then parses as code and reports a syntax error on the first heading.
    // Markdown is still linted, by the Markdown rules, which is the right tool
    // for it.
    files: [
      "**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,vue}",
      "**/*.{json,json5,jsonc}",
      "**/*.{yaml,yml,toml}",
    ],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...eslintConfigPrettier.rules,
      ...eslintPluginPrettierRecommended.rules,
      "prettier/prettier": [
        "error",
        {
          endOfLine: "lf",
          singleQuote: false,
          singleAttributePerLine: true,
          trailingComma: "all",
          tabWidth: 2,
          useTabs: false,
          bracketSpacing: true,
          jsxBracketSameLine: false,
          semi: true,
        },
      ],
    },
  })
  .overrideRules({
    "unused-imports/no-unused-imports": "error",
    "unused-imports/no-unused-imports-ts": "error",
    // Keep antfu's `^_` ignore pattern: a leading underscore marks a
    // deliberately-unused binding (e.g. the mandatory 4th `next` parameter of
    // an Express-style error handler, kept for arity detection).
    "unused-imports/no-unused-vars": [
      "error",
      {
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        vars: "all",
        varsIgnorePattern: "^_",
      },
    ],
    "no-console": "warn",
    "no-labels": "off",
    "no-restricted-syntax": "off",
    "no-async-promise-executor": "off",
  });
