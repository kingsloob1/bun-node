import tsParser from "@typescript-eslint/parser";
import unicorn from "eslint-plugin-unicorn";
export default [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { unicorn }, rules: { "unicorn/prefer-regexp-test": "error", "unicorn/prefer-string-starts-ends-with": "error" } }];
