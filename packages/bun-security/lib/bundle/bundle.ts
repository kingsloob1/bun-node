/**
 * Signed policy bundles (control-plane.md §3.1, §7.3): what the control
 * plane compiles for each service and an enforcement point loads, signed
 * with Ed25519 over the canonical JSON of everything but the signature.
 * An EP holds only the public keys, given at deploy time, so neither it
 * nor a compromised store can forge a bundle. Verifying is here (an EP's
 * code); signing is the control plane's (`./control`).
 */
import type { KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import type { SecurityPolicy } from "../policy/types";
import { BUNDLE_FORMAT } from "../control/contract/constants";

/** A bundle's signature. */
export interface BundleSignature {
  /** Always `Ed25519`. */
  readonly alg: "Ed25519";
  /** The signing key's id, naming the public key that verifies it. */
  readonly keyId: string;
  /** The signature, base64. */
  readonly value: string;
}

/** An artefact a bundle names (an MMDB file, a range list), fetched by its hash. */
export interface BundleArtefact {
  /** What it is (`mmdb-country`). */
  readonly kind: string;
  /** Its SHA-256, hex. */
  readonly sha256: string;
  /** Where the control plane serves it. */
  readonly url: string;
}

/** A signed bundle, `bun-security.bundle/1`. */
export interface SecurityBundle {
  /** {@link BUNDLE_FORMAT}. */
  readonly format: typeof BUNDLE_FORMAT;
  /** The service it was compiled for. */
  readonly service: string;
  /** Its version: monotonic per service; a lower one is a replay. */
  readonly version: number;
  /** The policy versions merged into it, outermost first. */
  readonly policyVersions: readonly string[];
  /** When it was compiled, ISO 8601. */
  readonly compiledAt: string;
  /** Not to be loaded before, ISO 8601. */
  readonly notBefore: string;
  /** An EP warns past this, and never stops enforcing (ISO 8601). */
  readonly expiresAt: string;
  /** The service's effective policy. */
  readonly effective: SecurityPolicy;
  /** Artefacts it needs. */
  readonly artefacts: readonly BundleArtefact[];
  /** The signature over the rest. */
  readonly signature: BundleSignature;
}

/**
 * `value` as canonical JSON: object keys sorted at every level, no
 * insignificant whitespace (control-plane.md §3.1). Throws a `TypeError`
 * for what JSON cannot carry (a non-finite number, a function, a cycle).
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const walk = (node: unknown): string => {
    if (
      node === null ||
      typeof node === "boolean" ||
      typeof node === "string"
    ) {
      return JSON.stringify(node);
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node))
        throw new TypeError("canonicalJson(): a non-finite number");
      return JSON.stringify(node);
    }
    if (typeof node !== "object") {
      throw new TypeError(`canonicalJson(): ${typeof node} is not JSON`);
    }
    if (seen.has(node)) throw new TypeError("canonicalJson(): a cycle");
    seen.add(node);
    const out = Array.isArray(node)
      ? `[${node.map((item) => walk(item === undefined ? null : item)).join(",")}]`
      : `{${Object.keys(node)
          .filter((key) => (node as Record<string, unknown>)[key] !== undefined)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${walk((node as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`;
    seen.delete(node);
    return out;
  };
  return walk(value);
}

/** The bytes a bundle's signature covers: the canonical JSON of all but `signature`. */
export function bundleSigningBytes(
  bundle: Omit<SecurityBundle, "signature"> | SecurityBundle,
): Uint8Array {
  const { signature: _signature, ...rest } = bundle as SecurityBundle;
  return new TextEncoder().encode(canonicalJson(rest));
}

/** Why {@link verifyBundle} refused a bundle. */
export type BundleRefusal =
  | "malformed"
  | "format"
  | "unknown-key"
  | "signature"
  | "not-yet-valid"
  | "replayed"
  | "wrong-service";

/** What {@link verifyBundle} answers. */
export type BundleVerdict =
  | {
      /** It verified. */
      readonly ok: true;
      /** The bundle. */
      readonly bundle: SecurityBundle;
      /** Past its `expiresAt`: load it, and warn. */
      readonly expired: boolean;
    }
  | {
      /** Refused. */
      readonly ok: false;
      /** Why. */
      readonly reason: BundleRefusal;
    };

/** Options for {@link verifyBundle}. */
export interface VerifyBundleOptions {
  /** The service this EP is: a bundle for another is refused. */
  readonly service?: string;
  /** The version loaded last: a bundle not newer than it is a replay. */
  readonly after?: number;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** A public key, as configured: a PEM string, a `KeyObject`, or raw 32 bytes. */
export type BundlePublicKey = string | KeyObject | Uint8Array;

/** `key` as a `KeyObject`. Internal: the ban batches' check shares it. */
export function publicKeyOf(key: BundlePublicKey): KeyObject {
  if (typeof key === "string") return createPublicKey(key);
  if (key instanceof Uint8Array) {
    // A raw Ed25519 key: its 32 bytes behind the SPKI prefix.
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    return createPublicKey({
      key: Buffer.concat([prefix, Buffer.from(key)]),
      format: "der",
      type: "spki",
    });
  }
  return key;
}

/** Whether `bundle`'s signature verifies under `key` (a key of another kind never does). */
function signatureHolds(bundle: SecurityBundle, key: BundlePublicKey): boolean {
  try {
    return verify(
      null,
      bundleSigningBytes(bundle),
      publicKeyOf(key),
      Buffer.from(bundle.signature.value, "base64"),
    );
  } catch {
    return false;
  }
}

/** Whether `value` has a bundle's shape. */
function isBundle(value: unknown): value is SecurityBundle {
  if (typeof value !== "object" || value === null) return false;
  const bundle = value as Record<string, unknown>;
  const signature = bundle.signature as Record<string, unknown> | undefined;
  return (
    typeof bundle.service === "string" &&
    Number.isSafeInteger(bundle.version) &&
    Array.isArray(bundle.policyVersions) &&
    typeof bundle.notBefore === "string" &&
    typeof bundle.expiresAt === "string" &&
    typeof bundle.effective === "object" &&
    bundle.effective !== null &&
    Array.isArray(bundle.artefacts) &&
    typeof signature === "object" &&
    signature !== null &&
    signature.alg === "Ed25519" &&
    typeof signature.keyId === "string" &&
    typeof signature.value === "string"
  );
}

/**
 * Verifies a signed bundle against the public keys an EP was deployed
 * with (`{ [keyId]: key }`; several during a rotation): its shape, its
 * format, a known key, the signature, `notBefore`, and, with `after`, that
 * it is newer than the one loaded (a validly signed older bundle is a
 * replay, control-plane.md §3.3). Past `expiresAt` it still verifies,
 * marked `expired`. It never throws for a bad bundle.
 */
export function verifyBundle(
  value: unknown,
  keys: Readonly<Record<string, BundlePublicKey>>,
  options: VerifyBundleOptions = {},
): BundleVerdict {
  if (!isBundle(value)) return { ok: false, reason: "malformed" };
  if (value.format !== BUNDLE_FORMAT) return { ok: false, reason: "format" };
  const key = Object.hasOwn(keys, value.signature.keyId)
    ? keys[value.signature.keyId]
    : undefined;
  if (key === undefined) return { ok: false, reason: "unknown-key" };
  if (!signatureHolds(value, key)) return { ok: false, reason: "signature" };
  if (options.service !== undefined && value.service !== options.service) {
    return { ok: false, reason: "wrong-service" };
  }
  if (options.after !== undefined && value.version <= options.after) {
    return { ok: false, reason: "replayed" };
  }
  const now = (options.now ?? Date.now)();
  const notBefore = Date.parse(value.notBefore);
  if (!Number.isFinite(notBefore) || now < notBefore)
    return { ok: false, reason: "not-yet-valid" };
  const expiresAt = Date.parse(value.expiresAt);
  return {
    ok: true,
    bundle: value,
    expired: !Number.isFinite(expiresAt) || now >= expiresAt,
  };
}
