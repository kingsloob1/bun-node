/**
 * A `/0` range (bun-node#822): every address of a family. It is refused
 * wherever a policy or an option takes a range — a list entry's `ip`, the
 * internal ranges, a request rule's `client.cidr`, `ipIntel()`'s static
 * ranges and `ban()` — and the refusal says why, instead of calling a valid
 * range unparseable. `not-an-ip` keeps its own message everywhere.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import { ipIntel } from "../../lib/intel/intel";
import {
  isWholeFamilyRange,
  parseCidr,
  WHOLE_FAMILY_RANGE,
} from "../../lib/ip/address";
import { validatePolicy } from "../../lib/policy/schema";

/** Every spelling of a `/0`: both families, the IPv4 netmask, and the IPv4-mapped `/96`. */
const WHOLE = [
  "0.0.0.0/0",
  "203.0.113.9/0",
  "0.0.0.0/0.0.0.0",
  "::/0",
  "2001:db8::/0",
  "::ffff:0:0/96",
  "::ffff:203.0.113.9/96",
];

/** Ranges that are not `/0`, accepted or refused for another reason. */
const NOT_WHOLE = [
  "0.0.0.0/1",
  "128.0.0.0/1",
  "::/1",
  "::ffff:0:0/97",
  "2001:db8::/96",
  "10.0.0.0/8",
  "203.0.113.9",
  "not-an-ip",
  "not-an-ip/0",
  "0.0.0.0/",
  "/0",
];

/** The policy's issues, as `path: message` lines. */
function issues(policy: unknown): string[] {
  return validatePolicy(policy).map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
}

describe("isWholeFamilyRange", () => {
  it("recognises every /0, and parseCidr refuses each", () => {
    for (const range of WHOLE) {
      expect({ range, whole: isWholeFamilyRange(range) }).toEqual({
        range,
        whole: true,
      });
      expect({ range, parsed: parseCidr(range) }).toEqual({
        range,
        parsed: null,
      });
    }
  });

  it("recognises nothing else (the control)", () => {
    for (const range of [...NOT_WHOLE, 0, undefined, "x".repeat(100)]) {
      expect({ range, whole: isWholeFamilyRange(range) }).toEqual({
        range,
        whole: false,
      });
    }
  });
});

describe("where a range is taken, a /0 is refused saying why", () => {
  it("a list entry's ip (the issue's reproduction)", () => {
    expect(
      issues({
        lists: [
          "0.0.0.0/0",
          "::/0",
          "::ffff:0:0/96",
          "1.0.0.0/1",
          "not-an-ip",
        ].map((ip) => ({ ip, action: "block" })),
      }),
    ).toEqual([
      `lists.0.ip: ${WHOLE_FAMILY_RANGE}; use a request rule instead`,
      `lists.1.ip: ${WHOLE_FAMILY_RANGE}; use a request rule instead`,
      `lists.2.ip: ${WHOLE_FAMILY_RANGE}; use a request rule instead`,
      'lists.4.ip: is not an IP address or CIDR range: "not-an-ip"',
    ]);
  });

  it("through createSecurity, as the issue ran it", () => {
    const message = (ip: string): string => {
      try {
        createSecurity({
          policy: { lists: [{ ip, action: "block" }] },
        }).close();
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    expect(message("0.0.0.0/0")).toContain(
      `lists[0].ip: ${WHOLE_FAMILY_RANGE}; use a request rule instead`,
    );
    expect(message("not-an-ip")).toContain(
      'is not an IP address or CIDR range: "not-an-ip"',
    );
    expect(message("10.0.0.0/8")).toBe("accepted");
  });

  it("the internal ranges", () => {
    const found = issues({ internal: { ranges: ["::/0", "nope"] } });
    expect(found[0]).toStartWith(
      `internal.ranges.0: ${WHOLE_FAMILY_RANGE}; the internal list can only be narrowed`,
    );
    expect(found[1]).toBe('internal.ranges.1: is not a CIDR range: "nope"');
  });

  it("a request rule's client.cidr", () => {
    const found = issues({
      requestRules: {
        rules: [
          { id: "a", when: { client: { cidr: "0.0.0.0/0" } }, action: "block" },
          {
            id: "b",
            when: { client: { cidr: ["10.0.0.0/8", "::ffff:0:0/96"] } },
            action: "block",
          },
          { id: "c", when: { client: { cidr: "not-an-ip" } }, action: "block" },
        ],
      },
    });
    expect(found).toEqual([
      `requestRules.rules.0.when.client.cidr: ${WHOLE_FAMILY_RANGE}; leave the cidr matcher out to match every client`,
      `requestRules.rules.1.when.client.cidr.1: ${WHOLE_FAMILY_RANGE}; leave the cidr matcher out to match every client`,
      'requestRules.rules.2.when.client.cidr: must be an address or a range ("203.0.113.0/24"); got "not-an-ip"',
    ]);
  });

  it("ipIntel()'s static ranges", async () => {
    await expect(ipIntel({ ranges: { all: ["::/0"] } })).rejects.toThrow(
      `ipIntel(): ranges.all: ${WHOLE_FAMILY_RANGE} ("::/0"), so the class would name every client`,
    );
    await expect(ipIntel({ ranges: { bad: ["not-an-ip"] } })).rejects.toThrow(
      'ipIntel(): ranges.bad: not an address or range: "not-an-ip"',
    );
  });

  it("ban()", () => {
    const security = createSecurity({ policy: {} });
    try {
      expect(() =>
        security.ban({ ip: "0.0.0.0/0", duration: "1h", reason: "everyone" }),
      ).toThrow(
        `bun-security: ban(): ${WHOLE_FAMILY_RANGE} ("0.0.0.0/0"), so the ban would refuse every client; use a request rule instead`,
      );
      expect(() =>
        security.ban({ ip: "not-an-ip", duration: "1h", reason: "x" }),
      ).toThrow(
        'bun-security: ban(): "not-an-ip" is not an address or CIDR range',
      );
    } finally {
      security.close();
    }
  });
});
