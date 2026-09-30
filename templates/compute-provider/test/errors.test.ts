import { ProviderError } from "@kingsleyweb/bun-jobs/provider";
import { describe, expect, it } from "bun:test";
import { acmeError } from "../src/errors";

/**
 * The error table, on the answers the conformance kit does not send: codes
 * that are not Acme's, and `Retry-After` in every form a server might write.
 */

/** A non-OK answer with Acme's error body. */
function answer(
  status: number,
  code: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: { code } }, { status, headers });
}

/** A fixed clock, for the HTTP-date forms. */
const NOW = Date.parse("Wed, 30 Sep 2026 10:00:00 GMT");

describe("acmeError", () => {
  it("maps by status when the code is an Object.prototype member, not Acme's", async () => {
    for (const code of ["constructor", "__proto__", "toString"]) {
      const error = await acmeError(
        answer(429, code, { "retry-after": "5" }),
        NOW,
      );
      expect(error, code).toBeInstanceOf(ProviderError);
      expect(error.kind, code).toBe("throttled");
      expect(error.platformCode, code).toBeUndefined();
      expect(error.retryAfterMs, code).toBe(5_000);
    }
    const auth = await acmeError(answer(401, "hasOwnProperty"), NOW);
    expect(auth.kind).toBe("auth");
    expect(auth.platformCode).toBeUndefined();
  });

  it("maps a code in the table, and keeps it as the platform code", async () => {
    const error = await acmeError(answer(429, "QuotaExceeded"), NOW);
    expect(error.kind).toBe("quota");
    expect(error.platformCode).toBe("QuotaExceeded");
  });

  it("reads Retry-After as delay-seconds or an HTTP-date, and nothing else", async () => {
    const waits: [string, number | undefined][] = [
      ["120", 120_000],
      ["0", 0],
      // An HTTP-date: the difference from now, or 0 once it has passed.
      ["Wed, 30 Sep 2026 10:00:30 GMT", 30_000],
      ["Wednesday, 30-Sep-26 10:00:30 GMT", 30_000],
      ["Wed, 30 Sep 2026 09:00:00 GMT", 0],
      // Not RFC 9110: the controller's own backoff applies instead.
      ["0x10", undefined],
      ["1e3", undefined],
      ["1.5", undefined],
      ["-3", undefined],
      ["soon", undefined],
      ["", undefined],
    ];
    for (const [header, expected] of waits) {
      const error = await acmeError(
        answer(429, "RateLimited", { "retry-after": header }),
        NOW,
      );
      expect(error.retryAfterMs, JSON.stringify(header)).toBe(expected);
    }
  });
});
