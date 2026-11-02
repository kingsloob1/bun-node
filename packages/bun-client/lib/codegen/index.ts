/**
 * `@kingsleyweb/bun-client/codegen`: the generator (typed-client plan §3.2,
 * PR-C2). It reads an OpenAPI 3.1 document and writes the TypeScript module
 * `createClient` reads: the `Routes` map, the components as named types and
 * the runtime `manifest`. The `bun-client` command (`./cli`) is its CLI.
 *
 * Bun only, and dev-time: it reads files and URLs and imports modules. It is
 * never part of a browser bundle (the `.` entry imports none of it).
 */
export { runCli } from "./cli";
export type { CliIo } from "./cli";
export { documentsHash } from "./hash";
export { loadDocuments } from "./load";
export type { DocumentSource, LoadedDocuments } from "./load";
export { generateRoutes } from "./openapi";
export type {
  CodegenWarning,
  GenerateRoutesOptions,
  GenerateRoutesResult,
} from "./openapi";
