/**
 * Layer L8, deception (layers.md L8). T-L8-1: a honeypot hit is answered as
 * a real route would be, and bans the client from its next request (weight
 * 10 through the ladder); a canary credential's use is refused at once,
 * bans the address (weight 100), logs an error and raises a `canary.used`
 * warning naming the canary. Negative controls: with the defence off the
 * scanner keeps going. Trap fields: rendered hidden, a filled one detected,
 * and `signal("trap.filled")` bans.
 */
import { describe, expect, it } from "bun:test";
import {
  createSecurity,
  DEFAULT_HONEYPOTS,
  DEFAULT_TRAP_FIELD,
  isTrapFilled,
  trapField,
} from "../../lib/index";
import type {
  Decision,
  RequestFacts,
  Security,
  SecurityPolicy,
  SecurityWarning,
} from "../../lib/index";
import { facts } from "../helpers";

/** An engine collecting its warnings and error lines. */
function engine(policy: SecurityPolicy) {
  const warnings: SecurityWarning[] = [];
  const errors: string[] = [];
  const security = createSecurity({
    // The managed probe set (on in dry run by default since PR-S12) is
    // left out: these cases are about the honeypots on the same paths.
    policy: { requestRules: { managed: false }, ...policy },
    onWarning: (warning) => warnings.push(warning),
    logger: (event) => {
      if (event.level === "error") errors.push(event.message);
    },
  });
  return { security, warnings, errors };
}

/** `evaluate()`, synchronously. */
function decide(security: Security, request: RequestFacts): Decision {
  const decision = security.evaluate(request);
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

/** A GET of `path` from `client`. */
const get = (path: string, client = "203.0.113.10") =>
  facts({ path, rawPath: path, client });

describe("T-L8-1: honeypot routes", () => {
  it("answer the hit as a real route would, then ban the client from its next request", () => {
    const { security } = engine({ deception: { honeypots: true } });
    expect(DEFAULT_HONEYPOTS).toEqual(["/wp-login.php", "/.env", "/admin.php"]);
    const hit = decide(security, get("/.env"));
    // Passed on to the app (which answers it as any unknown path): no block page.
    expect(hit.action).toBe("log");
    expect(hit.status).toBeUndefined();
    expect(hit.hits.map((h) => [h.rule, h.action])).toEqual([
      ["honeypot", "log"],
      ["ladder", "log"],
    ]);
    expect(hit.hits[1]?.reason).toContain("applies from the next request");
    // The next request, to anything, is refused.
    expect(decide(security, get("/")).action).toBe("ban");
    expect(security.bans()).toMatchObject([
      { id: "ip:203.0.113.10", rule: "ladder", source: "auto" },
    ]);
    // Another client is untouched.
    expect(decide(security, get("/", "203.0.113.11")).action).toBe("allow");
  });

  it("match in any case and below a prefix; answer 404 when asked", () => {
    const { security } = engine({
      deception: {
        honeypots: {
          paths: ["/wp-admin/*", "POST /xmlrpc.php"],
          answer: "not-found",
        },
      },
    });
    const hit = decide(security, get("/WP-Admin/setup.php"));
    expect(hit).toMatchObject({
      action: "block",
      status: 404,
      code: "not_found",
    });
    expect(decide(security, get("/xmlrpc.php", "198.51.100.1")).action).toBe(
      "allow",
    );
  });

  it("in dry run only log; off by default", () => {
    const dry = engine({
      deception: { honeypots: { mode: "dryRun" } },
    }).security;
    for (let i = 0; i < 3; i++)
      expect(decide(dry, get("/.env")).action).toBe("log");
    expect(dry.bans()).toEqual([]);
    // Negative control: without honeypots the scanner keeps going.
    const off = engine({}).security;
    for (let i = 0; i < 5; i++)
      expect(decide(off, get("/.env")).action).toBe("allow");
    expect(off.bans()).toEqual([]);
  });

  it("feed counted rules with `honeypot.hit`, their bans also from the next request", () => {
    const { security } = engine({
      ladder: false,
      deception: { honeypots: true },
      countedRules: [
        {
          id: "probes",
          event: "honeypot.hit",
          threshold: 1,
          window: "1h",
          duration: "1d",
        },
      ],
    });
    const hit = decide(security, get("/admin.php"));
    expect(hit.action).toBe("log");
    expect(hit.hits.map((h) => [h.rule, h.action])).toEqual([
      ["honeypot", "log"],
      ["counted:probes", "log"],
    ]);
    expect(decide(security, get("/")).action).toBe("ban");
  });
});

describe("canary credentials", () => {
  it("refuse the request at once, ban the address, log an error and warn naming the canary", () => {
    const { security, warnings, errors } = engine({
      deception: {
        canaries: [
          { id: "backup-2026-q3", apiKey: "key_canary_1" },
          { id: "seed-admin", user: "u_canary" },
        ],
      },
    });
    const used = decide(
      security,
      facts({ client: "203.0.113.10", identity: { apiKey: "key_canary_1" } }),
    );
    expect(used).toMatchObject({ action: "ban", status: 403, code: "banned" });
    expect(used.hits.map((h) => h.rule)).toEqual([
      "canary:backup-2026-q3",
      "ladder",
    ]);
    expect(warnings).toMatchObject([
      {
        kind: "canary.used",
        message: expect.stringContaining("backup-2026-q3"),
      },
    ]);
    expect(errors.some((line) => line.includes("backup-2026-q3"))).toBe(true);
    // The address is banned for later requests, with any credential.
    expect(decide(security, facts({ client: "203.0.113.10" })).action).toBe(
      "ban",
    );
    // A canary user from an internal address: refused, but no address ban.
    expect(
      decide(
        security,
        facts({ client: "10.0.0.4", identity: { user: "u_canary" } }),
      ).action,
    ).toBe("ban");
    expect(decide(security, facts({ client: "10.0.0.4" })).action).toBe(
      "allow",
    );
  });

  it("negative control: an ordinary key is not a canary", () => {
    const { security, warnings } = engine({
      deception: { canaries: [{ id: "c", apiKey: "key_canary_1" }] },
    });
    expect(
      decide(security, facts({ identity: { apiKey: "key_live_1" } })).action,
    ).toBe("allow");
    expect(warnings).toEqual([]);
  });
});

describe("trap fields", () => {
  it("render a hidden, untabbable field with autocomplete off, and refuse a bad name", () => {
    const trap = trapField();
    expect(trap.name).toBe(DEFAULT_TRAP_FIELD);
    expect(trap.html).toContain(`name="${DEFAULT_TRAP_FIELD}"`);
    expect(trap.html).toContain('tabindex="-1"');
    expect(trap.html).toContain('autocomplete="off"');
    expect(trap.html).toContain('aria-hidden="true"');
    expect(trapField({ name: "fax", label: "<b>skip</b>" }).html).toContain(
      "&lt;b&gt;skip&lt;/b&gt;",
    );
    for (const name of ["", "1x", 'a"b', "a b"]) {
      expect(() => trapField({ name })).toThrow(TypeError);
    }
  });

  it("detect a filled field in FormData, URLSearchParams and a parsed body", () => {
    const form = new FormData();
    form.set("website", "http://spam.example");
    expect(isTrapFilled(form)).toBe(true);
    expect(isTrapFilled(new URLSearchParams("website=&email=a@b.c"))).toBe(
      false,
    );
    expect(isTrapFilled(new URLSearchParams("website=%20%20"))).toBe(false);
    expect(isTrapFilled({ website: "x" })).toBe(true);
    expect(isTrapFilled({ fax: ["", "y"] }, "fax")).toBe(true);
    expect(isTrapFilled({ email: "a@b.c" })).toBe(false);
  });

  it("signal('trap.filled') bans the address (weight 10)", () => {
    const { security } = engine({});
    const hits = security.signal(facts(), "trap.filled");
    expect(hits).toMatchObject([{ rule: "ladder", action: "ban" }]);
    expect(decide(security, facts()).action).toBe("ban");
  });
});
