import tsParser from "@typescript-eslint/parser";
import n from "eslint-plugin-n";
export default [{ files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { n }, rules: { "n/handle-callback-err": ["error", "^(err|error)$"] } }];
