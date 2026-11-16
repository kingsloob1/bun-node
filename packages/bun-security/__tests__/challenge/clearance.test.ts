/**
 * Clearance tokens (layers.md L10.2): signed with bun-common's cookie
 * signing, bound to the client's network and a hash of its `User-Agent`.
 * A tampered, expired, wrong-client or wrong-browser token is refused, each
 * for its own reason; a valid one passes from any address in the same
 * /24 (/64 for IPv6).
 */
import { signCookie } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import {
  clearanceNetwork,
  clearanceRefusal,
  clearanceToken,
  mintClearance,
} from "../../lib/challenge/clearance";
import { fakeClock } from "../helpers";

const SECRET = "clearance-secret-0123456789-0123456789";
const SUBJECT = { client: "203.0.113.10", userAgent: "Mozilla/5.0 Test" };

describe("clearance tokens", () => {
  it("names the network a token is bound to", () => {
    expect(clearanceNetwork("203.0.113.10")).toBe("203.0.113.0/24");
    expect(clearanceNetwork("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clearanceNetwork("")).toBe("-");
    expect(clearanceNetwork("not an address")).toBe("-");
  });

  it("passes a valid token until it expires, then refuses it as expired", () => {
    const clock = fakeClock();
    const token = mintClearance(SECRET, SUBJECT, clock.now() + 60_000);
    expect(token).toMatch(/^v1\.\d+\.[\w-]+\.[\w-]+\.[\w+/]+$/);
    expect(
      clearanceRefusal(SECRET, token, SUBJECT, clock.now()),
    ).toBeUndefined();
    clock.advance(59_000);
    expect(
      clearanceRefusal(SECRET, token, SUBJECT, clock.now()),
    ).toBeUndefined();
    clock.advance(1_000);
    expect(clearanceRefusal(SECRET, token, SUBJECT, clock.now())).toBe(
      "expired",
    );
  });

  it("refuses a tampered token: any changed character of the value or the signature", () => {
    const now = Date.now();
    const token = mintClearance(SECRET, SUBJECT, now + 60_000);
    for (let index = 0; index < token.length; index++) {
      const char = token[index] === "A" ? "B" : "A";
      const tampered = token.slice(0, index) + char + token.slice(index + 1);
      if (tampered === token) continue;
      // A dot replaced changes the fields; every other change, the signature.
      expect(["signature", "format"]).toContain(
        clearanceRefusal(SECRET, tampered, SUBJECT, now)!,
      );
    }
    // A later expiry written in: the signature no longer matches.
    const [version, expiry, ...rest] = token.split(".");
    const extended = [version, String(Number(expiry) + 86_400), ...rest].join(
      ".",
    );
    expect(clearanceRefusal(SECRET, extended, SUBJECT, now)).toBe("signature");
  });

  it("refuses a token signed with another secret", () => {
    const now = Date.now();
    const token = mintClearance(`${SECRET}-other`, SUBJECT, now + 60_000);
    expect(clearanceRefusal(SECRET, token, SUBJECT, now)).toBe("signature");
  });

  it("refuses a token from another network or another browser, and passes within the /24", () => {
    const now = Date.now();
    const token = mintClearance(SECRET, SUBJECT, now + 60_000);
    expect(
      clearanceRefusal(
        SECRET,
        token,
        { ...SUBJECT, client: "198.51.100.10" },
        now,
      ),
    ).toBe("client");
    expect(
      clearanceRefusal(
        SECRET,
        token,
        { ...SUBJECT, userAgent: "curl/8.0" },
        now,
      ),
    ).toBe("client");
    expect(
      clearanceRefusal(
        SECRET,
        token,
        { ...SUBJECT, client: "203.0.113.200" },
        now,
      ),
    ).toBeUndefined();
  });

  it("binds IPv6 to the /64", () => {
    const now = Date.now();
    const subject = { client: "2001:db8:1:2::10", userAgent: "ua" };
    const token = mintClearance(SECRET, subject, now + 60_000);
    expect(
      clearanceRefusal(
        SECRET,
        token,
        { ...subject, client: "2001:db8:1:2:ffff::1" },
        now,
      ),
    ).toBeUndefined();
    expect(
      clearanceRefusal(
        SECRET,
        token,
        { ...subject, client: "2001:db8:1:3::10" },
        now,
      ),
    ).toBe("client");
  });

  it("refuses a well-signed value that is not a token, and an oversized one", () => {
    const now = Date.now();
    expect(
      clearanceRefusal(SECRET, signCookie("hello", SECRET), SUBJECT, now),
    ).toBe("format");
    expect(
      clearanceRefusal(
        SECRET,
        signCookie("v2.9999999999.n.b", SECRET),
        SUBJECT,
        now,
      ),
    ).toBe("format");
    expect(
      clearanceRefusal(SECRET, signCookie("v1.99x.n.b", SECRET), SUBJECT, now),
    ).toBe("format");
    expect(clearanceRefusal(SECRET, "x".repeat(600), SUBJECT, now)).toBe(
      "format",
    );
    expect(clearanceRefusal(SECRET, "no-dot", SUBJECT, now)).toBe("signature");
  });

  it("reads the token from its header first, else its cookie", () => {
    expect(
      clearanceToken(
        { "x-c": "from-header", cookie: "c=from-cookie" },
        "c",
        "x-c",
      ),
    ).toBe("from-header");
    expect(clearanceToken({ cookie: "a=1; c=from-cookie" }, "c", "x-c")).toBe(
      "from-cookie",
    );
    expect(clearanceToken({ cookie: "a=1" }, "c", "x-c")).toBeUndefined();
    expect(clearanceToken({}, "c", "x-c")).toBeUndefined();
  });
});
