/**
 * Run by `cipher.test.ts` in a child `bun test`, never by the suite itself
 * (no `.test.` in its name): the cipher conformance kit against a cipher the
 * environment names, so the kit's failures can be asserted from outside.
 */
import { Buffer } from "node:buffer";
import process from "node:process";
import { runCacheCipherConformance } from "../../../lib/testing/index";
import { testCipher } from "../../core/encryptionHelpers";

const kind = process.env.BUN_CACHE_CIPHER_FIXTURE;
if (kind === "ignore-aad") {
  runCacheCipherConformance("ignores the aad", testCipher({ ignoreAad: true }));
} else if (kind === "fixed-nonce") {
  const inner = testCipher();
  const sealed = new Map<string, Uint8Array>();
  // Deterministic: the same input seals to the same bytes (a reused nonce).
  runCacheCipherConformance("reuses its nonce", {
    id: inner.id,
    seal: async (plaintext, context) => {
      const memo = `${Buffer.from(plaintext).toString("hex")}|${Buffer.from(context.aad).toString("hex")}`;
      const known = sealed.get(memo);
      if (known !== undefined) {
        return known;
      }
      const out = await inner.seal(plaintext, context);
      sealed.set(memo, out);
      return out;
    },
    open: inner.open,
  });
} else {
  throw new Error(`unknown BUN_CACHE_CIPHER_FIXTURE ${String(kind)}`);
}
