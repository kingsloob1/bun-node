/**
 * The built-in challenge: proof of work, with no third party (layers.md
 * L10.2), in ALTCHA's v1 wire format (the user's Q9 decision), so ALTCHA's
 * MIT widget can solve it unchanged:
 *
 * - the challenge is `{ algorithm: "SHA-256", challenge, maxnumber, salt,
 *   signature }`, where `salt` is random hex with parameters after a `?`
 *   (`expires`, Unix seconds, and `c`, a hash of the client's network) and
 *   a closing `&`; `challenge` is `hex(SHA-256(salt + number))` for a secret
 *   `number` from 0 to `maxnumber`; `signature` is `hex(HMAC-SHA-256(key,
 *   challenge))`;
 * - the client finds `number` by trying them in turn, and posts
 *   `base64(JSON({ algorithm, challenge, number, salt, signature }))`;
 * - the server checks the algorithm, the expiry, the client, the hash, the
 *   HMAC, and that the salt was not used before (a replay cache until it
 *   expires).
 *
 * The work is the number of hashes: `maxnumber / 2` on average. It grows
 * with the request's risk. A proof of work slows a bot farm per request; it
 * does not stop a determined one: it is a rate shaper, not an identity check.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { ConfigError } from "@kingsleyweb/bun-common";
import { clearanceNetwork } from "./clearance";
import type { SharedStateStore } from "../engine/shared";
import type {
  ChallengeContext,
  ChallengeDescriptor,
  ChallengeProvider,
  ChallengeVerdict,
} from "./types";

/** The challenge a proof of work issues (ALTCHA's v1 challenge). */
export interface PowChallengeData {
  /** Always `SHA-256`. */
  readonly algorithm: "SHA-256";
  /** `hex(SHA-256(salt + number))`. */
  readonly challenge: string;
  /** The largest number to try. */
  readonly maxnumber: number;
  /** Random hex, then `?expires=…&c=…&`. */
  readonly salt: string;
  /** `hex(HMAC-SHA-256(key, challenge))`. */
  readonly signature: string;
}

/** Options for {@link powChallenge}. */
export interface PowChallengeOptions {
  /** The HMAC key: at least 32 characters. Keep it secret and the same across instances. */
  readonly secret: string;
  /**
   * The largest number a client may have to try at risk 0. Default
   * `50_000` (about 25,000 hashes on average: well under a second in a
   * browser).
   */
  readonly maxNumber?: number;
  /** How much the work grows per point of risk (`maxNumber × (1 + risk × riskFactor)`). Default `1`. */
  readonly riskFactor?: number;
  /** The most work a challenge asks, whatever the risk. Default `1_000_000`. */
  readonly maxNumberCap?: number;
  /** How long a challenge may be solved, in seconds. Default `300`. */
  readonly expiresIn?: number;
  /** The most salts the local replay cache holds. Default `100_000`. */
  readonly maxReplay?: number;
  /**
   * A shared store (`createSecurity`'s `store`, such as `cacheStore(cache)`
   * from `./stores`): each answered salt is also marked there, with one
   * atomic `increment`, so an answer is single use across every process,
   * not just this one. When the store fails or is slower than
   * {@link storeTimeoutMs}, the local cache alone decides (a replay to
   * another process inside the outage passes; the same process still
   * refuses it). Default: the local cache only.
   */
  readonly store?: Pick<SharedStateStore, "increment">;
  /** How long the shared replay check may take, in ms, before the local cache decides alone. Default `100`. */
  readonly storeTimeoutMs?: number;
  /** The clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

/** A hex SHA-256. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A hex HMAC-SHA-256. */
function hmacHex(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("hex");
}

/** Whether two hex strings are equal, in time independent of where they differ. */
function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The solver the challenge page runs, inline under its nonce: finds the
 * number with Web Crypto, fills the form's `altcha` field, submits it.
 */
const SOLVER = `(async () => {
  const form = document.getElementById("bun-security-challenge");
  const status = document.getElementById("bun-security-status");
  const data = JSON.parse(document.getElementById("bun-security-pow").textContent);
  const encoder = new TextEncoder();
  const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
  const started = Date.now();
  for (let number = 0; number <= data.maxnumber; number++) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data.salt + number));
    if (hex(digest) === data.challenge) {
      const payload = { algorithm: data.algorithm, challenge: data.challenge, number, salt: data.salt, signature: data.signature, took: Date.now() - started };
      form.elements.altcha.value = btoa(JSON.stringify(payload));
      status.textContent = "Done.";
      form.submit();
      return;
    }
  }
  status.textContent = "Could not complete the check.";
})();`;

/** A proof-of-work challenge provider (ALTCHA-compatible). Throws a `ConfigError` for a short secret. */
export function powChallenge(options: PowChallengeOptions): ChallengeProvider {
  const secret = options.secret;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new ConfigError(
      "powChallenge(): secret must be at least 32 characters",
    );
  }
  const base = options.maxNumber ?? 50_000;
  const factor = options.riskFactor ?? 1;
  const cap = options.maxNumberCap ?? 1_000_000;
  const expiresIn = options.expiresIn ?? 300;
  const maxReplay = options.maxReplay ?? 100_000;
  const now = options.now ?? Date.now;
  const store = options.store;
  const storeTimeoutMs = options.storeTimeoutMs ?? 100;
  for (const [name, value] of [
    ["maxNumber", base],
    ["maxNumberCap", cap],
    ["expiresIn", expiresIn],
    ["maxReplay", maxReplay],
    ["storeTimeoutMs", storeTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ConfigError(
        `powChallenge(): ${name} must be a positive whole number; got ${String(value)}`,
      );
    }
  }
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) {
    throw new ConfigError(
      `powChallenge(): riskFactor must be a number, 0 or more; got ${String(factor)}`,
    );
  }
  // Salts already answered, until they expire (oldest first). Past
  // `maxReplay` the oldest is forgotten before it expires: size it above
  // the answers expected in `expiresIn`.

  const used = new Map<string, number>();

  /**
   * Whether the shared store has seen `salt` answered before (marking it
   * now); `false` when it has not, or did not answer in time.
   */
  const seenShared = async (salt: string, ttl: number): Promise<boolean> => {
    if (store === undefined) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const count = await Promise.race([
        store.increment(`pow:used:${sha256Hex(salt).slice(0, 32)}`, 1, ttl),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            storeTimeoutMs,
          );
        }),
      ]);
      return count > 1;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  /** The client binding a salt carries. */
  const clientTag = (client: string) =>
    hmacHex(secret, `client|${clearanceNetwork(client)}`).slice(0, 16);

  /** A new challenge for `context`. */
  const create = (context: ChallengeContext): PowChallengeData => {
    const risk = Math.max(0, context.risk);
    const maxnumber = Math.min(cap, Math.floor(base * (1 + risk * factor)));
    const expires = Math.floor(now() / 1000) + expiresIn;
    const salt = `${randomBytes(12).toString("hex")}?expires=${expires}&c=${clientTag(context.client)}&`;
    const number = randomInt(maxnumber + 1);
    const challenge = sha256Hex(salt + number);
    return {
      algorithm: "SHA-256",
      challenge,
      maxnumber,
      salt,
      signature: hmacHex(secret, challenge),
    };
  };

  return {
    id: "pow",
    field: "altcha",
    issue(context): ChallengeDescriptor {
      const data = create(context);
      return {
        provider: "pow",
        field: "altcha",
        html: `<input type="hidden" name="altcha" value=""><script type="application/json" id="bun-security-pow">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script><p id="bun-security-status">Checking your browser…</p>`,
        script: SOLVER,
        data,
      };
    },
    async verify(answer, context): Promise<ChallengeVerdict> {
      if (answer.length > 4096)
        return { ok: false, reason: "oversized answer" };
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(
          Buffer.from(answer, "base64").toString("utf8"),
        ) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "not a payload" };
      }
      const { algorithm, challenge, number, salt, signature } = payload;
      if (
        algorithm !== "SHA-256" ||
        typeof challenge !== "string" ||
        typeof salt !== "string" ||
        typeof signature !== "string" ||
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 0
      ) {
        return { ok: false, reason: "malformed payload" };
      }
      const params = new URLSearchParams(salt.split("?")[1] ?? "");
      const expires = Number(params.get("expires"));
      const time = now();
      if (!Number.isSafeInteger(expires) || expires * 1000 <= time) {
        return { ok: false, reason: "expired" };
      }
      if (params.get("c") !== clientTag(context.client)) {
        return { ok: false, reason: "another client's challenge" };
      }
      if (!sameHex(signature, hmacHex(secret, challenge))) {
        return { ok: false, reason: "bad signature" };
      }
      if (!sameHex(challenge, sha256Hex(salt + number))) {
        return { ok: false, reason: "wrong number" };
      }
      // Single use: forget expired salts, then refuse a seen one.
      for (const [seen, until] of used) {
        if (until > time && used.size <= maxReplay) break;
        used.delete(seen);
      }
      if (used.has(salt)) return { ok: false, reason: "replayed" };
      used.set(salt, expires * 1000);
      if (await seenShared(salt, expires * 1000 - time)) {
        return { ok: false, reason: "replayed" };
      }
      return { ok: true };
    },
  };
}

/**
 * Solves a proof-of-work challenge by trying every number: what the page's
 * script does, for an API client or a test. `undefined` when none fits.
 */
export function solvePowChallenge(data: PowChallengeData): string | undefined {
  for (let number = 0; number <= data.maxnumber; number++) {
    if (sha256Hex(data.salt + number) === data.challenge) {
      return Buffer.from(
        JSON.stringify({
          algorithm: data.algorithm,
          challenge: data.challenge,
          number,
          salt: data.salt,
          signature: data.signature,
        }),
      ).toString("base64");
    }
  }
  return undefined;
}
