/**
 * The request rules screens (PR-U5, ui.md §4.3, §4.5): the scope's own
 * rules with their hits and dry-run would-blocks, the inherited ones with
 * their origin and lock, the managed set as part of bun-security's
 * release; a new rule built in the matcher builder and saved into the
 * draft (the regex verdict live, a refused one not saved); an edit; a
 * removal; a draft changed meanwhile; the draft's publish and discard; the
 * actions absent without `policy:draft`; and test a request (a pasted curl
 * command, the request sent, the result shown).
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { analyticsRoutes, defaultRoutes, T0 } from "./mockApi";
import { draftPuts, policyApi } from "./listsApi";
import { renderApp } from "./renderApp";

setupDom();

/** A rule. */
function rule(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    when: { path: { glob: `/${id}/**` } },
    action: "block",
    mode: "enforce",
    ...over,
  };
}

/** A group's API: head with rules `a` (enforced) and `b` (dry run), an inherited global rule `g` (locked by global). */
function groupApi(extra: Record<string, MockHandler | MockReply> = {}) {
  const api = policyApi({
    head: [],
    rest: {
      requestRules: {
        managed: { mode: "enforce", exclude: ["wordpress"] },
        rules: [rule("a"), rule("b", { mode: "dryRun", action: "ban" })],
      },
    },
    effective: {
      body: {
        group: "payments",
        policyVersions: ["global@pv_1", "group:payments@pv_3"],
        policy: {
          requestRules: {
            managed: { mode: "enforce", exclude: ["wordpress"] },
            rules: [
              rule("g"),
              rule("a"),
              rule("b", { mode: "dryRun", action: "ban" }),
            ],
          },
        },
        // Locked by global: the effective policy's map says so (PR-AN2),
        // not the rule's own flag.
        locked: { "requestRules.rules[id=g]": "global" },
        origins: {
          "requestRules.rules[id=g]": "global",
          "requestRules.rules[id=a]": "group:payments",
          "requestRules.rules[id=b]": "group:payments",
        },
      },
    },
  });
  return {
    ...api,
    routes: {
      ...analyticsRoutes({
        series: {
          rules: [
            {
              at: T0,
              dims: { rule: "rule:a", action: "block", dryRun: "false" },
              value: 7,
            },
            {
              at: T0,
              dims: { rule: "rule:b", action: "ban", dryRun: "true" },
              value: 4,
            },
          ],
        },
      }),
      ...api.routes,
      ...extra,
    },
  };
}

const AT = "/rules?scope=group%3Apayments";

describe("the rules list", () => {
  it("shows the own rules with hits, the inherited with origin and lock, and the managed set with the release", async () => {
    const { routes } = groupApi();
    renderApp({ path: AT, routes });
    const own = await page().findAllByTestId("rule-row", {}, LOADED);
    expect(own.map((row) => row.textContent)).toEqual([
      expect.stringContaining("a"),
      expect.stringContaining("Dry run"),
    ]);
    await waitFor(() => expect(own[0]!.textContent).toContain("7"));
    expect(own[1]!.textContent).toContain("4");
    const inherited = page().getAllByTestId("rule-inherited-row");
    expect(inherited).toHaveLength(1);
    expect(inherited[0]!.textContent).toContain("Global");
    expect(inherited[0]!.textContent).toContain("locked");
    const managed = page().getByTestId("rules-managed").textContent;
    expect(managed).toContain("Enforced, leaving out wordpress.");
    expect(managed).toContain("bun-security 3.3.0");
  });

  it("the control: an inherited rule the effective policy does not lock shows no lock", async () => {
    const { routes } = groupApi({
      "GET /groups/:id/effective": {
        body: {
          group: "payments",
          policyVersions: ["global@pv_1"],
          policy: { requestRules: { rules: [rule("g")] } },
          locked: {},
          origins: { "requestRules.rules[id=g]": "global" },
        },
      },
    });
    renderApp({ path: AT, routes });
    const row = (
      await page().findAllByTestId("rule-inherited-row", {}, LOADED)
    )[0]!;
    expect(row.textContent).toContain("Global");
    expect(row.textContent).not.toContain("locked");
  });

  it("without policy:draft, no new, edit or remove", async () => {
    const { routes } = groupApi();
    renderApp({
      path: AT,
      routes: {
        ...defaultRoutes({
          permissions: {
            global: { "policy:read": true },
            "group:payments": { "policy:read": true },
          },
        }),
        ...routes,
      },
    });
    await page().findAllByTestId("rule-row", {}, LOADED);
    expectAbsent(page().queryByTestId("new-rule"), "new rule");
    expectAbsent(page().queryByTestId("rule-edit-a"), "edit");
    expectAbsent(page().queryByTestId("rule-remove-a"), "remove");
    expectAbsent(page().queryByTestId("rules-test-link"), "test a request");
  });
});

describe("a new rule", () => {
  it("is built in the matcher builder and saved into the draft, the other rules kept", async () => {
    const { routes, state } = groupApi();
    const { api } = renderApp({
      path: "/rules/new?scope=group%3Apayments",
      routes,
    });
    fireEvent.change(await page().findByTestId("rule-id", {}, LOADED), {
      target: { value: "no-admin" },
    });
    fireEvent.change(page().getByTestId("match-value-0"), {
      target: { value: "/admin/**" },
    });
    fireEvent.change(page().getByTestId("rule-action"), {
      target: { value: "challenge" },
    });
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(1));
    const body = draftPuts(api.calls)[0]!.body as {
      policy: { requestRules: { rules: unknown[] } };
      revision: number | null;
    };
    expect(body.revision).toBe(null);
    expect(body.policy.requestRules.rules).toEqual([
      rule("a"),
      rule("b", { mode: "dryRun", action: "ban" }),
      {
        id: "no-admin",
        when: { path: { glob: "/admin/**" } },
        action: "challenge",
        mode: "dryRun",
      },
    ]);
    expect(state.draft?.revision).toBe(1);
    await page().findByTestId("rules", {}, LOADED);
  });

  it("shows a regex's verdict as it is typed, and does not save a refused one", async () => {
    const { routes } = groupApi();
    const { api } = renderApp({
      path: "/rules/new?scope=group%3Apayments",
      routes,
    });
    fireEvent.change(await page().findByTestId("rule-id", {}, LOADED), {
      target: { value: "re" },
    });
    fireEvent.change(page().getByTestId("match-op-0"), {
      target: { value: "regex" },
    });
    fireEvent.change(page().getByTestId("match-value-0"), {
      target: { value: "(a+)+" },
    });
    expect(page().getByTestId("match-regex-verdict-0").textContent).toStartWith(
      "Refused:",
    );
    fireEvent.click(page().getByTestId("rule-save"));
    expect(
      (await page().findByTestId("rule-error", {}, LOADED)).textContent,
    ).toStartWith("Path:");
    expectNone(draftPuts(api.calls), "draft writes");
    fireEvent.change(page().getByTestId("match-value-0"), {
      target: { value: "^/a[0-9]+$" },
    });
    expect(page().getByTestId("match-regex-verdict-0").textContent).toBe(
      "The pattern is accepted.",
    );
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(1));
  });

  it("groups tests: any of two, the second negated", async () => {
    const { routes } = groupApi();
    const { api } = renderApp({
      path: "/rules/new?scope=group%3Apayments",
      routes,
    });
    fireEvent.change(await page().findByTestId("rule-id", {}, LOADED), {
      target: { value: "grouped" },
    });
    fireEvent.change(page().getByTestId("match-value-0"), {
      target: { value: "/x" },
    });
    fireEvent.click(page().getByTestId("node-group-it-0"));
    fireEvent.change(page().getByTestId("node-group-0"), {
      target: { value: "any" },
    });
    fireEvent.change(page().getByTestId("match-target-0.1"), {
      target: { value: "header" },
    });
    fireEvent.change(page().getByTestId("match-name-0.1"), {
      target: { value: "x-debug" },
    });
    fireEvent.change(page().getByTestId("match-op-0.1"), {
      target: { value: "exists" },
    });
    fireEvent.click(page().getByTestId("node-negate-0.1"));
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(1));
    const saved = (
      draftPuts(api.calls)[0]!.body as {
        policy: { requestRules: { rules: { id: string; when: unknown }[] } };
      }
    ).policy.requestRules.rules.at(-1)!;
    expect(saved.when).toEqual({
      any: [
        { path: { glob: "/x" } },
        { not: { header: "x-debug", exists: true } },
      ],
    });
  });
});

describe("an existing rule", () => {
  it("is edited in place, and the editor refuses an id another rule has", async () => {
    const { routes } = groupApi();
    const { api } = renderApp({
      path: "/rules/edit/a?scope=group%3Apayments",
      routes,
    });
    const id = await page().findByTestId("rule-id", {}, LOADED);
    expect(
      (page().getByTestId("match-value-0") as HTMLInputElement).value,
    ).toBe("/a/**");
    fireEvent.change(id, { target: { value: "b" } });
    fireEvent.click(page().getByTestId("rule-save"));
    expect(
      (await page().findByTestId("rule-error", {}, LOADED)).textContent,
    ).toBe("A rule “b” exists already");
    fireEvent.change(id, { target: { value: "a" } });
    fireEvent.change(page().getByTestId("rule-mode"), {
      target: { value: "dryRun" },
    });
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(1));
    const rules = (
      draftPuts(api.calls)[0]!.body as {
        policy: { requestRules: { rules: { id: string; mode: string }[] } };
      }
    ).policy.requestRules.rules;
    expect(rules.map((r) => [r.id, r.mode])).toEqual([
      ["a", "dryRun"],
      ["b", "dryRun"],
    ]);
  });

  it("an inherited rule is not this scope's to change", async () => {
    const { routes } = groupApi();
    renderApp({ path: "/rules/edit/g?scope=group%3Apayments", routes });
    expect((await page().findByRole("alert", {}, LOADED)).textContent).toBe(
      "“g” comes from Global: change it there.",
    );
  });

  it("a draft changed meanwhile is said so and read again", async () => {
    const { routes, state } = groupApi();
    const { api } = renderApp({
      path: "/rules/edit/a?scope=group%3Apayments",
      routes,
    });
    await page().findByTestId("rule-id", {}, LOADED);
    // Another operator saves a draft first.
    state.draft = {
      policy: { requestRules: { rules: [rule("a"), rule("z")] } },
      revision: 5,
      updatedBy: "bob",
    };
    fireEvent.click(page().getByTestId("rule-save"));
    expect(
      (await page().findByTestId("rule-error", {}, LOADED)).textContent,
    ).toContain("changed meanwhile");
    // Saved once more, over the draft read again: z is kept.
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(2));
    const last = draftPuts(api.calls).at(-1)!.body as {
      revision: number;
      policy: { requestRules: { rules: { id: string }[] } };
    };
    expect(last.revision).toBe(5);
    expect(last.policy.requestRules.rules.map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("is removed in the draft after a confirmation", async () => {
    const { routes } = groupApi();
    const { api } = renderApp({ path: AT, routes });
    fireEvent.click(await page().findByTestId("rule-remove-a", {}, LOADED));
    const dialog = await page().findByRole("alertdialog", {}, LOADED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(draftPuts(api.calls)).toHaveLength(1));
    const rules = (
      draftPuts(api.calls)[0]!.body as {
        policy: { requestRules: { rules: { id: string }[] } };
      }
    ).policy.requestRules.rules;
    expect(rules.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("the draft", () => {
  it("marks what it changes and offers publish and discard", async () => {
    const { routes, state } = groupApi();
    state.draft = {
      policy: {
        requestRules: { rules: [rule("a", { mode: "off" }), rule("c")] },
      },
      revision: 2,
      updatedBy: "op",
    };
    renderApp({ path: AT, routes });
    const rows = await page().findAllByTestId("rule-row", {}, LOADED);
    expect(rows[0]!.textContent).toContain("changed in the draft");
    expect(rows[1]!.textContent).toContain("added in the draft");
    expect(page().getByTestId("rules-draft").textContent).toContain(
      "it removes b",
    );
    fireEvent.click(page().getByTestId("rules-publish"));
    expect(await page().findByRole("dialog", {}, LOADED)).toBeTruthy();
  });
});

describe("test a request", () => {
  it("fills the form from a pasted curl command, sends it, and shows the decision and why", async () => {
    const sent: MockCall[] = [];
    renderApp({
      path: "/rules/test?scope=service%3Acheckout",
      routes: {
        "POST /rules/test": (call: MockCall) => {
          sent.push(call);
          return {
            body: {
              service: "checkout",
              policy: {
                draft: null,
                versions: ["global@pv_1", "service:checkout@pv_2"],
              },
              at: 1,
              decision: {
                action: "block",
                status: 403,
                code: "blocked",
                hits: [
                  {
                    layer: "L7",
                    rule: "rule:no-admin",
                    action: "block",
                    reason: "path matched",
                  },
                ],
                tags: [],
                risk: 40,
                subject: { ip: "198.51.100.4" },
              },
              client: {
                address: "198.51.100.4",
                source: "trusted-proxy",
                chain: [
                  { address: "10.0.0.2", source: "socket", trusted: true },
                  {
                    address: "198.51.100.4",
                    source: "x-forwarded-for",
                    trusted: false,
                  },
                ],
              },
              steps: [
                {
                  layer: "L7",
                  check: "request rules",
                  rule: "rule:no-admin",
                  outcome: "block",
                  decided: true,
                },
              ],
              notEvaluated: ["intel"],
            },
          };
        },
      },
    });
    expect(
      (
        (await page().findByTestId(
          "test-service",
          {},
          LOADED,
        )) as HTMLInputElement
      ).value,
    ).toBe("checkout");
    fireEvent.change(page().getByTestId("test-paste"), {
      target: {
        value:
          "curl -X POST 'https://shop.example/admin/x?y=1' -H 'X-Forwarded-For: 198.51.100.4'",
      },
    });
    fireEvent.click(page().getByTestId("test-read-paste"));
    expect((page().getByTestId("test-path") as HTMLInputElement).value).toBe(
      "/admin/x?y=1",
    );
    fireEvent.change(page().getByTestId("test-peer"), {
      target: { value: "10.0.0.2" },
    });
    fireEvent.change(page().getByTestId("test-trust"), {
      target: { value: "on" },
    });
    fireEvent.change(page().getByTestId("test-limits"), {
      target: { value: "per-ip=299" },
    });
    fireEvent.click(page().getByTestId("test-run"));
    const result = await page().findByTestId("test-result", {}, LOADED);
    expect(result.textContent).toContain("block 403 (blocked)");
    expect(page().getByTestId("test-hits").textContent).toContain(
      "rule:no-admin",
    );
    expect(page().getByTestId("test-chain").textContent).toContain(
      "10.0.0.2 (socket): trusted proxy",
    );
    expect(page().getByTestId("test-not-evaluated").textContent).toContain(
      "intel",
    );
    expect(sent[0]!.body).toEqual({
      service: "checkout",
      method: "POST",
      path: "/admin/x?y=1",
      headers: { "X-Forwarded-For": "198.51.100.4" },
      peer: "10.0.0.2",
      trustProxy: true,
      assume: { limits: { "per-ip": 299 } },
    });
  });

  it("refuses a form it cannot send, before asking", async () => {
    const sent: MockCall[] = [];
    renderApp({
      path: "/rules/test?scope=service%3Acheckout",
      routes: {
        "POST /rules/test": (call: MockCall) => {
          sent.push(call);
          return { status: 500 };
        },
      },
    });
    fireEvent.change(await page().findByTestId("test-limits", {}, LOADED), {
      target: { value: "per-ip: lots" },
    });
    fireEvent.click(page().getByTestId("test-run"));
    expect(
      (await page().findByTestId("test-error", {}, LOADED)).textContent,
    ).toBe("“per-ip: lots” is not limit=count");
    expectNone(sent, "tests sent");
  });
});
