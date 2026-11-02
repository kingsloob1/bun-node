/**
 * Bun's types for the declaration build, whose shared `tsconfig.build.json`
 * names no types (as `../dom.d.ts` gives it the fetch types): the generator
 * is Bun-only (it reads files, fetches, imports modules and hashes with
 * `Bun.CryptoHasher`). Nothing imports this file, and TypeScript keeps a
 * `types` reference out of emitted declarations, so no consumer's program
 * is given Bun's types by it; the generator's declarations name none.
 */
/// <reference types="bun" />
