/**
 * The security UI's flows in Chrome (PR-U6), over the REAL app and a real
 * `createSecurityApi()` (the harness: cookie operators, the host's step-up
 * page, two-person approvals, agents and alerts). Each flow is what an
 * operator does, start to end, and each checks what the API then holds.
 *
 * Skips visibly when no Chrome is found (`BUN_CHROME_PATH`).
 */
import type { Host } from "./harness";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chromePath, DIALOG, ok, startHost, suiteName } from "./harness";

/** The head policy of `scope`, as the API holds it. */
async function headPolicy(host: Host, scope: string) {
  const policy = ok(await host.call("GET", `/policies/${scope}`), "policy");
  if (policy.body.head === null) return {};
  return ok(
    await host.call(
      "GET",
      `/policies/${scope}/versions/${policy.body.head.id}`,
    ),
    "head",
  ).body.policy as Record<string, unknown>;
}

describe.skipIf(chromePath === undefined)(
  suiteName("security UI flows in Chrome"),
  () => {
    let host: Host;

    // A fresh host for each flow: none depends on another's drafts, bans or
    // versions, so they pass in any order (`bun test --randomize`).
    beforeEach(async () => {
      host = await startHost("flows");
      ok(
        await host.call("POST", "/services", {
          id: "checkout",
          name: "Checkout",
        }),
        "service",
      );
    }, 120_000);

    afterEach(async () => {
      await host?.close();
    }, 30_000);

    it("a draft another operator saved meanwhile is said so, read again, and the entry added over it", async () => {
      await host.open("/lists/new?scope=global", '[data-testid="lists-new"]');
      await host.fill('[data-testid="lists-new-value"]', "198.51.100.77");
      await host.fill('[data-testid="lists-new-reason"]', "bob was first");
      // Bob saves the draft while Alice's form is open.
      const read = ok(
        await host.call("GET", "/policies/global", undefined, "bob"),
        "read",
      );
      ok(
        await host.call(
          "PUT",
          "/policies/global/draft",
          {
            policy: {
              ...(read.body.draft?.policy ?? {}),
              lists: [
                ...(((read.body.draft?.policy ?? {}) as { lists?: unknown[] })
                  .lists ?? []),
                { ip: "192.0.2.200", action: "block", reason: "bob's" },
              ],
            },
            revision: read.body.draft?.revision ?? null,
          },
          "bob",
        ),
        "bob's draft",
      );
      await host.click('[data-testid="lists-new-submit"]');
      await host.clickButton("Add to the draft", DIALOG);
      await host.waitFor('[data-testid="lists-conflict"]');
      await host.click('[data-testid="lists-reload"]');
      await host.waitGone('[data-testid="lists-conflict"]');
      // The draft is read again in the background; give it its round trip.
      await Bun.sleep(1_000);
      await host.click('[data-testid="lists-new-submit"]');
      await host.clickButton("Add to the draft", DIALOG);
      await host.waitFor('[data-testid="lists-new-saved"]');
      const draft = ok(await host.call("GET", "/policies/global"), "draft").body
        .draft;
      const listed = JSON.stringify(draft.policy.lists);
      expect(listed).toContain("192.0.2.200");
      expect(listed).toContain("198.51.100.77");
    }, 90_000);

    it("creates a ban, sees another appear live, and lifts it", async () => {
      await host.open("/bans/new?scope=global", '[data-testid="ban-form"]');
      await host.fill('[data-testid="ban-value"]', "192.0.2.150");
      await host.fill('[data-testid="ban-reason"]', "probing");
      await host.click('[data-testid="ban-submit"]');
      await host.waitFor('[data-testid="ban-created"]');
      await host.open(
        "/bans?scope=global",
        '[data-testid="ban-row"]',
        "192.0.2.150",
      );
      // Another operator bans an address: the list counts it live, never moves.
      ok(
        await host.call(
          "POST",
          "/bans",
          { ip: "192.0.2.151", reason: "live" },
          "bob",
        ),
        "bob's ban",
      );
      await host.waitFor('[data-testid="new-bans"]', "1 new");
      await host.click('[data-testid="new-bans"]');
      await host.waitFor('[data-testid="ban-row"]', "192.0.2.151");
      const id = (
        ok(
          await host.call("GET", "/bans?active=true&search=192.0.2.151"),
          "find",
        ).body.items as { id: string }[]
      )[0]!.id;
      await host.open(
        `/bans/${encodeURIComponent(id)}?scope=global`,
        '[data-testid="ban-lift"]',
      );
      await host.click('[data-testid="ban-lift"]');
      await host.waitFor('[data-testid="ban-message"]', "Lifted.");
      const after = ok(
        await host.call("GET", `/bans/${encodeURIComponent(id)}`),
        "after",
      );
      expect(after.body.ban.active).toBe(false);
    }, 90_000);

    it("builds a rule in the matcher builder, tests a request against the draft, and publishes it behind a step-up", async () => {
      await host.open("/rules/new?scope=global", '[data-testid="rule-editor"]');
      await host.fill('[data-testid="rule-id"]', "no-wp-login");
      await host.fill('[data-testid="match-value-0"]', "/wp-login.php*");
      await host.click('[data-testid="rule-save"]');
      await host.waitFor('[data-testid="rule-row"]', "no-wp-login");
      await host.open("/rules/test?scope=global", '[data-testid="rule-test"]');
      await host.fill('[data-testid="test-service"]', "checkout");
      await host.fill('[data-testid="test-path"]', "/wp-login.php?x=1");
      await host.click('[data-testid="test-use-draft"]');
      await host.click('[data-testid="test-run"]');
      await host.waitFor('[data-testid="test-hits"]', "no-wp-login");
      await host.open("/rules?scope=global", '[data-testid="rules-publish"]');
      await host.click('[data-testid="rules-publish"]');
      const before = host.stepUps();
      await host.clickButton("Publish", DIALOG);
      await host.waitFor("body", "Published version");
      expect(host.stepUps()).toBe(before + 1);
      const rules = (await headPolicy(host, "global")).requestRules as {
        rules: { id: string }[];
      };
      expect(rules.rules.map((rule) => rule.id)).toContain("no-wp-login");
    }, 120_000);

    it("a dangerous change waits for the second operator, who approves it behind a step-up", async () => {
      const head =
        ok(await host.call("GET", "/policies/global"), "head").body.head?.id ??
        null;
      const base = await headPolicy(host, "global");
      ok(
        await host.call("PUT", "/policies/global/draft", {
          policy: {
            ...base,
            lists: [
              ...((base.lists as unknown[] | undefined) ?? []),
              { ip: "203.0.113.0/24", action: "allow", reason: "partner" },
            ],
          },
          revision:
            ok(await host.call("GET", "/policies/global"), "rev").body.draft
              ?.revision ?? null,
        }),
        "draft",
      );
      const opened = ok(
        await host.call(
          "POST",
          "/policies/global/publish",
          { expectedHead: head },
          "alice",
          true,
        ),
        "publish",
      );
      expect(opened.status).toBe(202);
      // Alice may not decide her own.
      await host.open(
        `/approvals/${opened.body.id}?scope=global`,
        '[data-testid="approval-diff"]',
      );
      expect(
        await host.evaluate<number>(
          `document.querySelectorAll('[data-testid="approval-approve"]').length`,
        ),
      ).toBe(0);
      await host.as("bob");
      try {
        await host.open(
          `/approvals/${opened.body.id}?scope=global`,
          '[data-testid="approval-diff"]',
          "203.0.113.0/24",
        );
        const before = host.stepUps();
        await host.click('[data-testid="approval-approve"]');
        await host.waitFor('[data-testid="approval-outcome"]', "Approved");
        expect(host.stepUps()).toBe(before + 1);
      } finally {
        await host.as("alice");
      }
      expect(
        JSON.stringify((await headPolicy(host, "global")).lists),
      ).toContain("203.0.113.0/24");
    }, 120_000);

    it("the policy editor: a draft another operator saved meanwhile is said so; reloaded, changed and published behind a step-up", async () => {
      await host.open(
        "/policies?scope=global&tab=identity",
        '[data-testid="control-trustCheck.minRequests"]',
      );
      await host.fill('[data-testid="control-trustCheck.minRequests"]', "45");
      // Bob saves the draft first.
      const read = ok(
        await host.call("GET", "/policies/global", undefined, "bob"),
        "read",
      );
      const bobs = ok(
        await host.call(
          "PUT",
          "/policies/global/draft",
          {
            policy: { ...(await headPolicy(host, "global")), mode: "enforce" },
            revision: read.body.draft?.revision ?? null,
          },
          "bob",
        ),
        "bob's draft",
      ).body.revision as number;
      await host.click('[data-testid="policy-save"]');
      await host.waitFor(
        '[data-testid="policy-conflict"]',
        "Someone saved this scope's draft",
      );
      await host.clickButton("Reload", '[data-testid="policy-conflict"]');
      await host.waitGone('[data-testid="policy-conflict"]');
      // The editor reads Bob's draft again: its revision shows.
      await host.waitFor('[data-testid="policy-source"]', `revision ${bobs}`);
      await host.fill('[data-testid="control-trustCheck.minRequests"]', "50");
      await host.click('[data-testid="policy-save"]');
      await host.waitFor('[data-testid="policy-source"]', "draft");
      await host.click('[data-testid="policy-publish"]');
      const before = host.stepUps();
      await host.clickButton("Publish", DIALOG);
      await host.waitFor("body", "Published version");
      expect(host.stepUps()).toBe(before + 1);
      const head = await headPolicy(host, "global");
      expect(head.trustCheck).toMatchObject({ minRequests: 50 });
      // Bob's change, read in on the reload, went out with it.
      expect(head.mode).toBe("enforce");
    }, 120_000);

    it("makes an agent's key behind a step-up and rotates it, each secret shown once", async () => {
      await host.open(
        "/agents/new?scope=service%3Acheckout",
        '[data-testid="agent-new"]',
      );
      await host.fill('[data-testid="agent-id"]', "checkout-e2e");
      await host.click('[data-testid="agent-create"]');
      await host.waitFor('[data-testid="secret-value"]');
      const first = await host.evaluate<string>(
        `document.querySelector('[data-testid="secret-value"]').textContent`,
      );
      await host.click('[data-testid="secret-done"]');
      await host.open(
        "/agents/checkout-e2e?scope=service%3Acheckout",
        '[data-testid="agent-rotate"]',
      );
      await host.click('[data-testid="agent-rotate"]');
      await host.waitFor('[data-testid="secret-value"]');
      const second = await host.evaluate<string>(
        `document.querySelector('[data-testid="secret-value"]').textContent`,
      );
      expect(second.length).toBeGreaterThan(20);
      expect(second).not.toBe(first);
      const agent = ok(
        await host.call("GET", "/agents/checkout-e2e"),
        "agent",
      ).body;
      expect(agent.rotatedAt).not.toBe(null);
    }, 120_000);

    it("makes a webhook channel behind a step-up, sends it a test, and an alert rule sending to it", async () => {
      await host.open(
        "/alerts/channels/new?scope=global",
        '[data-testid="alert-channel-form"]',
      );
      await host.fill('[data-testid="channel-id"]', "e2e-hook");
      await host.fill('[data-testid="channel-name"]', "E2E hook");
      await host.fill('[data-testid="channel-url"]', `${host.origin}/hook`);
      await host.click('[data-testid="channel-save"]');
      await host.waitFor('[data-testid="secret-value"]');
      await host.click('[data-testid="secret-done"]');
      await host.open(
        "/alerts/channels/e2e-hook?scope=global",
        '[data-testid="channel-test"]',
      );
      const received = host.hook.length;
      await host.click('[data-testid="channel-test"]');
      await host.waitFor(
        '[data-testid="channel-status"]',
        "test message is queued",
      );
      const deadline = Date.now() + 15_000;
      while (host.hook.length === received && Date.now() < deadline)
        await Bun.sleep(100);
      if (host.hook.length === received) {
        const log = await host.call(
          "GET",
          "/alerts/deliveries?channel=e2e-hook",
        );
        throw new Error(
          `no test message arrived; the delivery log: ${JSON.stringify(log.body)}`,
        );
      }
      expect(host.hook.at(-1)!.headers["content-type"]).toContain("json");
      await host.open(
        "/alerts/rules/new?scope=global",
        '[data-testid="rule-id"]',
      );
      await host.fill('[data-testid="rule-id"]', "e2e-storm");
      await host.fill('[data-testid="rule-title"]', "E2E ban storm");
      await host.pick('[data-testid="condition-type"]', "banStorm");
      await host.fill('[data-testid="condition-value"]', "5");
      await host.click('[data-testid="rule-channel-e2e-hook"]');
      await host.click('[data-testid="rule-save"]');
      await host.waitFor('[data-testid="alert-rule-row"]', "E2E ban storm");
      const rule = ok(
        await host.call("GET", "/alerts/rules/e2e-storm"),
        "rule",
      ).body;
      expect(rule.channels).toEqual(["e2e-hook"]);
      expect(rule.condition).toMatchObject({ type: "banStorm", value: 5 });
    }, 120_000);

    it("pages through the events while events arrive: no duplicate and no gap across pages; and no CSP violation", async () => {
      const at = Date.now() - 10 * 60_000;
      const older = Array.from({ length: 120 }, (_, i) => ({
        id: `old-${String(i).padStart(3, "0")}`,
        at: at + i * 1_000,
        service: "checkout",
        action: "block" as const,
        route: "GET /admin",
        subjects: { ip: `198.51.100.${(i % 200) + 1}` },
        sample: { method: "GET", path: "/admin", headers: {} },
      }));
      await host.api.plane.store.appendEvents!("older", older);
      await host.open(
        "/events?scope=global&limit=50",
        '[data-testid="event-row"]',
      );
      const seen: string[] = [];
      const rowIds = () =>
        host.evaluate<string[]>(
          `[...document.querySelectorAll('[data-testid="event-row"]')].map((row) => row.getAttribute("data-event-id"))`,
        );
      for (let page = 0; page < 3; page++) {
        const ids = await rowIds();
        seen.push(...ids);
        // New events arrive while the operator reads: the pages never move.
        await host.api.plane.store.appendEvents!(`newer-${page}`, [
          {
            id: `new-${page}`,
            at: Date.now(),
            service: "checkout",
            action: "block",
            route: "GET /admin",
            subjects: { ip: "203.0.113.200" },
            sample: { method: "GET", path: "/admin", headers: {} },
          },
        ]);
        if (page < 2) {
          await host.clickButton("Next");
          await host.evaluate(`new Promise((resolve) => {
          const first = ${JSON.stringify(ids[0])};
          const check = () => {
            const row = document.querySelector('[data-testid="event-row"]');
            if (row && row.getAttribute("data-event-id") !== first) return resolve(true);
            setTimeout(check, 50);
          };
          check();
        })`);
        }
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.filter((id) => id.startsWith("new-"))).toEqual([]);
      const expected = older
        .map((event) => event.id)
        .sort()
        .reverse()
        .slice(0, seen.length);
      expect(seen).toEqual(expected);
      // The CSP refused nothing on the page (its reports, buffered ones included).
      const violations = await host.evaluate<
        unknown[]
      >(`new Promise((resolve) => {
      const seen = [];
      const observer = new ReportingObserver((reports) => { for (const r of reports) seen.push(r.body.effectiveDirective); }, { types: ["csp-violation"], buffered: true });
      observer.observe();
      setTimeout(() => { seen.push(...observer.takeRecords().map((r) => r.body.effectiveDirective)); observer.disconnect(); resolve(seen); }, 100);
    })`);
      expect(violations).toEqual([]);
    }, 120_000);

    it("adds a list entry to the draft and publishes it behind a step-up", async () => {
      await host.open("/lists/new?scope=global", '[data-testid="lists-new"]');
      await host.fill('[data-testid="lists-new-value"]', "203.0.113.66");
      await host.pick('[data-testid="lists-new-action"]', "block");
      await host.fill('[data-testid="lists-new-reason"]', "scanner");
      await host.click('[data-testid="lists-new-submit"]');
      await host.clickButton("Add to the draft", DIALOG);
      await host.waitFor('[data-testid="lists-new-saved"]');
      await host.open("/lists?scope=global", '[data-testid="lists-publish"]');
      await host.click('[data-testid="lists-publish"]');
      const before = host.stepUps();
      await host.clickButton("Publish", DIALOG);
      await host.waitFor("body", "Published version");
      expect(host.stepUps()).toBe(before + 1);
      const policy = await host.call("GET", "/policies/global");
      const head = await host.call(
        "GET",
        `/policies/global/versions/${policy.body.head.id}`,
      );
      expect(JSON.stringify(head.body.policy.lists)).toContain("203.0.113.66");
    }, 90_000);
  },
);
