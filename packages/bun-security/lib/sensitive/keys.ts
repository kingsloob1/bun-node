/**
 * The sensitive endpoints' keys (layers.md L2.3, L11.4): the attempted
 * username and a code's destination keyed by their HMAC under the engine's
 * `secret`, never stored in clear; and the device cookie, signed with the
 * same secret, naming a device and the username it signed in as.
 *
 * Processes that share a store must share the secret, or their keys for
 * one username differ and their device cookies do not verify each other's.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The default device cookie's name. */
export const DEFAULT_DEVICE_COOKIE = "__Host-bun-security-device";

/** The shortest secret accepted, in bytes. */
export const MIN_SECRET_BYTES = 32;

/** A secret's bytes, checked; a `TypeError` for one too short. */
export function secretBytes(secret: string | Uint8Array): Uint8Array {
  const bytes =
    typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  if (!(bytes instanceof Uint8Array) || bytes.length < MIN_SECRET_BYTES) {
    throw new TypeError(
      `bun-security: secret must be at least ${MIN_SECRET_BYTES} bytes (a string or a Uint8Array)`,
    );
  }
  return bytes;
}

/** A device cookie, verified. */
export interface Device {
  /** Its id. */
  readonly id: string;
  /** When it was issued, epoch ms. */
  readonly issuedAt: number;
}

/** HMACs and device cookies under one secret. */
export class Keyring {
  /** The secret. */
  readonly #secret: Uint8Array;

  constructor(
    /** The secret; a random one of this process's own when undefined. */
    secret: string | Uint8Array | undefined,
  ) {
    this.#secret =
      secret === undefined
        ? randomBytes(MIN_SECRET_BYTES)
        : secretBytes(secret);
  }

  /** `HMAC(secret, label|value)`, hex, 128 bits. */
  #mac(label: string, value: string): string {
    return createHmac("sha256", this.#secret)
      .update(`${label}|${value}`)
      .digest("hex")
      .slice(0, 32);
  }

  /** The key of an attempted username: its HMAC, trimmed and in lower case. */
  username(username: string): string {
    return this.#mac("username", username.trim().toLowerCase());
  }

  /**
   * The key of an API key's id (layers.md L12): its HMAC, so the id is
   * never stored or shared in clear (limits, bans, distinct counts).
   */
  apiKey(id: string): string {
    return this.#mac("apiKey", id);
  }

  /** The key of a destination (an email address, a phone number), normalised. */
  destination(destination: string): string {
    return this.#mac("destination", normaliseDestination(destination));
  }

  /** The key of a destination's prefix: an email's domain, a phone number's first six characters (`+` and five digits). */
  destinationPrefix(destination: string): string | undefined {
    const normal = normaliseDestination(destination);
    const at = normal.lastIndexOf("@");
    const prefix =
      at === -1
        ? normal.startsWith("+")
          ? normal.slice(0, 6)
          : normal.slice(0, 5)
        : normal.slice(at + 1);
    return prefix === "" ? undefined : this.#mac("prefix", prefix);
  }

  /** A new device cookie's value for `usernameKey`, issued at `now`. */
  issueDevice(usernameKey: string, now: number): string {
    const id = randomBytes(16).toString("base64url");
    const tag = this.#mac("device-user", usernameKey).slice(0, 16);
    const issued = now.toString(36);
    const body = `${id}.${tag}.${issued}`;
    return `${body}.${this.#sign(body)}`;
  }

  /** The signature of a device cookie's body. */
  #sign(body: string): string {
    return createHmac("sha256", this.#secret)
      .update(`device|${body}`)
      .digest("base64url")
      .slice(0, 32);
  }

  /**
   * The device a cookie's `value` names, when it is signed with this
   * secret, issued for `usernameKey`, and younger than `maxAge`.
   */
  verifyDevice(
    value: string,
    usernameKey: string,
    now: number,
    maxAge: number,
  ): Device | undefined {
    if (value.length > 256) return undefined;
    const parts = value.split(".");
    if (parts.length !== 4) return undefined;
    const [id, tag, issued, signature] = parts as [
      string,
      string,
      string,
      string,
    ];
    const expected = this.#sign(`${id}.${tag}.${issued}`);
    const given = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
      return undefined;
    }
    if (tag !== this.#mac("device-user", usernameKey).slice(0, 16)) {
      return undefined;
    }
    const issuedAt = Number.parseInt(issued, 36);
    if (
      !Number.isFinite(issuedAt) ||
      issuedAt > now + 60_000 ||
      now - issuedAt > maxAge
    ) {
      return undefined;
    }
    return { id, issuedAt };
  }
}

/** A destination as it is keyed: trimmed, lower case, a phone number's spaces, dots, dashes and brackets removed. */
export function normaliseDestination(destination: string): string {
  const trimmed = destination.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : trimmed.replace(/[\s().-]/g, "");
}

/** The value of cookie `name` in a `Cookie` header, if sent. */
export function cookieValue(
  header: string | undefined,
  name: string,
): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() === name) {
      return part.slice(equals + 1).trim();
    }
  }
  return undefined;
}
