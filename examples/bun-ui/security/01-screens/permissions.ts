/**
 * What each element of the security UI needs, checked (PR-U6).
 *
 * ```bash
 * bun security/01-screens/permissions.ts
 * ```
 *
 * The UI decides nothing about access. Before it draws a section, a button
 * or a panel, it asks the API (`GET /meta/permissions?scope=<scope>`), and
 * the API asks the host's `authorize`. The package guide states every gate
 * in its table "What each element needs" (`packages/bun-ui/guides/security.md`),
 * and this example **parses that table and checks it**, three ways:
 *
 * - **The nav.** Each section in the UI's nav (`app/security/layout/nav.ts`)
 *   has a "(nav and route)" row whose permission is the one the nav gates on.
 * - **The API.** For each row naming one call, an operator whose `authorize`
 *   refuses that one permission gets a `403` from the call the element makes,
 *   and an operator holding it does not. A hidden button is a courtesy; the
 *   server's `403` is what protects.
 * - **The rest** are elements the API cannot show apart (a column, a link
 *   to another screen, a live topic), which the UI's DOM tests cover.
 *
 * Every row must be one of the three, by name, in `GATES` below: a row added
 * to the guide without a gate here, or a gate whose row went, fails the run.
 */
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { SECURITY_API_PERMISSIONS } from "@kingsleyweb/bun-security/control/contract";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { SECTIONS } from "../../../../packages/bun-ui/app/security/layout/nav";
import { check, checkEqual, summary } from "../../jobs/shared/check";
import { step, title } from "../../jobs/shared/console";

title("What each element of the security UI needs");

/** A call an element makes, and the one permission the guide says it needs. */
interface Probe {
  /** The method. */
  readonly method: string;
  /** The path under the API's base. */
  readonly path: string;
  /** The body, for a write. */
  readonly body?: unknown;
  /** The permission the row names. */
  readonly needs: (typeof SECURITY_API_PERMISSIONS)[number];
}

/**
 * Every row of the guide's table, by its "Element" cell: `"nav"` (checked
 * against the UI's nav), a {@link Probe} (checked on the API), or `"ui"`
 * (an element only the UI's DOM tests can tell apart).
 */
const GATES: Readonly<Record<string, "nav" | "ui" | Probe>> = {
  "Analytics (nav and route)": "nav",
  "Analytics: every panel but those below": {
    method: "GET",
    path: `/analytics/series?metric=requests&from=0&to=${Date.now()}`,
    needs: "analytics:read",
  },
  "Analytics: headline's ban tiles, ban timeline, top offenders' ban state": {
    method: "GET",
    path: `/analytics/bans?from=0&to=${Date.now()}`,
    needs: "bans:read",
  },
  "Analytics: top offenders by user, username or API key": "ui",
  "Analytics: top offenders' Ban link": "ui",
  "Analytics: top offenders' Allow link": "ui",
  "Analytics: agent health, IP-intel sources": {
    method: "GET",
    path: "/agents",
    needs: "agents:read",
  },
  "API reference (nav and route)": "nav",
  "Scope picker: every group and service": "ui",
  "Live updates: `bans:<scope>` topic": "ui",
  "Live updates: `policy:<scope>` topic": "ui",
  "Services (nav and route), the services list, a service's form, the groups":
    "nav",
  "Services: agents column": "ui",
  "Services: requests/min and blocked columns": "ui",
  "Services: mode column": "ui",
  "Services: the latest bundle beside an agent's": {
    method: "GET",
    path: "/services/checkout/bundle",
    needs: "bundles:read",
  },
  "Services: New service": {
    method: "POST",
    path: "/services",
    body: { id: "new-one", name: "New one" },
    needs: "services:write",
  },
  "Services: a service's Save and Delete…": "ui",
  "Groups: New group": {
    method: "POST",
    path: "/groups",
    body: { id: "new-group", name: "New group" },
    needs: "groups:write",
  },
  "Groups: a group's Edit and Delete": "ui",
  "Policies (nav and route), the editor, Versions": "nav",
  "Policies: a field's or an item's origin and lock (a service's or a group's)":
    {
      method: "GET",
      path: "/services/checkout/effective",
      needs: "policy:read",
    },
  "Policies: Override, Reset to inherited, Turn off here, New limit (and the other tables' New), Edit as JSON's changes, Save draft, Forget changes, Discard draft":
    {
      method: "PUT",
      path: "/policies/global/draft",
      body: { policy: {}, revision: null },
      needs: "policy:draft",
    },
  "Policies: Publish…, Versions' Roll back to this": {
    method: "POST",
    path: "/policies/global/publish",
    body: { expectedHead: null },
    needs: "policy:publish",
  },
  "Policies: what a draft does to each service": {
    method: "GET",
    path: "/policies/global/draft/effect",
    needs: "policy:read",
  },
  "Policies: Estimate impact (in the publish dialog), Request rules' Test a request link":
    "ui",
  "Policies: Crawlers' conflicts (in the tab and the publish dialog)": "ui",
  "Policies: Crawlers' traffic and spoofed claimants": "ui",
  "Bans (nav and route), the list, a ban's detail": "nav",
  "Bans: New ban, Lift matching…, the New ban form": {
    method: "POST",
    path: "/bans",
    body: { ip: "192.0.2.9", reason: "the example" },
    needs: "bans:write",
  },
  "A ban: Extend, Make permanent, Widen, Lift": "ui",
  "A ban: what led to it, hits since (an address)": "ui",
  "A ban: what led to it, hits since (an account)": "ui",
  "A ban: its bans in other scopes": "ui",
  "Bans: Automatic bans link": "ui",
  "Live updates: `events:<scope>` topic (while the events list or the analytics page is open)":
    "ui",
  "Live updates: `overview:<scope>` topic (while the analytics page is open)":
    "ui",
  "Lists (nav and route), the entries, CSV export": "nav",
  "Lists: entries inherited from the scopes above (a service's or a group's)":
    "ui",
  "Lists: New entry, Remove, CSV import, Save draft, Discard draft": "ui",
  "Lists: Estimate impact": {
    method: "POST",
    path: "/policies/global/impact",
    body: {},
    needs: "rules:test",
  },
  "Lists: Publish": "ui",
  "Events (nav and route), the list": "nav",
  "Events: user key, API key key and username key filters": "ui",
  "An event's detail (`/events/:id`)": "ui",
  "An event: Ban this address / user key / API key key": "ui",
  "An event: Allow / deny in lists (an address)": "ui",
  "Automatic bans (`/bans/auto`)": "ui",
  "Automatic bans: Make a fleet ban": "ui",
  "Rules (nav and route), the list, inherited rules, the managed set": "nav",
  "Rules: hits and would-blocks": "ui",
  "Rules: New rule, Edit, Remove, Discard draft, the rule editor's Save": "ui",
  "Rules: Publish": "ui",
  "Rules: Test a request link, the test": {
    method: "POST",
    path: "/rules/test",
    body: {
      service: "checkout",
      method: "GET",
      path: "/",
      peer: "203.0.113.1",
    },
    needs: "rules:test",
  },
  "Audit (nav and route), the list, an entry, the checkpoint, Verify the chain":
    "nav",
  "Audit: Export": {
    method: "GET",
    path: "/audit/export",
    needs: "audit:export",
  },
  "Approvals (nav and route), the list, an approval": "nav",
  "An approval: its diff": "ui",
  "An approval: Estimate impact": "ui",
  "An approval: Approve, Reject, Close the review": "ui",
  "Agents (nav and route), the list, an agent": "nav",
  "Agents: New agent": {
    method: "POST",
    path: "/agents",
    body: { id: "checkout-9", service: "checkout" },
    needs: "agents:write",
  },
  "An agent: Rotate, Revoke": "ui",
  "Alerts (nav and route), open alerts, the rules": "nav",
  "Alerts: New rule": {
    method: "PUT",
    path: "/alerts/rules/storm",
    body: {
      title: "Storm",
      scope: "global",
      severity: "warning",
      condition: { type: "banStorm", windowMs: 600_000, value: 50 },
      channels: [],
      revision: null,
    },
    needs: "alerts:write",
  },
  "An alert rule: Save, Delete": "ui",
  "Alerts: Channels, Delivery log, Dead letters tabs": {
    method: "GET",
    path: "/alerts/channels",
    needs: "alerts:read",
  },
  "Alerts: New channel, a channel's Save, Send a test, Rotate, Delete; a dead letter's Replay":
    {
      method: "POST",
      path: "/alerts/channels",
      body: {
        id: "mail",
        name: "Mail",
        type: "email",
        to: ["ops@example.com"],
      },
      needs: "alerts:write",
    },
};

/* ------------------------------------------------------------------ */
step("The guide's table, parsed");

/** One row of the table. */
interface Row {
  /** The "Element" cell. */
  readonly element: string;
  /** The "Needs" cell. */
  readonly needs: string;
}

/** The package's security guide: its table is the contract checked here. */
const GUIDE = join(
  import.meta.dir,
  "../../../../packages/bun-ui/guides/security.md",
);

/** The rows under `### What each element needs`. */
async function table(): Promise<Row[]> {
  const lines = (await Bun.file(GUIDE).text()).split("\n");
  const at = lines.findIndex(
    (line) => line.trim() === "### What each element needs",
  );
  if (at === -1)
    throw new Error(`${GUIDE} has no "What each element needs" section`);
  const start = lines.findIndex(
    (line, index) => index > at && line.startsWith("|"),
  );
  const rows: Row[] = [];
  // The header and the |---| separator are skipped; the first non-row ends it.
  for (let index = start + 2; lines[index]?.startsWith("|"); index++) {
    const cells = lines[index]!.split("|").map((cell) => cell.trim());
    rows.push({ element: cells[1]!, needs: cells.slice(2, -1).join("|") });
  }
  return rows;
}

const rows = await table();
console.log(`  ${rows.length} rows`);

/** The backticked names in a cell that look like permissions. */
const named = (needs: string) =>
  [...needs.matchAll(/`([a-z]+:[a-z]+)`/g)].map((match) => match[1]!);

/** The permissions the API checks. */
const known = new Set<string>(SECURITY_API_PERMISSIONS);

/** The live topics' names (`bans:<scope>`): backticked like permissions, but not ones. */
const TOPIC = /^(?:bans|policy|events|overview):/;

/** What is wrong with `rows` against `GATES` and the nav: one line each, empty when they agree. */
function problems(rows: readonly Row[]): string[] {
  const out: string[] = [];
  const elements = rows.map((row) => row.element);
  for (const element of elements)
    if (!(element in GATES)) out.push(`a row without a gate: ${element}`);
  for (const element of Object.keys(GATES))
    if (!elements.includes(element))
      out.push(`a gate without a row: ${element}`);
  for (const row of rows) {
    for (const name of named(row.needs)) {
      if (!known.has(name) && !TOPIC.test(name))
        out.push(`an unknown permission: ${row.element}: ${name}`);
    }
  }
  for (const section of SECTIONS) {
    const row = rows.find((item) =>
      item.element.startsWith(`${section.label} (nav and route)`),
    );
    if (row === undefined) {
      out.push(`no "(nav and route)" row for ${section.label}`);
      continue;
    }
    const says = section.needs === null ? row.needs : named(row.needs)[0];
    const wants = section.needs === null ? "signing in" : section.needs;
    if (says !== wants)
      out.push(
        `${section.label}: the table says ${says}, the nav gates on ${wants}`,
      );
    if (GATES[row.element] !== "nav")
      out.push(`${section.label}'s row is not classified "nav"`);
  }
  for (const [element, gate] of Object.entries(GATES)) {
    if (
      gate === "nav" &&
      !SECTIONS.some((section) =>
        element.startsWith(`${section.label} (nav and route)`),
      )
    )
      out.push(`a "nav" gate that is no nav section: ${element}`);
  }
  return out;
}

/* ------------------------------------------------------------------ */
step(
  "The table against GATES and the UI's nav: every row gated, every permission real, the nav as the table says",
);

checkEqual("problems", problems(rows), []);

/* ------------------------------------------------------------------ */
step("Negative controls: the same comparison catches each kind of drift");

const navRow = rows.find((row) =>
  row.element.startsWith("Audit (nav and route)"),
)!;
const drifted: readonly (readonly [string, readonly Row[]])[] = [
  [
    "a row added to the guide",
    [...rows, { element: "Something new", needs: "`audit:read` on global" }],
  ],
  ["a row gone from the guide", rows.filter((row) => row !== navRow)],
  [
    "a nav row's permission changed",
    rows.map((row) =>
      row === navRow ? { ...row, needs: "`agents:read` on the scope" } : row,
    ),
  ],
  [
    "an unknown permission",
    rows.map((row) =>
      row === navRow ? { ...row, needs: "`audit:readall` on the scope" } : row,
    ),
  ],
];
for (const [label, mutated] of drifted) {
  check(`caught: ${label}`, problems(mutated).length > 0, { label });
}

/* ------------------------------------------------------------------ */
step(
  "The API refuses each probed call without its permission, and takes it with it",
);

/** The operator id `lacks:<permission>` lacks that one permission; `full` lacks none. */
const api = createSecurityApi({
  store: memoryStore(),
  authenticate: (req) => {
    const id = req.request.headers.get("x-op");
    return id === null ? null : { id };
  },
  authorize: (operator, permission) =>
    !operator.id.startsWith("lacks:") ||
    operator.id.slice("lacks:".length) !== permission,
  allowWithoutStepUp: true,
  signing: {
    keyId: "sk",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  },
  audit: {
    signing: {
      keyId: "ak",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    allowNoExternalCheckpoints: true,
  },
  bans: { secret: "an-example-fleet-secret-0123456789abcdef" },
  agents: {
    allowEphemeralStore: true,
    artefacts: { dir: join(import.meta.dir, ".artefacts") },
  },
  alerts: { timers: false },
  logger: () => {},
});
const app = new BunHttpAdapter(0, { logger: () => {} });
app.use(api.basePath, api.router);

/** A call as `op`. */
async function call(op: string, probe: Omit<Probe, "needs">): Promise<number> {
  const response = await app.fetch(`${api.basePath}${probe.path}`, {
    method: probe.method,
    headers: {
      "content-type": "application/json",
      "x-bun-security-csrf": "1",
      "x-op": op,
    },
    ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
  });
  await response.body?.cancel();
  return response.status;
}

// What the probes read and write.
await call("full", {
  method: "POST",
  path: "/services",
  body: { id: "checkout", name: "Checkout" },
});
await call("full", {
  method: "PUT",
  path: "/policies/global/draft",
  body: { policy: {}, revision: null },
});
await call("full", {
  method: "POST",
  path: "/policies/global/publish",
  body: { expectedHead: null },
});

for (const [element, gate] of Object.entries(GATES)) {
  if (typeof gate === "string") continue;
  // An unrelated permission refused: the call is still taken, so the 403
  // is this permission's.
  const unrelated = gate.needs === "roles:write" ? "roles:read" : "roles:write";
  const refused = await call(`lacks:${gate.needs}`, gate);
  const other = await call(`lacks:${unrelated}`, gate);
  const taken = await call("full", gate);
  check(`${element}: 403 without ${gate.needs}`, refused === 403, { refused });
  check(`${element}: not 403 without ${unrelated} alone`, other !== 403, {
    other,
  });
  check(`${element}: not 403 with it`, taken !== 403, { taken });
}

api.close();
await Bun.$`rm -rf ${join(import.meta.dir, ".artefacts")}`.quiet();
summary();
