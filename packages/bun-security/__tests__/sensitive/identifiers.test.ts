/**
 * Identifier checks where data is created (layers.md L11.7, D24):
 * `security.check()` refuses a matching email, phone, username or domain
 * with one generic `SecurityRefusal`, counts `pattern.hit` under the
 * client (and a counted rule on it trips), refuses reserved and the
 * operator's own domains, records only in dry run; T-L11-4, a disposable
 * email through a path no route guard covers (a job with no request); the
 * breached-password hook; and the patterns' checks.
 */
import { describe, expect, it } from "bun:test";
import {
  compilePolicy,
  SecurityPolicyError,
  SecurityRefusal,
} from "../../lib/index";
import type { SecurityPolicy } from "../../lib/index";
import { facts } from "../helpers";
import { engine } from "./helpers";

const POLICY: SecurityPolicy = {
  identifiers: {
    patterns: [
      { kind: "email", pattern: "*@throwaway-mail.net", reason: "disposable" },
      { kind: "domain", pattern: "*.burner-mail.io" },
      { kind: "phone", pattern: "+1900*" },
      { kind: "username", pattern: "admin*" },
      { id: "watch", kind: "email", pattern: "*+watch@*.org", mode: "dryRun" },
    ],
    ownDomains: ["acme.com"],
  },
  countedRules: [
    {
      id: "disposable_signup",
      event: "pattern.hit",
      threshold: 1,
      window: "1m",
      duration: "7d",
    },
  ],
};

/** The refusal `run` throws (or rejects with), or `undefined`. */
async function refusal(
  run: () => void | Promise<void>,
): Promise<SecurityRefusal | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    if (error instanceof SecurityRefusal) return error;
    throw error;
  }
}

describe("security.check()", () => {
  it("refuses a matching identifier with one generic refusal, whatever matched", async () => {
    const security = engine(POLICY);
    const refusals = await Promise.all(
      [
        ["email", "Someone@Throwaway-Mail.Net"],
        ["email", "x@mail.burner-mail.io"],
        ["phone", "+1 (900) 555-0100"],
        ["username", "Administrator"],
        ["email", "me@test"],
        ["email", "ceo@acme.com"],
        ["email", "it@eu.acme.com"],
        ["email", "not-an-address"],
      ].map(([kind, value]) =>
        refusal(() =>
          security.check(undefined, kind as never, value as string),
        ),
      ),
    );
    for (const refused of refusals) {
      expect(refused).toBeInstanceOf(SecurityRefusal);
      expect(refused?.message).toBe("This value cannot be used.");
      expect([refused?.status, refused?.code]).toEqual([
        400,
        "invalid_identifier",
      ]);
    }
    expect(refusals.map((refused) => refused?.rule)).toEqual([
      "email:*@throwaway-mail.net",
      "domain:*.burner-mail.io",
      "phone:+1900*",
      "username:admin*",
      "reserved-domain",
      "own-domain",
      "own-domain",
      "malformed",
    ]);
    // Accepted values pass, and a dry-run pattern only records.
    for (const [kind, value] of [
      ["email", "someone@company.org"],
      ["phone", "+2348012345678"],
      ["username", "alice"],
      ["domain", "company.org"],
      ["email", "me+watch@company.org"],
    ]) {
      expect(
        await refusal(() =>
          security.check(undefined, kind as never, value as string),
        ),
      ).toBeUndefined();
    }
  });

  it("counts pattern.hit under the request's client, so a counted rule bans it", async () => {
    const security = engine(POLICY);
    const request = facts({ client: "203.0.113.80" });
    await refusal(() =>
      security.check(request, "email", "a@throwaway-mail.net"),
    );
    expect(security.bans()[0]).toMatchObject({
      id: "ip:203.0.113.80",
      rule: "counted:disposable_signup",
    });
    expect((await security.evaluate(request)).action).toBe("ban");
  });

  it("T-L11-4: refuses a disposable email created by a job no route guard covers, generically, without counting anyone", async () => {
    const security = engine(POLICY);
    // An invite created by a background job: no request, no facts.
    const createInvite = async (email: string) => {
      await security.check(undefined, "email", email);
      return { email };
    };
    const refused = await refusal(async () => {
      await createInvite("new.hire@throwaway-mail.net");
    });
    expect(refused?.message).toBe("This value cannot be used.");
    expect(security.bans()).toEqual([]);
    expect(await createInvite("new.hire@company.org")).toEqual({
      email: "new.hire@company.org",
    });
    // Negative control: with no patterns, the job creates it.
    const open = engine({});
    expect(
      await refusal(() =>
        open.check(undefined, "email", "new.hire@throwaway-mail.net"),
      ),
    ).toBeUndefined();
  });

  it("asks the breached-password hook, refusing a breached password and accepting when the hook fails", async () => {
    const seen: string[] = [];
    const security = engine({}, undefined, {
      breachedPassword: async (password) => {
        seen.push(password);
        if (password === "broken") throw new Error("down");
        return password === "password123";
      },
    });
    const refused = await refusal(() =>
      security.check(undefined, "password", "password123"),
    );
    expect([refused?.code, refused?.rule]).toEqual([
      "breached_password",
      "breached-password",
    ]);
    expect(
      await refusal(() =>
        security.check(undefined, "password", "correct horse battery staple"),
      ),
    ).toBeUndefined();
    expect(
      await refusal(() => security.check(undefined, "password", "broken")),
    ).toBeUndefined();
    expect(seen).toEqual([
      "password123",
      "correct horse battery staple",
      "broken",
    ]);
    // Without a hook, every password passes.
    expect(
      await refusal(() => engine().check(undefined, "password", "password123")),
    ).toBeUndefined();
    expect(() => engine().check(undefined, "nope" as never, "x")).toThrow(
      TypeError,
    );
  });

  it("can leave reserved domains to the app", async () => {
    const security = engine({ identifiers: { reserved: false } });
    expect(
      await refusal(() => security.check(undefined, "email", "me@example.com")),
    ).toBeUndefined();
  });
});

describe("the identifiers section's checks", () => {
  it("refuses a pattern with under 4 literal characters, an unknown kind and a repeated id", () => {
    const paths = (identifiers: unknown): string[] => {
      try {
        compilePolicy({ identifiers } as never);
        return [];
      } catch (error) {
        if (!(error instanceof SecurityPolicyError)) throw error;
        return error.issues.map((issue) => issue.path.join("."));
      }
    };
    expect(paths({ patterns: [{ kind: "email", pattern: "*@*" }] })).toEqual([
      "identifiers.patterns.0.pattern",
    ]);
    expect(paths({ patterns: [{ kind: "ip", pattern: "1234" }] })).toEqual([
      "identifiers.patterns.0.kind",
    ]);
    expect(
      paths({
        patterns: [
          { kind: "email", pattern: "*@abcd" },
          { kind: "email", pattern: "*@abcd" },
        ],
      }),
    ).toEqual(["identifiers.patterns.1.id"]);
    expect(paths({ ownDomains: ["Acme.com"] })).toEqual([
      "identifiers.ownDomains.0",
    ]);
    expect(
      paths({
        patterns: [{ kind: "email", pattern: "*@abcd.example" }],
        ownDomains: ["acme.com"],
      }),
    ).toEqual([]);
  });
});
