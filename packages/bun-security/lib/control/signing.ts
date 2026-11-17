/**
 * Bundle signing (control-plane.md §7.3; Q13): the control plane holds an
 * Ed25519 key, or hands the bytes to a `sign` hook (a KMS, an HSM), and
 * signs the canonical JSON of every bundle it compiles.
 */
import type { KeyObject } from "node:crypto";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { SecurityBundle } from "../bundle/bundle";
import { bundleSigningBytes } from "../bundle/bundle";

/** The key a control plane signs with: held here, or behind a hook. */
export type BundleSigner =
  | {
      /** The key's id, which agents map to its public key. */
      readonly keyId: string;
      /** An Ed25519 private key: PKCS#8 PEM, or a `KeyObject`. Load it from a secret, never a policy. */
      readonly privateKey: string | KeyObject;
    }
  | {
      /** The key's id. */
      readonly keyId: string;
      /** Signs `bytes` with Ed25519 elsewhere (a KMS); answers the 64-byte signature. */
      readonly sign: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
    };

/** A key id: letters, digits, `_`, `.` and `-`, 1 to 64. */
const KEY_ID = /^[\w.-]{1,64}$/;

/** A resolved signer: its key id, and signing. */
export interface ResolvedSigner {
  /** The key's id. */
  readonly keyId: string;
  /** Signs bytes. */
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** The public half, when the private key is held here (a KMS hook's is not known). */
  readonly publicKey?: KeyObject;
}

/** Checks `signer` and resolves it; throws a `ConfigError` for a bad one. */
export function resolveSigner(
  signer: BundleSigner | undefined,
): ResolvedSigner {
  if (signer === undefined || typeof signer !== "object") {
    throw new ConfigError(
      "createSecurityApi(): signing is required: { keyId, privateKey } (an Ed25519 key) or { keyId, sign } (a KMS hook); bundles are always signed",
    );
  }
  if (typeof signer.keyId !== "string" || !KEY_ID.test(signer.keyId)) {
    throw new ConfigError(
      "createSecurityApi(): signing.keyId must be 1 to 64 letters, digits, _, . or -",
      {
        keyId: signer.keyId,
      },
    );
  }
  if ("sign" in signer) {
    if (typeof signer.sign !== "function") {
      throw new ConfigError(
        "createSecurityApi(): signing.sign must be a function",
      );
    }
    const hook = signer.sign;
    return { keyId: signer.keyId, sign: async (bytes) => await hook(bytes) };
  }
  let key: KeyObject;
  try {
    key =
      typeof signer.privateKey === "string"
        ? createPrivateKey(signer.privateKey)
        : signer.privateKey;
  } catch (error) {
    throw new ConfigError(
      "createSecurityApi(): signing.privateKey is not a private key",
      { cause: error },
    );
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new ConfigError(
      "createSecurityApi(): signing.privateKey must be an Ed25519 private key",
      {
        type: key.type,
        algorithm: key.asymmetricKeyType,
      },
    );
  }
  return {
    keyId: signer.keyId,
    sign: async (bytes) => sign(null, bytes, key),
    publicKey: createPublicKey(key),
  };
}

/** Signs `unsigned` with `signer`: the bundle with its signature. */
export async function signBundle(
  unsigned: Omit<SecurityBundle, "signature">,
  signer: ResolvedSigner,
): Promise<SecurityBundle> {
  const signature = await signer.sign(bundleSigningBytes(unsigned));
  return {
    ...unsigned,
    signature: {
      alg: "Ed25519",
      keyId: signer.keyId,
      value: Buffer.from(signature).toString("base64"),
    },
  };
}

/** The PEM public key of an Ed25519 private key, for configuring agents. */
export function bundlePublicKey(privateKey: string | KeyObject): string {
  const key =
    typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  return createPublicKey(key)
    .export({ format: "pem", type: "spki" })
    .toString();
}
