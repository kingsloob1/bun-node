/**
 * Artefacts (topologies.md §4, PR-CP4): files a bundle references by
 * SHA-256 (IP-intelligence databases), served to agents at
 * `GET /agent/artefacts/:sha256` and checked by them against the hash.
 * The control plane keeps them in an {@link ArtefactStore}: a
 * content-addressed directory, or the host's own `{ get, put }`.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where artefacts are kept, by SHA-256 (lower-case hex). */
export interface ArtefactStore {
  /** The bytes of `sha256`, or `undefined`. */
  readonly get: (sha256: string) => Promise<Uint8Array | undefined>;
  /** Keeps `bytes` under `sha256` (their hash, already checked). */
  readonly put: (sha256: string, bytes: Uint8Array) => Promise<void>;
}

/** A SHA-256 in lower-case hex. */
export const SHA256_PATTERN = /^[\da-f]{64}$/;

/** The SHA-256 of `bytes`, lower-case hex. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Artefacts in a directory, one file per SHA-256, each written atomically
 * (a temporary file, then a rename).
 */
export function directoryArtefacts(dir: string): ArtefactStore {
  return Object.freeze({
    get: async (sha256: string) => {
      if (!SHA256_PATTERN.test(sha256)) return undefined;
      try {
        return new Uint8Array(await readFile(join(dir, sha256)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    put: async (sha256: string, bytes: Uint8Array) => {
      await mkdir(dir, { recursive: true });
      const temporary = join(dir, `.${sha256}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { mode: 0o644 });
        await rename(temporary, join(dir, sha256));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  });
}
