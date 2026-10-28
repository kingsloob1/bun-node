// Which algorithms crypto.subtle accepts on this Bun, and the import format ChaCha20-Poly1305 needs.
// Run: bun probe-subtle.ts
const s = crypto.subtle;
const data = new TextEncoder().encode("hello world");
for (const name of ["AES-GCM", "ChaCha20-Poly1305", "AES-OCB", "AES-CTR", "AES-KW"]) {
  try {
    const key = await s.generateKey({ name, length: 256 } as AesKeyGenParams, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await s.encrypt({ name, iv, counter: new Uint8Array(16), length: 64 } as AesGcmParams, key, data);
    console.log("OK", name, ct.byteLength);
  } catch (e) {
    console.log("NO", name, (e as Error).name, (e as Error).message.slice(0, 80));
  }
}
try {
  const k = await s.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  console.log("HMAC OK", (await s.sign("HMAC", k, data)).byteLength);
  const hk = await s.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveBits"]);
  console.log("HKDF OK", (await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) }, hk, 256)).byteLength);
} catch (e) { console.log("NO hmac/hkdf", e); }
// Import formats for ChaCha20-Poly1305: the WICG "Modern Algorithms" draft uses "raw-secret".
const raw = crypto.getRandomValues(new Uint8Array(32));
for (const format of ["raw", "raw-secret"]) {
  try {
    await s.importKey(format as "raw", raw, "ChaCha20-Poly1305", false, ["encrypt"]);
    console.log("importKey ChaCha20-Poly1305 OK", format);
  } catch (e) {
    console.log("importKey ChaCha20-Poly1305 NO", format, (e as Error).message);
  }
}
