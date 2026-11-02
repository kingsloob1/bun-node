/**
 * The fetch types (`Request`, `Response`, `HeadersInit`, …) for the
 * declaration build, whose shared `tsconfig.build.json` names no lib but
 * ESNext and no types. Nothing imports this file, so it reaches no other
 * program: not the package's own project (which excludes it and checks
 * against Bun's types), not a consumer's (TypeScript 5.5 and later keep a
 * `lib` reference out of emitted declarations; a consumer brings the DOM lib
 * or Bun's types, either of which declares these).
 */
/// <reference lib="dom" />
