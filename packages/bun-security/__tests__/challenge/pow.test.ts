/**
 * The proof of work (layers.md L10.2): solved here, in the test, by trying
 * numbers as the page's script does; then every way an answer can be
 * wrong. Its wire format is checked against ALTCHA v1's own verification,
 * re-stated below from altcha-lib's `src/v1/index.ts` (`verifySolution`),
 * so the MIT widget's payload verifies here and ours would verify there.
 */
import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { ConfigError } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { powChallenge, solvePowChallenge } from "../../lib/challenge/pow";
import type { PowChallengeData } from "../../lib/challenge/pow";
import type { ChallengeContext } from "../../lib/challenge/types";
import { cacheStore } from "../../lib/stores/index";
import { fakeClock } from "../helpers";

const SECRET = "pow-secret-0123456789-0123456789-abcdef";
const CONTEXT: ChallengeContext = {
  client: "203.0.113.10",
  risk: 0,
  hostname: "app.test",
};

/** A small challenge, so solving it in the test is quick. */
function provider(now = Date.now) {
  return powChallenge({ secret: SECRET, maxNumber: 2000, now });
}

/** Issues a challenge and returns its data. */
async function issue(
  pow: ReturnType<typeof powChallenge>,
  context: ChallengeContext = CONTEXT,
): Promise<PowChallengeData> {
  return (await pow.issue(context)).data as PowChallengeData;
}

/** A payload with fields replaced. */
function payloadWith(answer: string, change: Record<string, unknown>): string {
  const payload = JSON.parse(
    Buffer.from(answer, "base64").toString("utf8"),
  ) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...payload, ...change })).toString(
    "base64",
  );
}

/**
 * ALTCHA v1's server check, re-stated from altcha-lib (`verifySolution`):
 * the expiry parameter of the salt, then `createChallenge` re-run with the
 * payload's number and salt — `challenge = hex(SHA-256(salt + number))`
 * and `signature = hex(HMAC(key, challenge))` — compared with the payload.
 */
function altchaVerifySolution(answer: string, hmacKey: string, now: number) {
  const payload = JSON.parse(atob(answer)) as {
    algorithm: string;
    challenge: string;
    number: number;
    salt: string;
    signature: string;
  };
  const params = new URLSearchParams(payload.salt.split("?")[1] ?? "");
  const expires = params.get("expires");
  if (expires && Number.parseInt(expires, 10) * 1000 < now) return false;
  let salt = payload.salt;
  if (!salt.endsWith("&")) salt += "&";
  const challenge = createHash("sha256")
    .update(salt + payload.number)
    .digest("hex");
  const signature = createHmac("sha256", hmacKey)
    .update(challenge)
    .digest("hex");
  return (
    payload.algorithm === "SHA-256" &&
    challenge === payload.challenge &&
    signature === payload.signature
  );
}

describe("powChallenge", () => {
  it("issues a challenge the test solves, and verifies the answer", async () => {
    const pow = provider();
    const descriptor = await pow.issue(CONTEXT);
    expect(descriptor.provider).toBe("pow");
    expect(descriptor.field).toBe("altcha");
    expect(pow.field).toBe("altcha");
    expect(descriptor.script).toContain("crypto.subtle.digest");
    const data = descriptor.data as PowChallengeData;
    expect(data.algorithm).toBe("SHA-256");
    expect(data.maxnumber).toBe(2000);
    expect(data.salt).toMatch(/^[0-9a-f]{24}\?expires=\d+&c=[0-9a-f]{16}&$/);
    // The data rides in a JSON data block (never run, so no CSP source
    // needed) and holds no raw `<` that could close it.
    const block =
      /<script type="application\/json" id="bun-security-pow">(.*?)<\/script>/.exec(
        descriptor.html,
      );
    expect(block?.[1]).not.toContain("<");
    const answer = solvePowChallenge(data);
    expect(answer).toBeString();
    expect(await pow.verify(answer!, CONTEXT)).toEqual({ ok: true });
  });

  it("speaks ALTCHA v1: our answer passes ALTCHA's check, and ALTCHA's check fails a wrong one", async () => {
    const pow = provider();
    const data = await issue(pow);
    const answer = solvePowChallenge(data)!;
    expect(altchaVerifySolution(answer, SECRET, Date.now())).toBe(true);
    // Negative control: the reference itself refuses a wrong number and a wrong key.
    const number = (
      JSON.parse(Buffer.from(answer, "base64").toString()) as { number: number }
    ).number;
    expect(
      altchaVerifySolution(
        payloadWith(answer, { number: number + 1 }),
        SECRET,
        Date.now(),
      ),
    ).toBe(false);
    expect(altchaVerifySolution(answer, `${SECRET}x`, Date.now())).toBe(false);
  });

  it("accepts ALTCHA's widget payload, which adds `took`", async () => {
    const pow = provider();
    const answer = solvePowChallenge(await issue(pow))!;
    expect(
      await pow.verify(payloadWith(answer, { took: 812 }), CONTEXT),
    ).toEqual({ ok: true });
  });

  it("refuses an answer used twice (the replay cache)", async () => {
    const pow = provider();
    const answer = solvePowChallenge(await issue(pow))!;
    expect((await pow.verify(answer, CONTEXT)).ok).toBe(true);
    expect(await pow.verify(answer, CONTEXT)).toEqual({
      ok: false,
      reason: "replayed",
    });
  });

  it("refuses an expired challenge, and accepts it until then", async () => {
    const clock = fakeClock();
    const pow = provider(clock.now);
    const late = solvePowChallenge(await issue(pow))!;
    const onTime = solvePowChallenge(await issue(pow))!;
    clock.advance(299_000);
    expect((await pow.verify(onTime, CONTEXT)).ok).toBe(true);
    clock.advance(1_000);
    expect(await pow.verify(late, CONTEXT)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("binds a challenge to the client's network: another /24 is refused, the same /24 passes", async () => {
    const pow = provider();
    const answer = solvePowChallenge(await issue(pow))!;
    expect(
      await pow.verify(answer, { ...CONTEXT, client: "198.51.100.10" }),
    ).toEqual({ ok: false, reason: "another client's challenge" });
    expect(
      (await pow.verify(answer, { ...CONTEXT, client: "203.0.113.99" })).ok,
    ).toBe(true);
  });

  it("refuses a forged challenge: a changed salt, a changed challenge, a wrong number, another key's signature", async () => {
    const pow = provider();
    const data = await issue(pow);
    const answer = solvePowChallenge(data)!;
    const number = (
      JSON.parse(Buffer.from(answer, "base64").toString()) as { number: number }
    ).number;
    // A later expiry written into the salt: the challenge no longer hashes.
    const later = data.salt.replace(/expires=(\d+)/, (_, s: string) => {
      return `expires=${Number(s) + 3600}`;
    });
    expect(
      await pow.verify(payloadWith(answer, { salt: later }), CONTEXT),
    ).toEqual({ ok: false, reason: "wrong number" });
    // A challenge the client made itself for another number than the
    // secret one: its signature fails. (Never the secret number itself:
    // that would rebuild the real challenge, signature and all; a fixed 0
    // did, one run in 2001, seed 19554.)
    const easyNumber = number === 0 ? 1 : 0;
    const easy = createHash("sha256")
      .update(`${data.salt}${easyNumber}`)
      .digest("hex");
    expect(easy).not.toBe(data.challenge);
    expect(
      await pow.verify(
        payloadWith(answer, { challenge: easy, number: easyNumber }),
        CONTEXT,
      ),
    ).toEqual({ ok: false, reason: "bad signature" });
    // Signed with another key.
    const other = powChallenge({ secret: `${SECRET}-other`, maxNumber: 2000 });
    const foreign = solvePowChallenge(await issue(other))!;
    expect((await pow.verify(foreign, CONTEXT)).ok).toBe(false);
    // The wrong number.
    expect(
      await pow.verify(payloadWith(answer, { number: number + 1 }), CONTEXT),
    ).toEqual({ ok: false, reason: "wrong number" });
  });

  it("refuses what is not a payload", async () => {
    const pow = provider();
    const answer = solvePowChallenge(await issue(pow))!;
    expect((await pow.verify("not base64 json", CONTEXT)).ok).toBe(false);
    expect(
      await pow.verify(payloadWith(answer, { algorithm: "SHA-1" }), CONTEXT),
    ).toEqual({ ok: false, reason: "malformed payload" });
    expect(
      await pow.verify(payloadWith(answer, { number: "7" }), CONTEXT),
    ).toEqual({ ok: false, reason: "malformed payload" });
    expect(
      await pow.verify(payloadWith(answer, { number: -1 }), CONTEXT),
    ).toEqual({ ok: false, reason: "malformed payload" });
    expect(await pow.verify("A".repeat(5000), CONTEXT)).toEqual({
      ok: false,
      reason: "oversized answer",
    });
  });

  it("asks more work as the request's risk grows, up to the cap", async () => {
    const pow = powChallenge({
      secret: SECRET,
      maxNumber: 1000,
      riskFactor: 2,
      maxNumberCap: 4000,
    });
    expect((await issue(pow, { ...CONTEXT, risk: 0 })).maxnumber).toBe(1000);
    expect((await issue(pow, { ...CONTEXT, risk: 1 })).maxnumber).toBe(3000);
    expect((await issue(pow, { ...CONTEXT, risk: 9 })).maxnumber).toBe(4000);
    expect((await issue(pow, { ...CONTEXT, risk: -5 })).maxnumber).toBe(1000);
  });

  it("forgets answered salts once they expire, so the cache stays bounded", async () => {
    const clock = fakeClock();
    const pow = powChallenge({
      secret: SECRET,
      maxNumber: 200,
      maxReplay: 2,
      now: clock.now,
    });
    for (let i = 0; i < 5; i++) {
      const answer = solvePowChallenge(await issue(pow))!;
      expect((await pow.verify(answer, CONTEXT)).ok).toBe(true);
    }
    // Past the bound the oldest are dropped; a fresh one still verifies once.
    const last = solvePowChallenge(await issue(pow))!;
    expect((await pow.verify(last, CONTEXT)).ok).toBe(true);
    expect((await pow.verify(last, CONTEXT)).ok).toBe(false);
  });

  it("refuses a short secret and bad bounds", () => {
    expect(() => powChallenge({ secret: "short" })).toThrow(ConfigError);
    expect(() => powChallenge({ secret: SECRET, maxNumber: 0 })).toThrow(
      /maxNumber must be a positive whole number/,
    );
    expect(() => powChallenge({ secret: SECRET, expiresIn: 1.5 })).toThrow(
      /expiresIn/,
    );
  });

  it("solvePowChallenge answers undefined when no number fits", () => {
    expect(
      solvePowChallenge({
        algorithm: "SHA-256",
        challenge: "0".repeat(64),
        maxnumber: 50,
        salt: "ab?expires=1&",
        signature: "",
      }),
    ).toBeUndefined();
  });
});

describe("powChallenge across processes (PR-S4's shared store)", () => {
  /** Two providers, as two processes would build them, over one store. */
  function fleet(store?: Parameters<typeof powChallenge>[0]["store"]) {
    const make = () =>
      powChallenge({
        secret: SECRET,
        maxNumber: 300,
        ...(store ? { store } : {}),
      });
    return [make(), make()] as const;
  }

  it("refuses an answer replayed to another process sharing the store", async () => {
    const driver = memoryDriver();
    const store = cacheStore(createCache({ driver }), { logger: () => {} });
    const [a, b] = fleet(store);
    const answer = solvePowChallenge(await issue(a))!;
    expect(await a.verify(answer, CONTEXT)).toEqual({ ok: true });
    expect(await b.verify(answer, CONTEXT)).toEqual({
      ok: false,
      reason: "replayed",
    });
    await store.close();
  });

  it("negative control: without the store, the other process accepts the replay", async () => {
    const [a, b] = fleet();
    const answer = solvePowChallenge(await issue(a))!;
    expect((await a.verify(answer, CONTEXT)).ok).toBe(true);
    expect((await b.verify(answer, CONTEXT)).ok).toBe(true);
  });

  it("lets the local cache decide when the store fails or is slow", async () => {
    let calls = 0;
    const failing = {
      increment: () => {
        calls++;
        return Promise.reject(new Error("down"));
      },
    };
    const [a] = fleet(failing);
    const answer = solvePowChallenge(await issue(a))!;
    expect((await a.verify(answer, CONTEXT)).ok).toBe(true);
    // The same process still refuses the replay, from its own cache.
    expect(await a.verify(answer, CONTEXT)).toEqual({
      ok: false,
      reason: "replayed",
    });
    expect(calls).toBe(1);
    const hanging = powChallenge({
      secret: SECRET,
      maxNumber: 300,
      storeTimeoutMs: 20,
      store: { increment: () => new Promise<number>(() => {}) },
    });
    const slow = solvePowChallenge(await issue(hanging))!;
    const started = performance.now();
    expect((await hanging.verify(slow, CONTEXT)).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("marks each salt with its remaining lifetime", async () => {
    const clock = fakeClock();
    const seen: { key: string; ttl: number | null }[] = [];
    const pow = powChallenge({
      secret: SECRET,
      maxNumber: 300,
      now: clock.now,
      store: {
        increment: (key, _by, ttl) => {
          seen.push({ key, ttl });
          return Promise.resolve(1);
        },
      },
    });
    const answer = solvePowChallenge(await issue(pow))!;
    clock.advance(100_000);
    expect((await pow.verify(answer, CONTEXT)).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.key).toMatch(/^pow:used:[0-9a-f]{32}$/);
    expect(seen[0]!.ttl).toBe(200_000);
  });
});
