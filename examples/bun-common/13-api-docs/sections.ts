/**
 * Sections and subsections — `.describe({ tags })` puts each operation under
 * a tag, and `generateOpenApi({ tagGroups })` groups the tags into sections:
 * the document's top-level `x-tagGroups`, which Redoc, Scalar and the
 * self-hosted viewer (`@kingsleyweb/bun-ui/docs`) show as a sidebar two
 * levels deep.
 *
 * ```bash
 * bun 13-api-docs/sections.ts
 * ```
 *
 * The rules to remember: a used tag no group names goes in a trailing
 * `"Other"` group (Redoc shows no tag outside a group), a group naming a tag
 * nothing uses is left out with a warning, and two groups with one name are a
 * `ConfigError`.
 */
import { BunRouter, ConfigError } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Sections and subsections (tags + tagGroups)");

const router = new BunRouter();
const ok = { responses: { 200: null } } as const;
router
  .get("/users", (_req, res) => res.json([]))
  .describe({ summary: "List users", tags: ["Users"], ...ok });
router
  .get("/orders", (_req, res) => res.json([]))
  .describe({ summary: "List orders", tags: ["Orders"], ...ok });
router
  .get("/invoices", (_req, res) => res.json([]))
  .describe({ summary: "List invoices", tags: ["Invoices"], ...ok });
router
  .get("/health", (_req, res) => res.json({ ok: true }))
  .describe({ summary: "Liveness", tags: ["Health"], ...ok });

/* ------------------------------------------------------------------ */
step("tags are the subsections, tagGroups the sections above them");

const { document, warnings } = generateOpenApi(router, {
  title: "Shop",
  version: "1.0.0",
  tags: {
    Users: { description: "People who buy" },
    Orders: { description: "What they bought" },
    Invoices: { description: "What they owe" },
  },
  tagGroups: [
    { name: "Store", tags: ["Users", "Orders"] },
    { name: "Billing", tags: ["Invoices"] },
  ],
});
show("x-tagGroups", document["x-tagGroups"]);
checkEqual(
  "the sections, in order, with the ungrouped Health in a trailing Other",
  document["x-tagGroups"],
  [
    { name: "Store", tags: ["Users", "Orders"] },
    { name: "Billing", tags: ["Invoices"] },
    { name: "Other", tags: ["Health"] },
  ],
);
checkEqual(
  "`tags` follows the sections' order, with the descriptions",
  (document.tags as { name: string; description?: string }[]).map(
    (tag) => `${tag.name}${tag.description === undefined ? "" : ": described"}`,
  ),
  ["Users: described", "Orders: described", "Invoices: described", "Health"],
);
checkEqual("a clean configuration warns about nothing", warnings, []);

/* ------------------------------------------------------------------ */
step("a tag nothing uses is left out, with a warning");

const unused = generateOpenApi(router, {
  title: "Shop",
  version: "1.0.0",
  tagGroups: [{ name: "Store", tags: ["Users", "Orders", "Refunds"] }],
});
show(
  "warnings",
  unused.warnings.map((warning) => warning.message),
);
checkEqual(
  "Refunds is dropped from its group",
  (unused.document["x-tagGroups"] as { tags: string[] }[])[0].tags,
  ["Users", "Orders"],
);
check(
  "and the warning names it",
  unused.warnings.some((warning) => warning.message.includes('"Refunds"')),
);

/* ------------------------------------------------------------------ */
step("two sections with one name are a configuration mistake");

let error: unknown;
try {
  generateOpenApi(router, {
    title: "Shop",
    version: "1.0.0",
    tagGroups: [
      { name: "Store", tags: ["Users"] },
      { name: "Store", tags: ["Orders"] },
    ],
  });
} catch (caught) {
  error = caught;
}
check("a ConfigError, in lenient mode too", error instanceof ConfigError);

/* ------------------------------------------------------------------ */
step("without tagGroups the document has no sections");

const flat = generateOpenApi(router, { title: "Shop", version: "1.0.0" });
check(
  "no x-tagGroups, tags in first-use order",
  !Object.hasOwn(flat.document, "x-tagGroups") &&
    (flat.document.tags as { name: string }[]).map((tag) => tag.name).join() ===
      "Users,Orders,Invoices,Health",
);

summary();
