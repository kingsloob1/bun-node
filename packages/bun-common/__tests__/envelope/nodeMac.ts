/**
 * HMAC-SHA256 through `node:crypto`, for the envelope's tests: the second
 * implementation the WebCrypto default is checked against (bun-jobs' host
 * injects the same, `remote/host/mac.ts`).
 */
import { createHmac } from "node:crypto";
import type { HmacSha256 } from "../../lib/envelope/mac";

/** HMAC-SHA256 through `node:crypto`. */
export const nodeHmacSha256: HmacSha256 = (key, message) =>
  new Uint8Array(createHmac("sha256", key).update(message).digest());
