import tsParser from "@typescript-eslint/parser";
import imp from "eslint-plugin-import-lite";
export default [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { import: imp }, rules: { "import/no-duplicates": "error" } }];
