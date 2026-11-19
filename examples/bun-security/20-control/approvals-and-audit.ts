/**
 * Changing a production policy safely through the control plane's API:
 * step-up, a two-person approval, and the audit hash chain that records it
 * all, checked by `verifyAudit()` after an entry is edited behind its back.
 *
 * ```bash
 * bun 20-control/approvals-and-audit.ts
 * ```
 *
 * - **Step-up**: publishing needs the host's fresh second factor
 *   (`stepUp.verify`); without it the answer is `401 step_up_required`
 *   carrying `stepUp.challenge`'s URL, for the UI to send the operator there.
 * - **A dangerous change** (here a limit from dry run to enforced on a
 *   production service), with `approvals: "two-person"`, opens an approval
 *   (`202`) a second operator decides; its author may not approve it.
 * - **The audit log** records every change in a hash chain in the store,
 *   an `intent` entry before each change and a `done` after it.
 *   `verifyAudit()` recomputes the chain and names the first entry where it
 *   broke, and alerts `audit.verifyFailed`.
 *
 * The store is a temporary SQLite file, so the example can edit an entry by
 * hand, as someone with access to the database would.
 */
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import {
  createSecurityApi,
  fileCheckpointSink,
} from "@kingsleyweb/bun-security/control";
import type { SecurityAlertDto } from "@kingsleyweb/bun-security/control/contract";
import { sqliteStore } from "@kingsleyweb/bun-security/store";
import { check, checkEqual, summary } from "../shared/check";
import { fakeClock } from "../shared/facts";
import { show, step, title } from "../shared/console";

title("step-up, a two-person approval and the audit chain");

const dir = mkdtempSync(join(tmpdir(), "bun-security-example-audit-"));
const path = join(dir, "security.sqlite");
const checkpoints = join(dir, "checkpoints.jsonl");
const clock = fakeClock();
const store = sqliteStore({ path, now: clock.now });
await store.connect();

/** Whether the operator's second factor is fresh: the host's MFA, played here. */
let fresh = false;
const alerts: SecurityAlertDto[] = [];
const api = createSecurityApi({
  store,
  // The host's sign-in: here the operator's id in a header.
  authenticate: (req) => {
    const id = req.request.headers.get("x-op");
    return id === null ? null : { id, name: id };
  },
  owners: ["alice", "bob"],
  approvals: "two-person",
  stepUp: { verify: () => fresh, challenge: () => "https://idp.example/mfa" },
  signing: {
    keyId: "sk_example",
    privateKey: generateKeyPairSync("ed25519").privateKey,
  },
  audit: {
    // A key of its own: the bundle key is refused for the audit.
    signing: {
      keyId: "ak_example",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    sinks: [fileCheckpointSink(checkpoints)],
    checkpointEvery: 4,
  },
  bans: { secret: "fleet-keying-secret-for-the-example-0123456789" },
  onAlert: (alert) => alerts.push(alert),
  now: clock.now,
  logger: () => {},
});
const app = new BunHttpAdapter(0, { logger: () => {} });
app.use(api.basePath, api.router);

/** What this example reads of the API's answers: each optional, as each answer has some. */
interface Answer {
  /** A problem's code. */
  readonly code?: string;
  /** A step-up problem's URL. */
  readonly stepUpUrl?: string;
  /** An approval's id. */
  readonly id?: string;
  /** An approval's status. */
  readonly status?: string;
  /** A published version. */
  readonly version?: { readonly id: string; readonly number: number };
  /** A decided approval. */
  readonly approval?: { readonly decidedBy?: string };
  /** What an approved change did. */
  readonly result?: { readonly version?: { readonly number: number } };
  /** A page of the audit log. */
  readonly items?: readonly { n: number; phase: string; action: string }[];
}

/** Calls the API as `op`: the status and the parsed body. */
async function call(
  method: string,
  route: string,
  body?: unknown,
  op = "alice",
) {
  const response = await app.fetch(`${api.basePath}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      // Every mutation carries the CSRF header (any value).
      "x-bun-security-csrf": "1",
      "x-op": op,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === "" ? {} : JSON.parse(text)) as Answer,
  };
}

/* ------------------------------------------------------------------ */
step("a production service, and a dry-run limit to publish");

checkEqual(
  "a service",
  (await call("POST", "/services", { id: "checkout", name: "Checkout" }))
    .status,
  201,
);
await call("PUT", "/policies/global/draft", {
  policy: { limits: [{ id: "x", limit: 10, window: "1m", mode: "dryRun" }] },
  revision: null,
});

/* ------------------------------------------------------------------ */
step("publishing needs a fresh second factor (step-up)");

const asked = await call("POST", "/policies/global/publish", {
  expectedHead: null,
});
show("without it", asked.body);
checkEqual(
  "401 step_up_required, with the host's challenge URL",
  [asked.status, asked.body.code, asked.body.stepUpUrl],
  [401, "step_up_required", "https://idp.example/mfa"],
);
fresh = true;
const first = await call("POST", "/policies/global/publish", {
  expectedHead: null,
});
checkEqual("with it: published, version 1", first.body.version?.number, 1);

/* ------------------------------------------------------------------ */
step("enforcing the limit is dangerous: an approval, decided by another owner");

await call("PUT", "/policies/global/draft", {
  policy: { limits: [{ id: "x", limit: 10, window: "1m" }] },
  revision: null,
});
const opened = await call("POST", "/policies/global/publish", {
  expectedHead: first.body.version?.id,
  message: "enforce x",
});
show("the approval", opened.body);
checkEqual(
  "202: an approval, pending",
  [opened.status, opened.body.status],
  [202, "pending"],
);
check(
  "it says why: the limit goes from dry run to enforced",
  JSON.stringify(opened.body).includes("from dry run to enforced"),
  opened.body,
);
const self = await call(
  "POST",
  `/approvals/${opened.body.id}/approve`,
  { revision: 1 },
  "alice",
);
checkEqual(
  "its author may not approve it",
  [self.status, self.body.code],
  [403, "self_approval"],
);
const approved = await call(
  "POST",
  `/approvals/${opened.body.id}/approve`,
  { revision: 1, reason: "reviewed the impact" },
  "bob",
);
checkEqual(
  "bob approves: published as version 2",
  [
    approved.status,
    approved.body.approval?.decidedBy,
    approved.body.result?.version?.number,
  ],
  [200, "bob", 2],
);

/* ------------------------------------------------------------------ */
step("the audit chain: every change, intent first");

const page = await call("GET", "/audit?direction=asc&limit=200");
const lines = (
  page.body.items as { n: number; phase: string; action: string }[]
).map((entry) => `${entry.n} ${entry.phase} ${entry.action}`);
show("the chain", lines);
for (const action of [
  "service.put",
  "policy.publish",
  "approval.open",
  "approval.approve",
]) {
  check(
    `an intent and a done for ${action}`,
    lines.some((line) => line.endsWith(`intent ${action}`)) &&
      lines.some((line) => line.endsWith(`done ${action}`)),
    lines,
  );
}
check(
  "the refused publish is recorded too (access.refused)",
  lines.some((line) => line.includes("access.refused")),
  lines,
);
const verified = await api.verifyAudit();
checkEqual(
  "verifyAudit(): the chain holds",
  [verified.ok, verified.problems],
  [true, []],
);
check(
  "a checkpoint was signed and written to the sink",
  readFileSync(checkpoints, "utf8").trim().split("\n").length > 0 &&
    verified.checkpoints.checked > 0,
  verified.checkpoints,
);

/* ------------------------------------------------------------------ */
step("someone edits an entry in the database: verifyAudit names it");

const db = new Database(path);
db.run(
  `UPDATE bun_security_audit SET entry = json_set(entry, '$.actor', 'mallory') WHERE n = 3`,
);
db.close();
const broken = await api.verifyAudit();
show("verifyAudit()", broken.problems[0]);
checkEqual(
  "not ok: a hash mismatch at entry 3",
  [broken.ok, broken.problems[0]?.n, broken.problems[0]?.reason],
  [false, 3, "hash-mismatch"],
);
check(
  "and an audit.verifyFailed alert",
  alerts.some((alert) => alert.kind === "audit.verifyFailed"),
  alerts.map((alert) => alert.kind),
);

api.close();
await store.close?.();
rmSync(dir, { recursive: true, force: true });
summary();
