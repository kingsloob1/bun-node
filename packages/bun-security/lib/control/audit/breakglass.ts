/**
 * The break-glass account (control-plane.md §5.1, Q11): one local login
 * for when the identity provider is down during an incident, opt-in, with
 * a password (a `Bun.password` hash from the environment) and a TOTP code
 * (RFC 6238: SHA-1, 6 digits, 30 s, ±1 step), each code used once.
 *
 * A login answers a token (HMAC-SHA256 under a key derived from the TOTP
 * secret) valid 15 minutes, sent back in `x-bun-security-break-glass`; its
 * holder acts as `owner` on `global`, its step-up fresh for the first 5
 * minutes. Five failed attempts lock it for 15 minutes. The failures and
 * the used codes are kept in the store, so every control-plane instance on
 * it shares them.
 * Every login and failure is audited, and a login alerts.
 */
import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { SecurityStoreDriver } from "../../store/types";

/** The break-glass configuration. */
export interface BreakGlassOptions {
  /** The password's hash (`Bun.password.hash(password)`), from the environment. */
  readonly passwordHash: string;
  /** The TOTP secret, base32 (an authenticator app's), from the environment. */
  readonly totpSecret: string;
  /** The operator id it acts as. Default `break-glass`. */
  readonly id?: string;
}

/** How long a session lasts, ms. */
export const BREAK_GLASS_TTL_MS = 15 * 60_000;

/** How long a login counts as a fresh step-up, ms. */
export const BREAK_GLASS_STEP_UP_MS = 5 * 60_000;

/** Failed attempts before the lock. */
export const BREAK_GLASS_MAX_FAILURES = 5;

/** How long the lock lasts, ms. */
export const BREAK_GLASS_LOCK_MS = 15 * 60_000;

/** The TOTP step, seconds. */
const STEP_SECONDS = 30;

/** Decodes base32 (RFC 4648, case-insensitive, padding and spaces ignored). */
export function base32Decode(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.toUpperCase().replaceAll(/[\s=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new ConfigError("breakGlass.totpSecret is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The TOTP code of `secret` at step `counter` (RFC 6238 over RFC 4226). */
export function totpCode(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return binary.toString().padStart(6, "0");
}

/** What a session token carries. */
interface TokenBody {
  /** Issued at, ms. */
  readonly iat: number;
  /** Expires at, ms. */
  readonly exp: number;
  /** Its id. */
  readonly jti: string;
}

/** What a login attempt answers. */
export type BreakGlassAttempt =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | {
      readonly ok: false;
      readonly reason: "locked" | "invalid";
      readonly lockedUntil?: number;
      readonly locked?: boolean;
    };

/** How long a used code stays claimed: past the ±1 step window. */
const CODE_CLAIM_MS = 4 * STEP_SECONDS * 1000;

/** The break-glass account; see the module's description. */
export class BreakGlass {
  /** The TOTP secret's bytes. */
  readonly #secret: Uint8Array;
  /** The token key. */
  readonly #tokenKey: Buffer;

  /**
   * @param options The configuration.
   * @param store Where the failures and used codes are kept, shared by every control-plane instance on it.
   * @param now The clock.
   */
  constructor(
    private readonly options: BreakGlassOptions,
    private readonly store: SecurityStoreDriver,
    private readonly now: () => number,
  ) {
    if (
      typeof options.passwordHash !== "string" ||
      !options.passwordHash.startsWith("$")
    ) {
      throw new ConfigError(
        "breakGlass.passwordHash must be a password hash (Bun.password.hash), never the password",
      );
    }
    this.#secret = base32Decode(options.totpSecret ?? "");
    if (this.#secret.length < 10) {
      throw new ConfigError(
        "breakGlass.totpSecret must be at least 80 bits of base32",
      );
    }
    this.#tokenKey = createHash("sha256")
      .update("bun-security break-glass session|")
      .update(this.#secret)
      .digest();
  }

  /** The operator id it acts as. */
  get id(): string {
    return this.options.id ?? "break-glass";
  }

  /** The store key of the failure counter. */
  get #failuresKey(): string {
    return `breakGlass:${this.id}:failures`;
  }

  /** When the lock ends, or `null` when it is not locked (read from the store). */
  async lockedUntil(): Promise<number | null> {
    const failures = await this.store.getCounter(this.#failuresKey);
    return failures !== undefined && failures.count >= BREAK_GLASS_MAX_FAILURES
      ? failures.expiresAt
      : null;
  }

  /** The step `code` is valid for now (±1), or `undefined`. */
  #stepOf(code: string): number | undefined {
    if (!/^\d{6}$/.test(code)) return undefined;
    const step = Math.floor(this.now() / 1000 / STEP_SECONDS);
    for (const counter of [step - 1, step, step + 1]) {
      const expected = Buffer.from(totpCode(this.#secret, counter));
      if (timingSafeEqual(expected, Buffer.from(code))) return counter;
    }
    return undefined;
  }

  /**
   * One login attempt. A failure counts in the store (expiring 15 minutes
   * after the last one); the fifth locks every instance until then. A code
   * is claimed in the store, so it works once across every instance.
   */
  async login(password: string, code: string): Promise<BreakGlassAttempt> {
    const lockedUntil = await this.lockedUntil();
    if (lockedUntil !== null)
      return { ok: false, reason: "locked", lockedUntil };
    const passwordOk = await Bun.password
      .verify(password, this.options.passwordHash)
      .catch(() => false);
    // The code is checked (and used up) only with the right password.
    const step = passwordOk ? this.#stepOf(code) : undefined;
    const fresh =
      step !== undefined &&
      (await this.store.claimKey(
        `breakGlass:${this.id}:code:${step}`,
        CODE_CLAIM_MS,
      ));
    if (!fresh) {
      const failures = await this.store.incrementCounter(
        this.#failuresKey,
        BREAK_GLASS_LOCK_MS,
      );
      if (failures.count >= BREAK_GLASS_MAX_FAILURES) {
        return {
          ok: false,
          reason: "invalid",
          locked: true,
          lockedUntil: failures.expiresAt,
        };
      }
      return { ok: false, reason: "invalid" };
    }
    await this.store.resetCounter(this.#failuresKey);
    const iat = this.now();
    const body: TokenBody = {
      iat,
      exp: iat + BREAK_GLASS_TTL_MS,
      jti: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    const mac = createHmac("sha256", this.#tokenKey)
      .update(payload)
      .digest("base64url");
    return { ok: true, token: `${payload}.${mac}`, expiresAt: body.exp };
  }

  /** A token's body when it is valid now, else `undefined`. */
  session(
    token: string,
  ): { readonly iat: number; readonly exp: number } | undefined {
    const dot = token.indexOf(".");
    if (dot <= 0) return undefined;
    const payload = token.slice(0, dot);
    const expected = createHmac("sha256", this.#tokenKey)
      .update(payload)
      .digest();
    const given = Buffer.from(token.slice(dot + 1), "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return undefined;
    try {
      const body = JSON.parse(
        Buffer.from(payload, "base64url").toString(),
      ) as TokenBody;
      const now = this.now();
      return body.exp > now && body.iat <= now
        ? { iat: body.iat, exp: body.exp }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
