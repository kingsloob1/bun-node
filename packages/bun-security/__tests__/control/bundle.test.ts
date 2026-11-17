/**
 * Signed bundles (control-plane.md §3.1, §7.3): canonical JSON, Ed25519
 * signing with a held key or a KMS hook, and `verifyBundle`'s refusals:
 * a tampered bundle, an unknown key, another service's, a replay, one not
 * yet valid; an expired one verifies, marked.
 */
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { BUNDLE_FORMAT } from "../../lib/control/contract/index";
import { bundlePublicKey, signBundle } from "../../lib/control/index";
import { canonicalJson, verifyBundle } from "../../lib/index";
import type { SecurityBundle } from "../../lib/index";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);

/** An unsigned bundle for `service` at `version`. */
const unsigned = (
  version = 3,
  service = "checkout",
): Omit<SecurityBundle, "signature"> => ({
  format: BUNDLE_FORMAT,
  service,
  version,
  policyVersions: ["pv_global_1"],
  compiledAt: new Date(NOW).toISOString(),
  notBefore: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
  effective: { lists: [{ ip: "203.0.113.0/24", action: "block" as const }] },
  artefacts: [],
});

/** A held-key signer. */
const signer = {
  keyId: "sk_1",
  sign: async (bytes: Uint8Array) => sign(null, bytes, privateKey),
};

describe("canonicalJson", () => {
  it("sorts keys at every level, drops undefined members, and refuses what JSON cannot carry", () => {
    expect(
      canonicalJson({
        b: 1,
        a: { d: [3, { y: 1, x: 2 }], c: null },
        u: undefined,
      }),
    ).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(TypeError);
  });
});

describe("signing and verifying", () => {
  it("verifies a signed bundle with its public key: PEM, KeyObject or raw bytes", async () => {
    const bundle = await signBundle(unsigned(), signer);
    expect(bundle.signature).toMatchObject({ alg: "Ed25519", keyId: "sk_1" });
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    for (const key of [
      bundlePublicKey(privateKey),
      publicKey,
      new Uint8Array(raw),
    ]) {
      expect(
        verifyBundle(bundle, { sk_1: key }, { now: () => NOW }),
      ).toMatchObject({ ok: true, expired: false });
    }
  });

  it("refuses a tampered bundle, an unknown key, another service's, a replay and one not yet valid", async () => {
    const bundle = await signBundle(unsigned(), signer);
    const keys = { sk_1: publicKey };
    const tampered = {
      ...bundle,
      effective: { lists: [] },
    } as unknown as SecurityBundle;
    expect(verifyBundle(tampered, keys, { now: () => NOW })).toEqual({
      ok: false,
      reason: "signature",
    });
    const forged = {
      ...bundle,
      signature: {
        ...bundle.signature,
        value: Buffer.alloc(64).toString("base64"),
      },
    };
    expect(verifyBundle(forged, keys, { now: () => NOW })).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(
      verifyBundle(bundle, { other: publicKey }, { now: () => NOW }),
    ).toEqual({ ok: false, reason: "unknown-key" });
    expect(
      verifyBundle(bundle, keys, { now: () => NOW, service: "account" }),
    ).toEqual({ ok: false, reason: "wrong-service" });
    expect(verifyBundle(bundle, keys, { now: () => NOW, after: 3 })).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(verifyBundle(bundle, keys, { now: () => NOW, after: 2 }).ok).toBe(
      true,
    );
    expect(verifyBundle(bundle, keys, { now: () => NOW - 1 })).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
    expect(verifyBundle({ ...bundle, format: "other/1" }, keys)).toEqual({
      ok: false,
      reason: "format",
    });
    expect(verifyBundle({ nope: true }, keys)).toEqual({
      ok: false,
      reason: "malformed",
    });
    // A key of another algorithm never verifies it.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey;
    expect(verifyBundle(bundle, { sk_1: rsa }, { now: () => NOW })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("loads an expired bundle, marked, rather than stop enforcing", async () => {
    const bundle = await signBundle(unsigned(), signer);
    expect(
      verifyBundle(
        bundle,
        { sk_1: publicKey },
        { now: () => NOW + 8 * 86_400_000 },
      ),
    ).toMatchObject({
      ok: true,
      expired: true,
    });
  });
});
