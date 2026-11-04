#!/usr/bin/env bun
/**
 * Pack guard: reads the `package.json` inside a packed tarball and fails on
 * anything a consumer's package manager cannot resolve.
 *
 * The workspace's manifests name each other `workspace:^` and take shared
 * devDependencies from the root's catalog (`catalog:`). Both are Bun-only
 * spellings for the workspace: `bun pm pack` and `bun publish` rewrite them
 * to `^<version>` and the catalog's range, but `npm pack` and `npm publish`
 * from a package directory ship them verbatim, and a consumer's install then
 * fails on `workspace:^` (measured on npm 11.19.1). So every tarball that may
 * be published or checked is read back, not trusted:
 *
 * ```bash
 * bun scripts/pack-guard.ts packages/bun-common/kingsleyweb-bun-common-3.0.0-rc.0.tgz
 * ```
 *
 * `scripts/publish.ts` and `scripts/consumer-check.ts` call
 * {@link guardTarball} on every tarball they pack. The tarball is read here,
 * with no `tar` binary: gunzip, then the ustar headers (with the pax and GNU
 * long-name forms), which is all `bun pm pack` and `npm pack` write.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

/** The fields of a packed `package.json` the guard reads. */
export interface PackedManifest {
  /** The package's name. */
  name?: string;
  /** The package's version. */
  version?: string;
  /** Every other field, read only by {@link unresolvedProtocols}. */
  [key: string]: unknown;
}

/** What a packed manifest must be, besides free of workspace protocols. */
export interface PackExpectation {
  /** The package name the tarball must carry. Unchecked when absent. */
  name?: string;
  /** The version the tarball must carry, and every internal range's `^<version>`. Unchecked when absent. */
  version?: string;
  /**
   * The workspace's package names. Each one the manifest names in a
   * dependency field must be exactly `^<version>` (needs `version`). Default
   * none.
   */
  internal?: Iterable<string>;
}

/** The dependency fields a packed manifest's internal ranges are checked in. */
export const DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

/** The specifier protocols only a workspace resolves. */
const UNRESOLVED = /\b(?:workspace|catalog):/;

/** A NUL-terminated string field of a tar header. */
function field(block: Uint8Array, start: number, length: number): string {
  const bytes = block.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) break;
    const length = Number(text.slice(at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (record.slice(0, eq) === "path") return record.slice(eq + 1);
    at += length;
  }
  return undefined;
}

/**
 * One file's bytes from a gzipped tarball, by its path inside the archive
 * (`package/package.json`), or `undefined` when the archive has none.
 */
export function readTarEntry(
  tgz: Uint8Array<ArrayBuffer>,
  path: string,
): Uint8Array | undefined {
  const tar = Bun.gunzipSync(tgz);
  let next: string | undefined;
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      next = paxPath(data) ?? next;
      continue;
    }
    if (type === "L") {
      next = field(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const name =
      next ??
      (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    next = undefined;
    if ((type === "0" || type === "\0") && name.replace(/^\.\//, "") === path)
      return data.slice();
  }
  return undefined;
}

/** The `package.json` a tarball ships (`package/package.json`). Throws when it has none. */
export function readPackedManifest(tarball: string): PackedManifest {
  const bytes = readTarEntry(readFileSync(tarball), "package/package.json");
  if (!bytes) throw new Error(`${tarball}: no package/package.json inside`);
  return JSON.parse(new TextDecoder().decode(bytes)) as PackedManifest;
}

/**
 * Every value (and key) of a manifest containing `workspace:` or `catalog:`,
 * as `dependencies.@scope/pkg: workspace:^`. Empty when the manifest is safe
 * to publish.
 */
export function unresolvedProtocols(manifest: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (UNRESOLVED.test(value)) found.push(`${path}: ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, v] of Object.entries(value)) {
        const at = path ? `${path}.${key}` : key;
        if (UNRESOLVED.test(key)) found.push(`${at} (key)`);
        visit(v, at);
      }
    }
  };
  visit(manifest, "");
  return found;
}

/**
 * What is wrong with a packed manifest: an unresolved `workspace:` or
 * `catalog:` anywhere, a name or version other than `expected`'s, and an
 * internal range other than `^<version>`. Empty when it is fine.
 */
export function checkPackedManifest(
  manifest: PackedManifest,
  expected: PackExpectation = {},
): string[] {
  const problems = unresolvedProtocols(manifest).map(
    (p) => `unresolved workspace protocol: ${p}`,
  );
  if (expected.name !== undefined && manifest.name !== expected.name)
    problems.push(`name is ${manifest.name}, not ${expected.name}`);
  if (expected.version !== undefined) {
    if (manifest.version !== expected.version)
      problems.push(`version is ${manifest.version}, not ${expected.version}`);
    const internal = new Set(expected.internal ?? []);
    for (const fieldName of DEPENDENCY_FIELDS) {
      const deps = manifest[fieldName] as
        Record<string, string> | null | undefined;
      for (const [name, range] of Object.entries(deps ?? {})) {
        if (!internal.has(name) || range === `^${expected.version}`) continue;
        problems.push(
          `${fieldName}.${name} is ${range}, not ^${expected.version}`,
        );
      }
    }
  }
  return problems;
}

/** {@link checkPackedManifest} on the manifest inside `tarball`. */
export function guardTarball(
  tarball: string,
  expected: PackExpectation = {},
): string[] {
  return checkPackedManifest(readPackedManifest(tarball), expected);
}

if (import.meta.main) {
  const tarballs = process.argv.slice(2);
  if (tarballs.length === 0) {
    console.error("usage: bun scripts/pack-guard.ts <tarball.tgz>...");
    process.exit(2);
  }
  let failed = 0;
  for (const tarball of tarballs) {
    const problems = guardTarball(tarball);
    if (problems.length === 0) {
      console.log(`ok   ${tarball}`);
      continue;
    }
    failed++;
    console.log(`FAIL ${tarball}`);
    for (const p of problems) console.log(`     ${p}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
