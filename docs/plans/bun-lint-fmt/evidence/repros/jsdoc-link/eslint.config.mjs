import tsParser from "@typescript-eslint/parser";
import unused from "eslint-plugin-unused-imports";
export default [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { "unused-imports": unused }, rules: { "unused-imports/no-unused-imports": "error", "unused-imports/no-unused-vars": "error" } }];
