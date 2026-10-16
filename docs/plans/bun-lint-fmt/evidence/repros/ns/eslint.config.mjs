import tsParser from "@typescript-eslint/parser";
import ts from "@typescript-eslint/eslint-plugin";
export default [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { "@typescript-eslint": ts }, rules: { "@typescript-eslint/no-namespace": "error" } }];
