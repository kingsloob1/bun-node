/**
 * The audit key (control-plane.md §6.2, §7.3): an Ed25519 key of its own,
 * distinct from the bundle key, signing the chain's checkpoints. The
 * control plane verifies its own checkpoints, so it needs the public half:
 * derived from a held private key, or given beside a KMS hook.
 */
import type { KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { AuditCheckpoint } from "../../store/types";
import { canonicalJson } from "../../bundle/bundle";

/** How the control plane signs checkpoints. */
export type AuditSigning =
  | {
      /** The audit key's id. */
      readonly keyId: string;
      /** An Ed25519 private key (PKCS#8 PEM or a `KeyObject`), never the bundle key. */
      readonly privateKey: string | KeyObject;
    }
  | {
      /** The audit key's id. */
      readonly keyId: string;
      /** Signs bytes with Ed25519 elsewhere (a KMS); the 64-byte signature. */
      readonly sign: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
      /** The key's public half (PEM or `KeyObject`), to verify the checkpoints it signed. */
      readonly publicKey: string | KeyObject;
    };

/** A resolved audit signer. */
export interface AuditSigner {
  /** The key's id. */
  readonly keyId: string;
  /** Signs bytes. */
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** The public half. */
  readonly publicKey: KeyObject;
}

/** The public half of `key` as DER bytes, for comparing keys. */
function der(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

/**
 * Checks `signing` and resolves it; refuses a missing one, a key that is
 * not Ed25519, and the bundle key (by id or by key).
 */
export function resolveAuditSigner(
  signing: AuditSigning | undefined,
  bundle: { readonly keyId: string; readonly publicKey?: KeyObject },
): AuditSigner {
  if (signing === undefined || typeof signing !== "object") {
    throw new ConfigError(
      "createSecurityApi(): audit.signing is required: an Ed25519 key of its own for the audit log's checkpoints ({ keyId, privateKey } or { keyId, sign, publicKey })",
    );
  }
  if (
    typeof signing.keyId !== "string" ||
    !/^[\w.-]{1,64}$/.test(signing.keyId)
  ) {
    throw new ConfigError(
      "createSecurityApi(): audit.signing.keyId must be 1 to 64 letters, digits, _, . or -",
    );
  }
  if (signing.keyId === bundle.keyId) {
    throw new ConfigError(
      "createSecurityApi(): the audit key must not be the bundle key (control-plane.md §7.3)",
      {
        keyId: signing.keyId,
      },
    );
  }
  let publicKey: KeyObject;
  let signer: (bytes: Uint8Array) => Promise<Uint8Array>;
  try {
    if ("sign" in signing) {
      if (typeof signing.sign !== "function")
        throw new Error("audit.signing.sign must be a function");
      publicKey =
        typeof signing.publicKey === "string"
          ? createPublicKey(signing.publicKey)
          : signing.publicKey;
      const hook = signing.sign;
      signer = async (bytes) => await hook(bytes);
    } else {
      const key =
        typeof signing.privateKey === "string"
          ? createPrivateKey(signing.privateKey)
          : signing.privateKey;
      if (key.type !== "private")
        throw new Error("audit.signing.privateKey is not a private key");
      publicKey = createPublicKey(key);
      signer = async (bytes) => sign(null, bytes, key);
    }
  } catch (error) {
    throw new ConfigError(
      `createSecurityApi(): audit.signing: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new ConfigError(
      "createSecurityApi(): the audit key must be an Ed25519 key",
    );
  }
  if (
    bundle.publicKey !== undefined &&
    der(bundle.publicKey) === der(publicKey)
  ) {
    throw new ConfigError(
      "createSecurityApi(): the audit key must not be the bundle key (control-plane.md §7.3)",
    );
  }
  return { keyId: signing.keyId, sign: signer, publicKey };
}

/** The bytes a checkpoint's signature covers: `{ n, hash, at }`'s canonical JSON. */
export function checkpointBytes(
  checkpoint: Pick<AuditCheckpoint, "n" | "hash" | "at">,
): Uint8Array {
  return new TextEncoder().encode(
    canonicalJson({
      n: checkpoint.n,
      hash: checkpoint.hash,
      at: checkpoint.at,
    }),
  );
}

/** Signs a checkpoint of entry `n`. */
export async function signCheckpoint(
  n: number,
  hash: string,
  at: number,
  signer: AuditSigner,
): Promise<AuditCheckpoint> {
  const signature = await signer.sign(checkpointBytes({ n, hash, at }));
  return {
    n,
    hash,
    at,
    keyId: signer.keyId,
    signature: Buffer.from(signature).toString("base64"),
  };
}

/** Whether `checkpoint` was signed by one of `keys` (by key id). Never throws. */
export function checkpointValid(
  checkpoint: AuditCheckpoint,
  keys: ReadonlyMap<string, KeyObject>,
): boolean {
  const key = keys.get(checkpoint.keyId);
  if (key === undefined) return false;
  try {
    return verify(
      null,
      checkpointBytes(checkpoint),
      key,
      Buffer.from(checkpoint.signature, "base64"),
    );
  } catch {
    return false;
  }
}
