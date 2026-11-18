/**
 * The rules screens' pure parts (PR-U5): the matcher builder's model (every
 * target kind round-trips; a shape it does not know is kept as JSON and
 * written back as it was; a refused regex stops the save with the control
 * plane's own reason), a rule's form and JSON (other fields kept, bounds
 * checked), putting a rule into a policy, and the pasted-request readers
 * (a raw HTTP request, a curl command).
 */
import { expectUndefined } from "../../harness/assert";
import { describe, expect, it } from "bun:test";
import {
  conditionJson,
  newMatch,
  parseCondition,
  regexVerdict,
} from "../../../app/security/screens/rules/conditionModel";
import {
  newRule,
  putRule,
  removeRule,
  ruleForm,
  ruleJson,
} from "../../../app/security/screens/rules/ruleModel";
import {
  parseCurl,
  parseRawRequest,
} from "../../../app/security/screens/rules/requestParse";

/** Conditions of every target kind, as policies hold them. */
const CONDITIONS: unknown[] = [
  { path: { glob: "/**/.env*" } },
  { header: "user-agent", contains: "sqlmap", ignoreCase: true },
  { queryParam: "q", length: { gt: 200 } },
  { cookie: "session", exists: false },
  { client: { cidr: "203.0.113.0/24" } },
  { client: { cidr: ["203.0.113.0/24", "2001:db8::/32"] } },
  { contentLength: { gte: 1_000_000 } },
  { asn: { in: [64500, 64501] } },
  { asn: { exists: false } },
  { method: { in: ["PUT", "DELETE"] } },
  { path: { regex: "^/admin/[a-z]+$" } },
  {
    all: [
      { method: { equals: "POST" } },
      {
        any: [
          { country: { in: ["XX", "YY"] } },
          { not: { routeKey: { prefix: "GET " } } },
        ],
      },
    ],
  },
];

describe("the condition model", () => {
  it("round-trips every target kind and group", () => {
    for (const condition of CONDITIONS) {
      const node = parseCondition(condition);
      expect([condition, node.kind]).not.toEqual([condition, "raw"]);
      expect(conditionJson(node)).toEqual({ json: condition });
    }
  });

  it("keeps a shape it does not know as JSON, and writes it back as it was", () => {
    const odd = { path: { glob: "/a", prefix: "/b" } };
    const node = parseCondition(odd);
    expect(node.kind).toBe("raw");
    expect(conditionJson(node)).toEqual({ json: odd });
    expect(conditionJson({ kind: "raw", json: "{ not json" })).toEqual({
      error: "A condition written as JSON does not parse",
    });
  });

  it("checks a regex with the control plane's rule, live, and refuses to save a refused one", () => {
    const accepted = {
      ...newMatch(),
      op: "regex" as const,
      value: "^/admin/[a-z]+$",
    };
    expectUndefined(regexVerdict(accepted), "the accepted pattern's refusal");
    const nested = { ...newMatch(), op: "regex" as const, value: "(a+)+" };
    const verdict = regexVerdict(nested);
    expect(typeof verdict).toBe("string");
    expect(conditionJson(nested)).toEqual({ error: `Path: ${verdict}` });
    // The control: a glob is not judged as a regex.
    expectUndefined(
      regexVerdict({ ...nested, op: "glob" }),
      "a glob's regex verdict",
    );
  });

  it("says what a test lacks", () => {
    expect(conditionJson({ ...newMatch(), value: "" })).toEqual({
      error: "Path: type a value",
    });
    expect(
      conditionJson({
        ...newMatch(),
        target: "header",
        op: "equals",
        value: "x",
      }),
    ).toEqual({ error: "Header: name it" });
    expect(conditionJson({ kind: "all", children: [] })).toEqual({
      error: "An “all” group needs a test",
    });
  });
});

describe("a rule", () => {
  it("round-trips, keeping the fields the editor does not show", () => {
    const rule = {
      id: "block-sqlmap",
      when: { header: "user-agent", contains: "sqlmap", ignoreCase: true },
      action: "ban",
      mode: "dryRun",
      weight: 5,
      status: 451,
      code: "nope",
      duration: null,
      crawlers: "skip",
      locked: true,
      future: { kept: true },
    };
    expect(ruleJson(ruleForm(rule), rule)).toEqual({ rule });
  });

  it("refuses an id, weight or status out of bounds", () => {
    const form = { ...newRule(), when: { ...newMatch(), value: "/x" } };
    expect(ruleJson({ ...form, id: "no spaces" })).toEqual({
      error: "An id is 1 to 64 letters, digits, _, . and -",
    });
    expect(ruleJson({ ...form, id: "a", weight: "101" })).toEqual({
      error: "The weight is a number from 0 to 100",
    });
    expect(ruleJson({ ...form, id: "a", status: "302" })).toEqual({
      error: "The status is a whole number from 400 to 599",
    });
    // The control: in bounds, it is a rule.
    expect(
      "rule" in ruleJson({ ...form, id: "a", weight: "100", status: "599" }),
    ).toBe(true);
  });

  it("is put into a policy (other request-rule settings kept), refused on an id taken, and removed", () => {
    const policy = {
      limits: [{ id: "x" }],
      requestRules: {
        managed: { mode: "enforce" },
        rules: [{ id: "a" }, { id: "b" }],
      },
    };
    const changed = putRule(policy, "a", { id: "a2" });
    expect(changed).toEqual({
      ok: true,
      policy: {
        limits: [{ id: "x" }],
        requestRules: {
          managed: { mode: "enforce" },
          rules: [{ id: "a2" }, { id: "b" }],
        },
      },
    });
    expect(putRule(policy, "a", { id: "b" })).toEqual({
      ok: false,
      error: "A rule “b” exists already",
    });
    expect(putRule({}, null, { id: "n" })).toEqual({
      ok: true,
      policy: { requestRules: { rules: [{ id: "n" }] } },
    });
    expect(removeRule(policy, "a")).toEqual({
      limits: [{ id: "x" }],
      requestRules: { managed: { mode: "enforce" }, rules: [{ id: "b" }] },
    });
  });
});

describe("a pasted request", () => {
  it("reads a raw HTTP request, dropping its body", () => {
    expect(
      parseRawRequest(
        "POST /login?next=/ HTTP/1.1\r\nHost: shop.example\r\nUser-Agent: sqlmap\r\n\r\nuser=a&pass=b",
      ),
    ).toEqual({
      method: "POST",
      path: "/login?next=/",
      headers: { Host: "shop.example", "User-Agent": "sqlmap" },
    });
    expect(parseRawRequest("hello")).toBe(
      "The first line is not METHOD /path HTTP/1.1",
    );
  });

  it("reads a curl command: quotes, continuations, a data flag making it a POST", () => {
    expect(
      parseCurl(
        `curl 'https://shop.example/api/orders?x=1' \\\n  -H 'Authorization: Bearer t' -H "X-Note: a \\"quoted\\" word" \\\n  --data-raw '{"a":1}' -A curl/8`,
      ),
    ).toEqual({
      method: "POST",
      path: "/api/orders?x=1",
      headers: {
        Authorization: "Bearer t",
        "X-Note": 'a "quoted" word',
        "user-agent": "curl/8",
      },
    });
    expect(parseCurl("curl -X DELETE https://a.example/x -d 1")).toMatchObject({
      method: "DELETE",
    });
    expect(parseCurl("wget https://a.example")).toBe(
      "It does not start with curl",
    );
    expect(parseCurl("curl 'https://a.example")).toBe("A quote is not closed");
  });
});
