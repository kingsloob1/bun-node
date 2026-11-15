/**
 * Layer L2: the client and its keys on the trust-proxy foundation, and
 * service identity (layers.md L2.1–L2.4; README §11.2 T-L2-1, T-L2-4).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createSecurity, requestFacts } from "../../lib/index";
import type { Decision, RequestFacts, SecurityPolicy } from "../../lib/index";
import { facts } from "../helpers";

/** Evaluates synchronously. */
function decide(policy: SecurityPolicy, request: RequestFacts): Decision {
  const decision = createSecurity({ policy }).evaluate(request);
  if (decision instanceof Promise)
    throw new Error("expected a synchronous decision");
  return decision;
}

/** A request from `peer` with these headers, resolved with `trustProxy`. */
function viaSocket(
  peer: string,
  headers: Record<string, string> = {},
  trustProxy?: string[] | number | boolean,
): RequestFacts {
  return requestFacts(new Request("http://app.test/login", { headers }), {
    peer,
    ...(trustProxy === undefined ? {} : { trustProxy }),
  });
}

describe("T-L2-1: a spoofed X-Forwarded-For from an untrusted peer", () => {
  const spoof = { "x-forwarded-for": "198.51.100.66" };

  it("the peer is the client, with trustProxy off", () => {
    const request = viaSocket("203.0.113.9", spoof);
    expect(request.client).toBe("203.0.113.9");
    expect(
      decide({ lists: [{ ip: "198.51.100.66", action: "block" }] }, request)
        .action,
    ).toBe("allow");
    expect(
      decide({ lists: [{ ip: "203.0.113.9", action: "block" }] }, request)
        .action,
    ).toBe("block");
  });

  it("the peer is the client when it is not a trusted proxy", () => {
    const request = viaSocket("203.0.113.9", spoof, ["10.0.0.0/8"]);
    expect(
      decide({ lists: [{ ip: "198.51.100.66", action: "block" }] }, request)
        .action,
    ).toBe("allow");
    expect(
      decide({ lists: [{ ip: "203.0.113.9", action: "block" }] }, request)
        .action,
    ).toBe("block");
  });

  it("through a trusted proxy, the walk stops at the first untrusted hop, not the left-most entry", () => {
    const request = viaSocket(
      "10.0.0.1",
      { "x-forwarded-for": "198.51.100.66, 203.0.113.5" },
      ["10.0.0.0/8"],
    );
    expect(request.client).toBe("203.0.113.5");
    expect(
      decide({ lists: [{ ip: "203.0.113.5", action: "block" }] }, request)
        .action,
    ).toBe("block");
    expect(
      decide({ lists: [{ ip: "198.51.100.66", action: "block" }] }, request)
        .action,
    ).toBe("allow");
  });

  it("negative control: trustProxy true reaches the client-written entry", () => {
    const request = viaSocket(
      "10.0.0.1",
      { "x-forwarded-for": "198.51.100.66, 203.0.113.5" },
      true,
    );
    expect(
      decide({ lists: [{ ip: "198.51.100.66", action: "block" }] }, request)
        .action,
    ).toBe("block");
  });
});

describe("the client address", () => {
  it("is normalised, IPv4-mapped to IPv4", () => {
    expect(decide({}, facts({ client: "::ffff:203.0.113.5" })).subject).toEqual(
      {
        address: "203.0.113.5",
        ip: "203.0.113.5",
      },
    );
  });

  it("keys IPv6 by the policy's prefix", () => {
    expect(decide({}, facts({ client: "2001:DB8:1:2::99" })).subject).toEqual({
      address: "2001:db8:1:2::99",
      ip: "2001:db8:1:2::/64",
    });
    expect(
      decide(
        { keys: { ipv6Prefix: 48 } },
        facts({ client: "2001:db8:1:2::99" }),
      ).subject.ip,
    ).toBe("2001:db8:1::/48");
  });

  it("falls back to the last good address when a malformed entry ended the walk (layers.md L2.2 item 7)", () => {
    const request = viaSocket(
      "10.0.0.1",
      { "x-forwarded-for": "garbage, 203.0.113.5" },
      true,
    );
    expect(request.client).toBe("garbage");
    expect(
      decide({ lists: [{ ip: "203.0.113.5", action: "block" }] }, request)
        .action,
    ).toBe("block");
  });

  it("counts against nobody when there is no address at all", () => {
    const decision = decide(
      {},
      facts({
        client: "",
        peer: "",
        chain: [{ address: "", source: "socket", trusted: false }],
      }),
    );
    expect(decision.subject).toEqual({});
  });

  it("carries identify()'s keys, bounding a long one by its SHA-256", () => {
    const long = "u".repeat(300);
    const decision = decide(
      {},
      facts({
        identity: {
          user: "u_1",
          session: "s",
          tenant: "t",
          apiKey: "k",
          scopes: ["a"],
        },
      }),
    );
    expect(decision.subject).toMatchObject({
      user: "u_1",
      session: "s",
      tenant: "t",
      apiKey: "k",
    });
    expect(decide({}, facts({ identity: { user: long } })).subject.user).toBe(
      `sha256:${createHash("sha256").update(long).digest("hex")}`,
    );
  });
});

describe("service identity (layers.md L2.4)", () => {
  const token = "svc-token-pay-api-0123456789";
  const verifier = `sha256:${createHash("sha256").update(token).digest("hex")}`;
  /** A policy with pay-api as a sibling, and a block on its egress address and on an end user. */
  const policy = (
    forwardsClientIp: boolean,
    exempt?: ("lists" | "bans")[],
  ): SecurityPolicy => ({
    serviceIdentity: {
      services: [
        {
          id: "pay-api",
          verifier,
          forwardsClientIp,
          ...(exempt ? { exempt } : {}),
        },
      ],
    },
    lists: [
      { id: "egress", ip: "203.0.113.200", action: "block" },
      { id: "user", ip: "198.51.100.7", action: "block" },
    ],
  });
  /** A call from pay-api's egress address. */
  const call = (headers: Record<string, string>) =>
    viaSocket("203.0.113.200", headers);

  it("T-L2-4: a verified sibling is never refused by its egress address", () => {
    const decision = decide(policy(false), call({ "x-service-token": token }));
    expect(decision.action).toBe("allow");
    expect(decision.hits).toEqual([
      {
        layer: "L2",
        rule: "service:pay-api",
        action: "allow",
        reason: "verified service identity",
      },
    ]);
    // With no forwarded address, the call counts against nobody.
    expect(decision.subject).toEqual({ service: "pay-api" });
  });

  it("T-L2-4: the forwarded end user is the client for every key", () => {
    const decision = decide(
      policy(true, ["bans"]),
      call({ "x-service-token": token, "x-service-client-ip": "198.51.100.7" }),
    );
    expect(decision.subject).toEqual({
      address: "198.51.100.7",
      ip: "198.51.100.7",
      service: "pay-api",
    });
    expect(decision.action).toBe("block");
    expect(decision.hits.map((hit) => hit.rule)).toEqual([
      "service:pay-api",
      "user",
    ]);
  });

  it("exempt from lists by default, even with a forwarded end user", () => {
    const decision = decide(
      policy(true),
      call({ "x-service-token": token, "x-service-client-ip": "198.51.100.7" }),
    );
    expect(decision.action).toBe("allow");
  });

  it("believes no forwarded address from a service without forwardsClientIp, or one that does not parse", () => {
    expect(
      decide(
        policy(false, ["bans"]),
        call({
          "x-service-token": token,
          "x-service-client-ip": "198.51.100.7",
        }),
      ).subject,
    ).toEqual({ service: "pay-api" });
    expect(
      decide(
        policy(true, ["bans"]),
        call({ "x-service-token": token, "x-service-client-ip": "not-an-ip" }),
      ).subject,
    ).toEqual({ service: "pay-api" });
  });

  it("negative control: without the token the egress address is blocked, and a forwarded address is ignored", () => {
    const decision = decide(
      policy(true),
      call({ "x-service-client-ip": "198.51.100.99" }),
    );
    expect(decision.action).toBe("block");
    expect(decision.subject.address).toBe("203.0.113.200");
  });

  it("a wrong token is logged and the call treated as an ordinary client", () => {
    const decision = decide(policy(true), call({ "x-service-token": "wrong" }));
    expect(decision.action).toBe("block");
    expect(decision.hits[0]).toEqual({
      layer: "L2",
      rule: "service-identity",
      action: "log",
      reason: "invalid service token",
    });
  });

  it("reads custom header names, and accepts a second verifier during a rotation", () => {
    const next = "next-token";
    const custom: SecurityPolicy = {
      serviceIdentity: {
        header: "x-api-token",
        clientIpHeader: "x-concave-client-ip",
        services: [
          {
            id: "pay-api",
            verifier: [
              verifier,
              `sha256:${createHash("sha256").update(next).digest("hex")}`,
            ],
            forwardsClientIp: true,
          },
        ],
      },
    };
    const decision = decide(
      custom,
      call({
        "x-api-token": next,
        "x-concave-client-ip": "::ffff:198.51.100.7",
      }),
    );
    expect(decision.subject).toEqual({
      address: "198.51.100.7",
      ip: "198.51.100.7",
      service: "pay-api",
    });
  });

  it("ignores the header when the policy names no service", () => {
    expect(decide({}, call({ "x-service-token": token })).hits).toEqual([]);
  });
});
