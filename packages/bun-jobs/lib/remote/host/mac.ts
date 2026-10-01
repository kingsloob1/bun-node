/**
 * The host side of the MAC seam: HMAC-SHA256 through `node:crypto`.
 *
 * Bun-only, so it lives outside the browser-safe graph of `./remote`: nothing
 * that entry reaches imports this file, and the bundle-safety test holds it
 * to that. The gateway side (`RemoteTarget`) and `./remote/serve` inject it
 * into the core in place of `subtleHmacSha256` (`../mac.ts`), for the CPU it saves
 * per frame. Same bytes as WebCrypto, pinned by the signing tests' vectors.
 */

import type { HmacSha256 } from "../mac";
import { createHmac } from "node:crypto";

/** HMAC-SHA256 through `node:crypto`: synchronous, and several times cheaper than WebCrypto under Bun. */
export const nodeHmacSha256: HmacSha256 = (key, message) =>
  new Uint8Array(createHmac("sha256", key).update(message).digest());
