/**
 * Identifier checks where data is created: `security.check()` refuses a
 * disposable email, a reserved domain or the operator's own domain, wherever
 * an account or invite is made, request or not.
 *
 * ```bash
 * bun 09-sign-in/identifiers.ts
 * ```
 *
 * - Put the check in the code that creates the data (sign-up, team invite,
 *   admin-created user, a job), not only on a route: ConcaveHR's second wave
 *   came in through team invites the sign-up check did not cover.
 * - A refusal is a `SecurityRefusal` (`400`, `invalid_identifier`, one
 *   generic message); the rule that matched stays in `rule`, for your logs.
 * - A match counts `pattern.hit` under the request's client, so a counted
 *   rule can ban whoever keeps trying.
 * - `check(facts, "password", …)` asks your `breachedPassword` hook.
 */
import { createSecurity, SecurityRefusal } from "@kingsleyweb/bun-security";
import type { CheckKind, RequestFacts } from "@kingsleyweb/bun-security";
import { checkEqual, summary } from "../shared/check";
import { facts } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("identifier checks");

const security = createSecurity({
  policy: {
    identifiers: {
      patterns: [
        {
          id: "mailinator",
          kind: "email",
          pattern: "*@mailinator.com",
          reason: "disposable",
        },
        { kind: "domain", pattern: "*.burner.io" },
      ],
      ownDomains: ["acme.com"],
    },
    // ConcaveHR's disposable_signup: one refused identifier → a 7-day ban.
    countedRules: [
      {
        id: "disposable_signup",
        event: "pattern.hit",
        threshold: 1,
        window: "60s",
        duration: "7d",
      },
    ],
  },
  secret: "an-example-secret-of-at-least-32-bytes!",
  // A real one would ask a breach corpus (k-anonymity range queries, say).
  breachedPassword: (password) => Promise.resolve(password === "Password123!"),
  logger: () => {},
});

/** What check() made of `value`: `"ok"`, or the refusal's code and rule. */
async function verdict(
  request: RequestFacts | undefined,
  kind: CheckKind,
  value: string,
) {
  try {
    await security.check(request, kind, value);
    return "ok";
  } catch (error) {
    if (error instanceof SecurityRefusal)
      return `${error.status} ${error.code} (${error.rule})`;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
step("emails, domains and passwords");
const results = {
  "ada@mail.org": await verdict(undefined, "email", "ada@mail.org"),
  "x@mailinator.com": await verdict(undefined, "email", "x@mailinator.com"),
  "x@example.org (reserved)": await verdict(
    undefined,
    "email",
    "x@example.org",
  ),
  "ceo@acme.com (our own)": await verdict(undefined, "email", "ceo@acme.com"),
  "mail.burner.io": await verdict(undefined, "domain", "mail.burner.io"),
  "breached password": await verdict(undefined, "password", "Password123!"),
};
show("check()", results);
checkEqual("an ordinary address passes", results["ada@mail.org"], "ok");
checkEqual(
  "the rest are refused",
  Object.entries(results)
    .filter(([, value]) => value !== "ok")
    .map(([key]) => key),
  [
    "x@mailinator.com",
    "x@example.org (reserved)",
    "ceo@acme.com (our own)",
    "mail.burner.io",
    "breached password",
  ],
);

/* ------------------------------------------------------------------ */
step("the refusal says nothing about which rule matched");
try {
  await security.check(undefined, "email", "x@mailinator.com");
} catch (error) {
  if (error instanceof SecurityRefusal) {
    show("message for the client", error.message);
    checkEqual(
      "a generic message",
      error.message.includes("mailinator"),
      false,
    );
  }
}

/* ------------------------------------------------------------------ */
step("inside a request, a match counts pattern.hit: the sender is banned");
const signup = facts("203.0.113.40", { method: "POST", path: "/team/invite" });
checkEqual(
  "the invite is refused",
  (await verdict(signup, "email", "temp@mailinator.com")).startsWith("400"),
  true,
);
checkEqual(
  "…and its sender banned for 7 days",
  (await security.evaluate(facts("203.0.113.40"))).action,
  "ban",
);
checkEqual(
  "by the counted rule",
  security.bans()[0]?.rule,
  "counted:disposable_signup",
);

security.close();
summary();
