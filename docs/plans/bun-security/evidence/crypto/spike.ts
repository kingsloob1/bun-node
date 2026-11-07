// Spike: which signing primitives Bun offers for signed policy bundles and
// signed agent requests. Behaviour only, no timing. Run: bun spike.ts
import { createHash, generateKeyPairSync, sign, timingSafeEqual, verify } from "node:crypto";

const out: Record<string, unknown> = { bun: Bun.version, revision: Bun.revision };
const data = new TextEncoder().encode(JSON.stringify({ version: 42, rules: [] }));

// WebCrypto Ed25519 (browser-compatible: the UI could verify a bundle too)
try {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, data);
  const ok = await crypto.subtle.verify("Ed25519", kp.publicKey, sig, data);
  const tampered = new Uint8Array(data);
  tampered[2] ^= 1;
  const bad = await crypto.subtle.verify("Ed25519", kp.publicKey, sig, tampered);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  out.subtleEd25519 = { signatureBytes: sig.byteLength, verifies: ok, tamperedVerifies: bad, publicJwkKty: jwk.kty, crv: jwk.crv };
} catch (error) {
  out.subtleEd25519 = `unsupported: ${String(error)}`;
}

// node:crypto Ed25519
try {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sig = sign(null, data, privateKey);
  out.nodeEd25519 = { signatureBytes: sig.length, verifies: verify(null, data, publicKey, sig) };
} catch (error) {
  out.nodeEd25519 = `unsupported: ${String(error)}`;
}

// HMAC-SHA256 through WebCrypto, and timingSafeEqual
const hk = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hk, data));
out.hmac = { bytes: mac.length, verifies: await crypto.subtle.verify("HMAC", hk, mac, data) };
out.timingSafeEqual = { equal: timingSafeEqual(mac, mac), differentLengthThrows: (() => { try { timingSafeEqual(mac, mac.slice(1)); return false; } catch { return true; } })() };

// Bun.CryptoHasher and Bun.hash for key hashing / PoW
out.cryptoHasherSha256 = new Bun.CryptoHasher("sha256").update("abc").digest("hex") === createHash("sha256").update("abc").digest("hex");
out.bunHashIsNonCryptographic = typeof Bun.hash("abc");
console.log(JSON.stringify(out, null, 2));
