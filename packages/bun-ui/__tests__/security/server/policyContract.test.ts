/**
 * What the policy screens (PR-U4) copy or derive from bun-security, checked
 * against it here, since the app may import its contract only:
 *
 * - the crawler registry's ids, the default allowed set and the series'
 *   outcomes;
 * - the editor's tabs: every key of the policy's JSON Schema has exactly
 *   one tab, or is edited only as the whole policy's JSON;
 * - which fields a generated form shows as JSON (a list of objects, a map,
 *   a choice of shapes), pinned, so a schema change that turns a form field
 *   into JSON is seen;
 * - the app tests' copy of the schema (`policySchema.fixture.json`), which
 *   their fake API serves as the OpenAPI component.
 */
import {
  CRAWLER_IDS,
  DEFAULT_CRAWLERS,
  inlinePolicyJsonSchema,
} from "@kingsleyweb/bun-security";
import { CRAWLER_OUTCOMES as ENGINE_OUTCOMES } from "@kingsleyweb/bun-security/analytics";
import { describe, expect, it } from "bun:test";
import fixture from "../app/policySchema.fixture.json";
import {
  CRAWLER_OUTCOMES,
  CRAWLER_REGISTRY,
  DEFAULT_ALLOWED,
} from "../../../app/security/screens/policies/registry";
import type { SchemaNode } from "../../../app/security/screens/policies/schema";
import {
  controlOf,
  propertiesOf,
} from "../../../app/security/screens/policies/schema";
import {
  JSON_ONLY_KEYS,
  POLICY_TABS,
} from "../../../app/security/screens/policies/sections";

/** The schema the API publishes. */
const SCHEMA = inlinePolicyJsonSchema() as SchemaNode;

/** The keys of `tabs` that are missing from, or doubled against, the schema's. */
function tabDisagreements(tabs: typeof POLICY_TABS): string[] {
  const keys = Object.keys(propertiesOf(SCHEMA) ?? {});
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const tab of tabs) {
    for (const key of tab.keys) {
      if (seen.has(key)) out.push(`${key} in ${seen.get(key)} and ${tab.id}`);
      seen.set(key, tab.id);
      if (!keys.includes(key))
        out.push(`${key} (${tab.id}) is not a policy key`);
    }
  }
  for (const key of keys) {
    if (!seen.has(key) && !JSON_ONLY_KEYS.includes(key))
      out.push(`${key} has no tab`);
  }
  return out;
}

/** Every field path a generated form shows as JSON under `node`. */
function jsonFields(node: SchemaNode, path: string): string[] {
  const out: string[] = [];
  for (const [key, child] of Object.entries(propertiesOf(node) ?? {})) {
    const at = path === "" ? key : `${path}.${key}`;
    const control = controlOf(child);
    if (control.kind === "json") out.push(at);
    else if (control.kind === "object")
      out.push(...jsonFields(control.node, at));
    else if (control.kind === "orFalse" && control.inner.kind === "object")
      out.push(...jsonFields(control.inner.node, at));
  }
  return out;
}

describe("the policy screens against bun-security", () => {
  it("know the crawler registry, the default set and the series' outcomes", () => {
    expect<readonly string[]>([...CRAWLER_REGISTRY]).toEqual([...CRAWLER_IDS]);
    expect<readonly string[]>([...DEFAULT_ALLOWED]).toEqual([
      ...DEFAULT_CRAWLERS,
    ]);
    expect<readonly string[]>([...CRAWLER_OUTCOMES]).toEqual([
      ...ENGINE_OUTCOMES,
    ]);
  });

  it("serve the app tests the schema the API publishes", () => {
    // Regenerate: bun -e 'import { inlinePolicyJsonSchema } from "@kingsleyweb/bun-security"; await Bun.write("__tests__/security/app/policySchema.fixture.json", JSON.stringify(inlinePolicyJsonSchema(), null, 2) + "\n")'
    expect<unknown>(fixture).toEqual(SCHEMA);
  });

  it("give every policy key exactly one tab", () => {
    expect(tabDisagreements(POLICY_TABS)).toEqual([]);
  });

  it("negative control: a key left out, or in two tabs, is seen", () => {
    const missing = POLICY_TABS.map((tab) =>
      tab.id === "shape" ? { ...tab, keys: [] } : tab,
    );
    expect(tabDisagreements(missing)).toEqual(["shape has no tab"]);
    const doubled = POLICY_TABS.map((tab) =>
      tab.id === "general" ? { ...tab, keys: [...tab.keys, "shape"] } : tab,
    );
    expect(tabDisagreements(doubled)).toEqual(["shape in general and shape"]);
  });

  it("show as JSON only the fields that are not a scalar, a list of strings or an object of them", () => {
    const formTabs = POLICY_TABS.filter((tab) => tab.kind === "schema");
    const json = formTabs.flatMap((tab) =>
      tab.keys.flatMap((key) =>
        jsonFields(
          {
            type: "object",
            properties: { [key]: propertiesOf(SCHEMA)![key] },
          },
          "",
        ),
      ),
    );
    expect(json.sort()).toEqual(
      [
        "deception.canaries",
        "deception.honeypots",
        "identifiers.patterns",
        "internal",
        "messages.limits",
        "serviceIdentity.services",
        "botSignals.weights",
        "botSignals.classes",
        "apiKeys.newAsn",
        "apiKeys.manyAddresses",
        "shape.headerLimits",
        "shape.routes",
      ].sort(),
    );
  });
});
