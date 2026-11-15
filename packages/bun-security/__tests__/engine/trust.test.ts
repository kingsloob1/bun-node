/**
 * Layer L2.5, the trust check (layers.md L2.5; README §11.2 T-L2-5): a wrong
 * `trustProxy` that sends every client to the proxy, or into an internal
 * range, raises a warning within its window on a public service.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createSecurity, requestFacts } from "../../lib/index";
import type {
  Security,
  RequestFacts,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import { fakeClock } from "../helpers";
import type { FakeClock } from "../helpers";

/** A request from the edge proxy `peer`, its real client in `X-Forwarded-For`. */
function proxied(
  peer: string,
  client: string,
  trustProxy?: string[],
): RequestFacts {
  return requestFacts(
    new Request("http://app.test/", { headers: { "x-forwarded-for": client } }),
    {
      peer,
      ...(trustProxy ? { trustProxy } : {}),
    },
  );
}

/** An engine with a fake clock, collecting warnings. */
function monitored(policy: SecurityPolicy): {
  security: Security;
  clock: FakeClock;
  warnings: SecurityWarning[];
} {
  const clock = fakeClock();
  const warnings: SecurityWarning[] = [];
  const security = createSecurity({
    policy,
    now: clock.now,
    logger: () => {},
    onWarning: (warning) => warnings.push(warning),
  });
  return { security, clock, warnings };
}

/** Sends `perMinute` requests a minute for `minutes` minutes, then one more to close the last. */
function drive(
  { security, clock }: { security: Security; clock: FakeClock },
  minutes: number,
  perMinute: number,
  request: (i: number) => RequestFacts,
): void {
  for (let minute = 0; minute < minutes; minute++) {
    for (let i = 0; i < perMinute; i++) {
      void security.evaluate(request(i));
    }
    clock.advance(60_000);
  }
  void security.evaluate(request(0));
}

describe("T-L2-5: a wrong trustProxy is detected within its window", () => {
  it("every client collapses to a public proxy: forwarding headers never read", () => {
    const harness = monitored({ service: "checkout", public: true });
    // trustProxy is missing: the edge (public) is every request's client.
    drive(harness, 4, 30, (i) => proxied("198.51.100.1", `203.0.113.${i}`));
    expect(harness.warnings).toEqual([]);
    drive(harness, 1, 30, (i) => proxied("198.51.100.1", `203.0.113.${i}`));
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]).toMatchObject({
      kind: "trust.unread-forwarding",
      service: "checkout",
      minutes: 5,
      share: 1,
    });
    // Raised once, not every minute after.
    drive(harness, 3, 30, (i) => proxied("198.51.100.1", `203.0.113.${i}`));
    expect(harness.warnings).toHaveLength(1);
    expect(harness.security.status().trust.warnings).toHaveLength(1);
  });

  it("every client resolves into the internal list (a CGNAT edge, 100.64.0.0/10)", () => {
    const harness = monitored({ public: true, trustCheck: { window: "3m" } });
    // Trusting one hop too many: the client is the CGNAT edge hop.
    drive(harness, 3, 25, () =>
      proxied("10.0.0.1", "100.64.3.4", ["10.0.0.0/8"]),
    );
    expect(harness.warnings.map((warning) => warning.kind)).toEqual([
      "trust.internal",
    ]);
    expect(harness.warnings[0]?.message).toContain("internal address");
  });

  it("negative control: the right trustProxy raises nothing", () => {
    const harness = monitored({ public: true });
    drive(harness, 8, 30, (i) =>
      proxied("10.0.0.1", `203.0.113.${i}`, ["10.0.0.0/8"]),
    );
    expect(harness.warnings).toEqual([]);
    const recent = harness.security.status().trust.recent;
    expect(recent.at(-1)).toMatchObject({
      requests: 30,
      internal: 0,
      unreadForwarding: 0,
      distinctClients: 30,
      distinctPeers: 1,
    });
  });

  it("negative control: a service whose policy does not say it is public is never warned about", () => {
    const harness = monitored({});
    drive(harness, 8, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.warnings).toEqual([]);
    expect(
      harness.security.status().trust.recent.at(-1)?.unreadForwarding,
    ).toBe(30);
  });

  it("a quiet minute (under minRequests) breaks the run", () => {
    const harness = monitored({ public: true });
    drive(harness, 4, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    drive(harness, 1, 5, () => proxied("198.51.100.1", "203.0.113.1"));
    drive(harness, 4, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.warnings).toEqual([]);
  });

  it("a minute with no requests at all breaks the run", () => {
    const harness = monitored({ public: true });
    drive(harness, 3, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    harness.clock.advance(120_000);
    drive(harness, 3, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.warnings).toEqual([]);
  });

  it("is off with trustCheck: false", () => {
    const harness = monitored({ public: true, trustCheck: false });
    drive(harness, 6, 30, () => proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.warnings).toEqual([]);
    expect(harness.security.status().trust).toMatchObject({
      enabled: false,
      recent: [],
    });
  });

  it("does not count verified service calls, whose client comes from a credential", () => {
    const token = "t0ken-for-jobs";
    const harness = monitored({
      public: true,
      serviceIdentity: {
        services: [
          {
            id: "jobs",
            verifier: `sha256:${createHash("sha256").update(token).digest("hex")}`,
          },
        ],
      },
    });
    drive(harness, 6, 30, () =>
      requestFacts(
        new Request("http://app.test/", {
          headers: { "x-service-token": token },
        }),
        { peer: "10.0.0.5" },
      ),
    );
    expect(harness.warnings).toEqual([]);
    expect(harness.security.status().trust.recent).toEqual([]);
  });

  it("explain() writes no gauges", () => {
    const harness = monitored({ public: true });
    for (let i = 0; i < 50; i++)
      void harness.security.explain(proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.security.status().trust.current).toBeUndefined();
  });

  it("status() closes a minute that has ended", () => {
    const harness = monitored({ public: true });
    void harness.security.evaluate(proxied("198.51.100.1", "203.0.113.1"));
    expect(harness.security.status().trust.current?.requests).toBe(1);
    harness.clock.advance(60_000);
    const status = harness.security.status().trust;
    expect(status.current).toBeUndefined();
    expect(status.recent).toHaveLength(1);
  });

  it("logs the warning through the logger", () => {
    const lines: string[] = [];
    const clock = fakeClock();
    const security = createSecurity({
      policy: { public: true, trustCheck: { window: "1m" } },
      now: clock.now,
      logger: (event) => lines.push(`${event.level} ${event.message}`),
    });
    drive({ security, clock }, 1, 30, () =>
      proxied("198.51.100.1", "203.0.113.1"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith(
      "warn 100% of requests carry forwarding headers",
    );
  });
});
