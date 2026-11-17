/**
 * The audit log (PR-CP3, control-plane.md §6): every change recorded as an
 * intent before it and a done after it, the chain and its signed
 * checkpoints, the sinks, `verify` against tampering (edit, delete,
 * reorder, truncate, a forged checkpoint), reconciliation of an intent with
 * no done, export, retention, and the audit permissions. Each behaviour has
 * its refusal or negative control beside it.
 */
import { Buffer } from "node:buffer";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { createHmac, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, createTestLogger } from "@kingsleyweb/bun-common";
import type { SecurityAlertDto } from "../../lib/control/contract/index";
import {
  auditHash,
  callbackCheckpointSink,
  createSecurityApi,
  fileCheckpointSink,
  webhookCheckpointSink,
} from "../../lib/control/index";
import { memoryStore, sqliteStore } from "../../lib/store/index";
import type { AuditCheckpoint } from "../../lib/store/index";
import { faultyStore } from "../../lib/testing/index";
import { fakeClock } from "../helpers";
import { testApi } from "./helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory, removed after the file. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-security-audit-"));
  dirs.push(dir);
  return dir;
}

/** Some changes: a group, two services, a role binding, a draft and a publish. */
async function someChanges(
  call: ReturnType<typeof testApi>["call"],
): Promise<void> {
  expect(
    (await call("POST", "/groups", { id: "payments", name: "Payments" }))
      .status,
  ).toBe(201);
  expect(
    (
      await call("POST", "/services", {
        id: "checkout",
        name: "Checkout",
        groups: ["payments"],
      })
    ).status,
  ).toBe(201);
  expect(
    (await call("POST", "/services", { id: "blog", name: "Blog" })).status,
  ).toBe(201);
  expect(
    (
      await call("POST", "/role-bindings", {
        operator: "dave",
        role: "viewer",
        scope: "global",
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("PUT", "/policies/global/draft", {
        policy: {},
        revision: null,
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("POST", "/policies/global/publish", { expectedHead: null }))
      .status,
  ).toBe(200);
}

/** An API over a SQLite file (to tamper with by hand), checkpointing every `every` entries. */
async function sqliteApi(
  every = 4,
  sinks?: Parameters<typeof callbackCheckpointSink>[0][],
) {
  const path = join(tempDir(), "security.sqlite");
  const clock = fakeClock();
  const store = sqliteStore({ path, now: clock.now });
  await store.connect();
  const alerts: SecurityAlertDto[] = [];
  const test = testApi({
    store,
    now: clock.now,
    onAlert: (alert) => alerts.push(alert),
    audit: {
      signing: {
        keyId: "ak_test",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
      checkpointEvery: every,
      ...(sinks === undefined
        ? { allowNoExternalCheckpoints: true }
        : { sinks: sinks.map((sink) => callbackCheckpointSink(sink)) }),
    },
  });
  const db = new Database(path);
  return { ...test, store, db, alerts, clock };
}

describe("every change is recorded, intent first", () => {
  it("records an intent and a done for each change, with who, from where, the permissions and the step-up", async () => {
    const { api, call } = testApi();
    await someChanges(call);
    const page = (await call("GET", "/audit?direction=asc&limit=200")).body;
    const actions = page.items.map(
      (item: { action: string; phase: string }) =>
        `${item.phase} ${item.action}`,
    );
    for (const action of [
      "group.put",
      "service.put",
      "roleBinding.create",
      "policy.draft",
      "policy.publish",
    ]) {
      expect(actions).toContain(`intent ${action}`);
      expect(actions).toContain(`done ${action}`);
    }
    const intent = page.items.find(
      (item: { action: string }) => item.action === "service.put",
    );
    expect(intent).toMatchObject({
      phase: "intent",
      status: "done",
      actor: "alice",
      scope: "service:checkout",
    });
    expect(intent.entry).toMatchObject({
      actor: { id: "alice", kind: "operator" },
      target: { kind: "service", id: "checkout", revision: 1 },
      after: { name: "Checkout" },
    });
    expect(intent.entry.permissions.length).toBeGreaterThan(0);
    const done = page.items.find(
      (item: { phase: string; entry: { intent?: number } }) =>
        item.phase === "done" && item.entry.intent === intent.n,
    );
    expect(done.entry).toMatchObject({ outcome: "applied", revision: 1 });
    // A publish records its diff, not the whole policy, and names its version.
    const publish = page.items.find(
      (item: { action: string; phase: string }) =>
        item.action === "policy.publish" && item.phase === "done",
    );
    expect(publish.entry.version).toMatch(/^pv/);
    expect((await api.verifyAudit()).ok).toBe(true);
  });

  it("records a refused change with why, so attempts are audited too", async () => {
    const { call } = testApi();
    await call("POST", "/services", { id: "blog", name: "Blog" });
    expect(
      (await call("POST", "/services", { id: "blog", name: "Again" })).status,
    ).toBe(409);
    const page = (await call("GET", "/audit?direction=asc")).body;
    const last = page.items.at(-1);
    expect(last.entry).toMatchObject({
      phase: "done",
      outcome: "refused",
      reason: "conflict",
    });
  });

  it("refuses the change (503) and changes nothing when the intent cannot be written", async () => {
    let calls = 0;
    let failAfter = Number.POSITIVE_INFINITY;
    const store = faultyStore(memoryStore(), {
      fail: (operation) =>
        operation === "appendAudit" && ++calls > failAfter
          ? new Error("audit down")
          : undefined,
    });
    const { call } = testApi({ store });
    failAfter = calls;
    const refused = await call("POST", "/services", {
      id: "checkout",
      name: "Checkout",
    });
    expect([refused.status, refused.body.code]).toEqual([
      503,
      "audit_unavailable",
    ]);
    expect(await store.get("service", "checkout")).toBeUndefined();
    // It tried more than once (a raced head or a blip is retried).
    expect(calls).toBe(3);
    failAfter = Number.POSITIVE_INFINITY;
    expect(
      (await call("POST", "/services", { id: "checkout", name: "Checkout" }))
        .status,
    ).toBe(201);
  });

  it("negative control: the old order (change, then record) leaves a change with no audit trace", async () => {
    let auditDown = false;
    const store = faultyStore(memoryStore(), {
      fail: (operation) =>
        operation === "appendAudit" && auditDown
          ? new Error("audit down")
          : undefined,
    });
    const { api } = testApi({ store });
    auditDown = true;
    // What recording after the change did: the change lands, the record fails.
    await store.put("service", "checkout", { name: "Checkout" } as never, null);
    await expect(
      api.plane.audit.event("service.put", "service:checkout", {}),
    ).rejects.toThrow();
    expect(await store.get("service", "checkout")).toBeDefined();
    auditDown = false;
    expect((await store.listAudit({ limit: 10 })).items).toHaveLength(0);
  });

  it("when the done cannot be written the change stands, the answer says so, and the intent reconciles as completed-unconfirmed", async () => {
    let calls = 0;
    let failAfter = Number.POSITIVE_INFINITY;
    const store = faultyStore(memoryStore(), {
      fail: (operation) =>
        operation === "appendAudit" && ++calls > failAfter
          ? new Error("audit down")
          : undefined,
    });
    const { api, call } = testApi({ store });
    failAfter = calls + 1; // the intent goes through, every try at the done fails
    const answer = await call("POST", "/services", {
      id: "checkout",
      name: "Checkout",
    });
    expect(answer.status).toBe(201);
    expect(answer.headers.get("x-bun-security-audit")).toBe("incomplete");
    failAfter = Number.POSITIVE_INFINITY;
    expect(await store.get("service", "checkout")).toBeDefined();
    const page = (await call("GET", "/audit?action=service.put")).body;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      phase: "intent",
      status: "completed-unconfirmed",
    });
    const verified = await api.verifyAudit();
    // Never reported as tampering.
    expect(verified.ok).toBe(true);
    expect(verified.problems).toEqual([]);
    expect(verified.unconfirmed).toEqual([
      {
        n: page.items[0].n,
        action: "service.put",
        scope: "service:checkout",
        status: "completed-unconfirmed",
      },
    ]);
    // Negative control: a change whose done was written carries no header.
    const clean = await call("POST", "/services", { id: "blog", name: "Blog" });
    expect(clean.headers.get("x-bun-security-audit")).toBeNull();
  });

  it("reconciles an intent whose change never landed as not-applied", async () => {
    let calls = 0;
    let failAfter = Number.POSITIVE_INFINITY;
    let putDown = false;
    const store = faultyStore(memoryStore(), {
      fail: (operation) =>
        (operation === "appendAudit" && ++calls > failAfter) ||
        (operation === "put" && putDown)
          ? new Error("down")
          : undefined,
    });
    const { api, call } = testApi({ store });
    await call("POST", "/services", { id: "blog", name: "Blog" });
    failAfter = calls + 1;
    putDown = true;
    expect(
      (await call("POST", "/services", { id: "checkout", name: "Checkout" }))
        .status,
    ).toBe(500);
    failAfter = Number.POSITIVE_INFINITY;
    putDown = false;
    const verified = await api.verifyAudit();
    expect(verified.ok).toBe(true);
    expect(verified.unconfirmed).toEqual([
      expect.objectContaining({
        action: "service.put",
        scope: "service:checkout",
        status: "not-applied",
      }),
    ]);
    // A delete reconciles the other way round: gone is applied.
    failAfter = calls + 1;
    const blog = await store.get("service", "blog");
    expect(
      (await call("DELETE", `/services/blog?revision=${blog!.revision}`))
        .status,
    ).toBe(204);
    failAfter = Number.POSITIVE_INFINITY;
    const after = await api.verifyAudit();
    expect(
      after.unconfirmed.find((item) => item.action === "service.delete")
        ?.status,
    ).toBe("completed-unconfirmed");
  });
});

describe("verify names where the chain broke", () => {
  it("a clean chain verifies, checkpoints included", async () => {
    const { api, call, db } = await sqliteApi();
    await someChanges(call);
    const verified = await api.verifyAudit();
    expect(verified).toMatchObject({
      ok: true,
      problems: [],
      external: "none-configured",
      first: 1,
    });
    expect(verified.checkpoints.checked).toBeGreaterThan(0);
    db.close();
  });

  it("an edited entry: hash-mismatch at that entry", async () => {
    const { api, call, db, alerts } = await sqliteApi();
    await someChanges(call);
    expect((await api.verifyAudit()).ok).toBe(true); // control: before the edit
    db.run(
      `UPDATE bun_security_audit SET entry = json_set(entry, '$.after.name', 'Evil') WHERE n = 3`,
    );
    const verified = await api.verifyAudit();
    expect(verified.ok).toBe(false);
    expect(verified.problems[0]).toMatchObject({
      n: 3,
      reason: "hash-mismatch",
    });
    expect(alerts.map((alert) => alert.kind)).toContain("audit.verifyFailed");
    db.close();
  });

  it("an edited column (actor, action, scope or time) is an edit too, though the body is untouched", async () => {
    const { api, call, db } = await sqliteApi();
    await someChanges(call);
    db.run(`UPDATE bun_security_audit SET actor = 'mallory' WHERE n = 2`);
    db.run(`UPDATE bun_security_audit SET action = 'service.get' WHERE n = 4`);
    const verified = await api.verifyAudit();
    expect(
      verified.problems.map((problem) => [problem.n, problem.reason]),
    ).toEqual([
      [2, "hash-mismatch"],
      [4, "hash-mismatch"],
    ]);
  });

  it("an edited entry whose hash was recomputed: the next entry no longer follows it, and the checkpoint disagrees", async () => {
    const { api, call, db } = await sqliteApi(4);
    await someChanges(call);
    const row = db
      .query<{ prev_hash: string; entry: string }, []>(
        `SELECT prev_hash, entry FROM bun_security_audit WHERE n = 3`,
      )
      .get()!;
    const forged = { ...JSON.parse(row.entry), after: { name: "Evil" } };
    db.run(`UPDATE bun_security_audit SET entry = ?, hash = ? WHERE n = 3`, [
      JSON.stringify(forged),
      auditHash(row.prev_hash, forged),
    ]);
    const verified = await api.verifyAudit();
    // Its own hash checks out (so a per-entry check alone would miss it) ...
    expect(
      verified.problems.some(
        (problem) => problem.n === 3 && problem.reason === "hash-mismatch",
      ),
    ).toBe(false);
    // ... but the chain does not.
    expect(verified.problems[0]).toMatchObject({ n: 4, reason: "order" });
    db.close();
  });

  it("a deleted entry: a gap where it was", async () => {
    const { api, call, db } = await sqliteApi();
    await someChanges(call);
    db.run(`DELETE FROM bun_security_audit WHERE n = 5`);
    const verified = await api.verifyAudit();
    expect(verified.problems[0]).toMatchObject({ n: 5, reason: "gap" });
    // Negative control: every remaining entry's own hash is intact.
    expect(
      verified.problems.some((problem) => problem.reason === "hash-mismatch"),
    ).toBe(false);
    db.close();
  });

  it("reordered entries: order at the first one moved", async () => {
    const { api, call, db } = await sqliteApi();
    await someChanges(call);
    const columns = "prev_hash, hash, at, actor, action, scope, entry";
    const six = db
      .query(`SELECT ${columns} FROM bun_security_audit WHERE n = 6`)
      .get() as Record<string, unknown>;
    const seven = db
      .query(`SELECT ${columns} FROM bun_security_audit WHERE n = 7`)
      .get() as Record<string, unknown>;
    const set = `prev_hash = $prev_hash, hash = $hash, at = $at, actor = $actor, action = $action, scope = $scope, entry = $entry`;
    const bind = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [`$${key}`, value]),
      );
    db.query(`UPDATE bun_security_audit SET ${set} WHERE n = 6`).run(
      bind(seven) as never,
    );
    db.query(`UPDATE bun_security_audit SET ${set} WHERE n = 7`).run(
      bind(six) as never,
    );
    const verified = await api.verifyAudit();
    expect(verified.problems[0]).toMatchObject({ n: 6, reason: "order" });
    expect(
      verified.problems.some((problem) => problem.reason === "hash-mismatch"),
    ).toBe(false);
    db.close();
  });

  it("a truncated end: truncated, from the head row, and from a checkpoint when the head row is rewritten too", async () => {
    const { api, call, db } = await sqliteApi(4);
    await someChanges(call);
    const last = (
      db.query(`SELECT max(n) AS n FROM bun_security_audit`).get() as {
        n: number;
      }
    ).n;
    const latest = (
      await api.plane.store.listCheckpoints({ limit: 1, direction: "desc" })
    ).items[0]!;
    const cut = latest.n - 1;
    db.run(`DELETE FROM bun_security_audit WHERE n > ?`, [cut]);
    let verified = await api.verifyAudit();
    expect(verified.problems).toEqual([
      expect.objectContaining({ n: cut + 1, reason: "truncated" }),
    ]);
    // The head row moved back to match: the checkpoint still vouches for more.
    const kept = db
      .query(`SELECT hash FROM bun_security_audit WHERE n = ?`)
      .get(cut) as { hash: string };
    db.run(`UPDATE bun_security_audit_head SET n = ?, hash = ? WHERE id = 1`, [
      cut,
      kept.hash,
    ]);
    verified = await api.verifyAudit();
    expect(verified.problems).toEqual([
      expect.objectContaining({
        n: cut + 1,
        reason: "truncated",
        source: "store",
      }),
    ]);
    // Negative control: with the store's checkpoints gone too and no sink, nothing is left to tell.
    db.run(`DELETE FROM bun_security_audit_checkpoints WHERE n > ?`, [cut]);
    verified = await api.verifyAudit();
    expect(verified.ok).toBe(true);
    expect(verified.external).toBe("none-configured");
    expect(last).toBeGreaterThan(cut);
    db.close();
  });

  it("an external sink that can be read back catches the truncation the store no longer shows", async () => {
    const outside: AuditCheckpoint[] = [];
    const { api, call, db } = await sqliteApi(4, [
      {
        name: "vault",
        write: (checkpoint) => void outside.push(checkpoint),
        read: () => outside,
      },
    ]);
    await someChanges(call);
    const latest = outside.at(-1)!;
    const cut = latest.n - 1;
    db.run(`DELETE FROM bun_security_audit WHERE n > ?`, [cut]);
    const kept = db
      .query(`SELECT hash FROM bun_security_audit WHERE n = ?`)
      .get(cut) as { hash: string };
    db.run(`UPDATE bun_security_audit_head SET n = ?, hash = ? WHERE id = 1`, [
      cut,
      kept.hash,
    ]);
    db.run(`DELETE FROM bun_security_audit_checkpoints WHERE n > ?`, [cut]);
    const verified = await api.verifyAudit();
    expect(verified.external).toBe("checked");
    expect(verified.problems).toEqual([
      expect.objectContaining({
        n: cut + 1,
        reason: "truncated",
        source: "vault",
      }),
    ]);
    db.close();
  });

  it("a forged checkpoint: checkpoint-signature; one signed by the key but naming another hash: checkpoint-mismatch", async () => {
    const { api, call, db } = await sqliteApi(100);
    await someChanges(call);
    expect((await api.verifyAudit()).ok).toBe(true);
    const other = generateKeyPairSync("ed25519");
    const hash = (
      db.query(`SELECT hash FROM bun_security_audit WHERE n = 2`).get() as {
        hash: string;
      }
    ).hash;
    const at = 1;
    const bytes = new TextEncoder().encode(JSON.stringify({ at, hash, n: 2 }));
    const forged = edSign(null, bytes, other.privateKey).toString("base64");
    db.run(
      `INSERT INTO bun_security_audit_checkpoints (n, hash, at, key_id, signature) VALUES (2, ?, ?, 'ak_test', ?)`,
      [hash, at, forged],
    );
    let verified = await api.verifyAudit();
    expect(verified.problems).toEqual([
      expect.objectContaining({ n: 2, reason: "checkpoint-signature" }),
    ]);
    db.run(`DELETE FROM bun_security_audit_checkpoints`);
    // Signed by the real audit key over the wrong hash: the signature holds, the chain disagrees.
    const real = await api.checkpointAudit();
    db.run(`UPDATE bun_security_audit SET hash = ? WHERE n = ?`, [
      "f".repeat(64),
      real!.n,
    ]);
    verified = await api.verifyAudit();
    expect(verified.problems.map((problem) => problem.reason)).toContain(
      "checkpoint-mismatch",
    );
    db.close();
  });
});

describe("checkpoints and sinks", () => {
  it("signs a checkpoint every N entries with the audit key, writes it to each sink, and a webhook's signature checks out", async () => {
    const received: { body: string; headers: Record<string, string> }[] = [];
    const secret = "s".repeat(32);
    const auditKey = generateKeyPairSync("ed25519");
    const { api, call } = testApi({
      audit: {
        signing: { keyId: "ak_1", privateKey: auditKey.privateKey },
        checkpointEvery: 2,
        sinks: [
          webhookCheckpointSink({
            url: "https://audit.example/checkpoints",
            secret,
            fetch: async (_url, init) => {
              received.push({ body: init.body, headers: init.headers });
              return new Response(null, { status: 204 });
            },
          }),
        ],
      },
    });
    await call("POST", "/services", { id: "blog", name: "Blog" });
    expect(received).toHaveLength(1);
    const { body, headers } = received[0]!;
    const expected = createHmac("sha256", secret)
      .update(`${headers["x-bun-security-timestamp"]}.${body}`)
      .digest("hex");
    expect(headers["x-bun-security-signature"]).toBe(`sha256=${expected}`);
    const checkpoint = JSON.parse(body) as AuditCheckpoint;
    expect(checkpoint).toMatchObject({ n: 2, keyId: "ak_1" });
    // The audit key's public half verifies it; the store has it too.
    const { verify } = await import("node:crypto");
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        at: checkpoint.at,
        hash: checkpoint.hash,
        n: checkpoint.n,
      }),
    );
    expect(
      verify(
        null,
        bytes,
        auditKey.publicKey,
        Buffer.from(checkpoint.signature, "base64"),
      ),
    ).toBe(true);
    // Negative controls: another key, or a body signed with another secret, fails.
    expect(
      verify(
        null,
        bytes,
        generateKeyPairSync("ed25519").publicKey,
        Buffer.from(checkpoint.signature, "base64"),
      ),
    ).toBe(false);
    expect(headers["x-bun-security-signature"]).not.toBe(
      `sha256=${createHmac("sha256", "t".repeat(32)).update(`${headers["x-bun-security-timestamp"]}.${body}`).digest("hex")}`,
    );
    expect(
      (await call("GET", "/audit/checkpoints")).body.items[0],
    ).toMatchObject({ n: 2 });
    expect((await api.verifyAudit()).external).toBe("write-only");
  });

  it("checkpoints after the interval even below N entries", async () => {
    const written: AuditCheckpoint[] = [];
    const { call, clock } = testApi({
      audit: {
        signing: {
          keyId: "ak_1",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        checkpointEvery: 1_000,
        checkpointInterval: "1h",
        sinks: [
          callbackCheckpointSink({
            write: (checkpoint) => void written.push(checkpoint),
          }),
        ],
      },
    });
    await call("POST", "/services", { id: "a", name: "A" });
    clock.advance(30 * 60_000);
    await call("POST", "/services", { id: "b", name: "B" });
    expect(written).toHaveLength(0);
    clock.advance(31 * 60_000);
    // An hour after the first entry: the next append checkpoints.
    await call("POST", "/services", { id: "c", name: "C" });
    expect(written.map((checkpoint) => checkpoint.n)).toEqual([5]);
    clock.advance(30 * 60_000);
    await call("POST", "/services", { id: "d", name: "D" });
    expect(written).toHaveLength(1);
    clock.advance(31 * 60_000);
    await call("POST", "/services", { id: "e", name: "E" });
    expect(written.map((checkpoint) => checkpoint.n)).toEqual([5, 9]);
  });

  it("a sink outage never blocks a change: it alerts, and the missed checkpoint goes with the next", async () => {
    let down = true;
    const written: number[] = [];
    const alerts: SecurityAlertDto[] = [];
    const { call } = testApi({
      onAlert: (alert) => alerts.push(alert),
      audit: {
        signing: {
          keyId: "ak_1",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        checkpointEvery: 2,
        sinks: [
          callbackCheckpointSink({
            name: "siem",
            write: (checkpoint) => {
              if (down) throw new Error("siem unreachable");
              written.push(checkpoint.n);
            },
          }),
        ],
      },
    });
    expect(
      (await call("POST", "/services", { id: "a", name: "A" })).status,
    ).toBe(201);
    expect(alerts.map((alert) => [alert.kind, alert.detail.sink])).toEqual([
      ["checkpoint.sinkFailed", "siem"],
    ]);
    expect(written).toEqual([]);
    down = false;
    expect(
      (await call("POST", "/services", { id: "b", name: "B" })).status,
    ).toBe(201);
    expect(written).toEqual([2, 4]);
  });

  it("a file sink appends one line per checkpoint and reads them back", async () => {
    const path = join(tempDir(), "checkpoints.jsonl");
    const sink = fileCheckpointSink(path);
    expect(await sink.read!()).toEqual([]);
    const checkpoint = {
      n: 1,
      hash: "a".repeat(64),
      at: 1,
      keyId: "k",
      signature: "x",
    };
    await sink.write(checkpoint);
    await sink.write({ ...checkpoint, n: 2 });
    expect((await sink.read!()).map((item) => item.n)).toEqual([1, 2]);
    expect((await Bun.file(path).text()).trim().split("\n")).toHaveLength(2);
  });
});

describe("the audit options", () => {
  const base = () => {
    const bundle = generateKeyPairSync("ed25519");
    return {
      bundle,
      options: {
        store: memoryStore(),
        authenticate: () => ({ id: "x" }),
        owners: ["x"],
        allowWithoutStepUp: true,
        signing: { keyId: "k", privateKey: bundle.privateKey },
      },
    };
  };

  it("requires an audit key of its own and an external sink (or saying none on purpose)", () => {
    const { options, bundle } = base();
    const auditKey = generateKeyPairSync("ed25519").privateKey;
    expect(() => createSecurityApi(options as never)).toThrow(
      /audit is required/,
    );
    expect(() =>
      createSecurityApi({ ...options, audit: { signing: undefined as never } }),
    ).toThrow(ConfigError);
    // The bundle key, under either name, is refused.
    expect(() =>
      createSecurityApi({
        ...options,
        audit: {
          signing: { keyId: "ak", privateKey: bundle.privateKey },
          allowNoExternalCheckpoints: true,
        },
      }),
    ).toThrow(/bundle/);
    expect(() =>
      createSecurityApi({
        ...options,
        audit: {
          signing: { keyId: "k", privateKey: auditKey },
          allowNoExternalCheckpoints: true,
        },
      }),
    ).toThrow(/bundle/);
    expect(() =>
      createSecurityApi({
        ...options,
        audit: { signing: { keyId: "ak", privateKey: auditKey } },
      }),
    ).toThrow(/sink/);
    // Negative controls: a key of its own with a sink, or with the opt-out.
    expect(() =>
      createSecurityApi({
        ...options,
        audit: {
          signing: { keyId: "ak", privateKey: auditKey },
          sinks: [callbackCheckpointSink({ write: () => {} })],
        },
      }),
    ).not.toThrow();
    expect(() =>
      createSecurityApi({
        ...options,
        audit: {
          signing: { keyId: "ak", privateKey: auditKey },
          allowNoExternalCheckpoints: true,
        },
      }),
    ).not.toThrow();
  });
});

describe("reading and exporting", () => {
  it("audit:read from analyst up; a viewer is refused", async () => {
    const { call } = testApi();
    await call("POST", "/role-bindings", {
      operator: "vera",
      role: "viewer",
      scope: "global",
    });
    await call("POST", "/role-bindings", {
      operator: "ann",
      role: "analyst",
      scope: "global",
    });
    expect((await call("GET", "/audit", undefined, "vera")).status).toBe(403);
    expect((await call("GET", "/audit/verify", undefined, "vera")).status).toBe(
      403,
    );
    expect((await call("GET", "/audit", undefined, "ann")).status).toBe(200);
    expect((await call("GET", "/audit/verify", undefined, "ann")).body.ok).toBe(
      true,
    );
    const one = (await call("GET", "/audit/1", undefined, "ann")).body;
    expect(one).toMatchObject({
      n: 1,
      phase: "intent",
      action: "roleBinding.create",
    });
    expect((await call("GET", "/audit/9999", undefined, "ann")).status).toBe(
      404,
    );
  });

  it("filters by actor, action, scope and time, a page at a time", async () => {
    const { call, clock } = testApi();
    await call("POST", "/services", { id: "a", name: "A" });
    clock.advance(1_000);
    const since = clock.now();
    await call("POST", "/services", { id: "b", name: "B" });
    await call("POST", "/role-bindings", {
      operator: "dave",
      role: "admin",
      scope: "global",
    });
    await call("POST", "/services", { id: "c", name: "C" }, "dave");
    const byScope = (await call("GET", "/audit?scope=service:b")).body.items;
    expect(byScope.map((item: { phase: string }) => item.phase).sort()).toEqual(
      ["done", "intent"],
    );
    const byActor = (await call("GET", "/audit?actor=dave")).body.items;
    expect(
      byActor.every((item: { actor: string }) => item.actor === "dave"),
    ).toBe(true);
    expect(byActor).toHaveLength(2);
    const bySince = (
      await call("GET", `/audit?since=${since}&action=service.put`)
    ).body.items;
    expect(bySince).toHaveLength(4);
    const first = (await call("GET", "/audit?limit=2")).body;
    expect(first.items).toHaveLength(2);
    const second = (
      await call(
        "GET",
        `/audit?limit=2&cursor=${encodeURIComponent(first.next)}`,
      )
    ).body;
    expect(second.items[0].n).toBe(first.items[1].n - 1);
    expect((await call("GET", "/audit?cursor=bogus")).status).toBe(400);
  });

  it("exports JSON Lines to an admin with a step-up, and records the export", async () => {
    let fresh = true;
    const { call } = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
    });
    await call("POST", "/services", { id: "a", name: "A" });
    expect(
      (
        await call("POST", "/role-bindings", {
          operator: "ann",
          role: "analyst",
          scope: "global",
        })
      ).status,
    ).toBe(201);
    fresh = false;
    expect((await call("GET", "/audit/export", undefined, "ann")).status).toBe(
      403,
    );
    const asked = await call("GET", "/audit/export");
    expect([asked.status, asked.body.code]).toEqual([401, "step_up_required"]);
    fresh = true;
    const exported = await call("GET", "/audit/export");
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const lines = String(exported.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ n: 1, prevHash: "0".repeat(64) });
    expect(lines.at(-1)).toMatchObject({
      action: "audit.export",
      entry: { phase: "event", stepUp: true },
    });
  });
});

describe("refusals", () => {
  it("records a signed-in operator refused for a permission or a step-up, with the permission and target", async () => {
    let fresh = true;
    const { call } = testApi({
      allowWithoutStepUp: undefined,
      stepUp: { verify: () => fresh, challenge: () => "/mfa" },
    });
    await call("POST", "/role-bindings", {
      operator: "vera",
      role: "viewer",
      scope: "global",
    });
    fresh = false;
    expect(
      (await call("DELETE", "/services/checkout?revision=1", undefined, "vera"))
        .status,
    ).toBe(403);
    await call("PUT", "/policies/global/draft", { policy: {}, revision: null });
    expect(
      (await call("POST", "/policies/global/publish", { expectedHead: null }))
        .status,
    ).toBe(401);
    const refused = (
      await call("GET", "/audit?action=access.refused&direction=asc")
    ).body.items;
    expect(refused).toHaveLength(2);
    expect(refused[0]).toMatchObject({
      actor: "vera",
      scope: "service:checkout",
      phase: "event",
    });
    expect(refused[0].entry).toMatchObject({
      outcome: "refused",
      reason: "forbidden",
      permission: "services:write",
      route: "DELETE /services/:id",
      target: { id: "checkout" },
    });
    expect(refused[1]).toMatchObject({ actor: "alice" });
    expect(refused[1].entry).toMatchObject({
      outcome: "refused",
      reason: "step_up_required",
      stepUp: false,
    });
  });

  it("keeps unauthenticated and cross-site requests out of the chain, in the log only", async () => {
    const { logger, events } = createTestLogger();
    const { call, store } = testApi({ logger });
    await call("POST", "/services", { id: "blog", name: "Blog" });
    const before = (await store.getAuditHead())!.n;
    // Nobody signed in, many times over.
    for (let i = 0; i < 5; i++) {
      expect(
        (await call("POST", "/services", { id: `x${i}`, name: "X" }, null))
          .status,
      ).toBe(401);
      expect((await call("GET", "/audit", undefined, null)).status).toBe(401);
    }
    // Signed in, but cross-site (a forged request).
    const crossSite = await call(
      "POST",
      "/services",
      { id: "y", name: "Y" },
      "alice",
      { cookie: "sid=1", "sec-fetch-site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
    expect((await store.getAuditHead())!.n).toBe(before);
    const lines = events.filter((event) =>
      event.message.startsWith("bun-security api: refused"),
    );
    expect(
      lines.filter((event) => event.message.includes("unauthenticated")),
    ).toHaveLength(10);
    expect(
      lines.filter((event) => event.message.includes("cross-site")),
    ).toHaveLength(1);
    // Negative control: the same request signed in and refused for a permission does reach it.
    await call("POST", "/role-bindings", {
      operator: "vera",
      role: "viewer",
      scope: "global",
    });
    const after = (await store.getAuditHead())!.n;
    expect(
      (await call("POST", "/services", { id: "z", name: "Z" }, "vera")).status,
    ).toBe(403);
    expect((await store.getAuditHead())!.n).toBe(after + 1);
  });
});

describe("the scope filter", () => {
  it("a group's reader sees its child groups' and services' entries, never a sibling's", async () => {
    const { call } = testApi();
    await call("POST", "/groups", { id: "a", name: "A" });
    await call("POST", "/groups", { id: "a1", name: "A1", parent: "a" });
    await call("POST", "/groups", { id: "b", name: "B" });
    await call("POST", "/services", { id: "sa", name: "SA", groups: ["a"] });
    await call("POST", "/services", { id: "sa1", name: "SA1", groups: ["a1"] });
    await call("POST", "/services", { id: "sb", name: "SB", groups: ["b"] });
    await call("POST", "/role-bindings", {
      operator: "ann",
      role: "analyst",
      scope: "group:a",
    });
    const scopes = async (query: string, op = "ann") => {
      const answer = await call(
        "GET",
        `/audit?limit=200${query}`,
        undefined,
        op,
      );
      expect(answer.status).toBe(200);
      return [
        ...new Set(
          answer.body.items.map((item: { scope: string }) => item.scope),
        ),
      ].sort();
    };
    expect(await scopes("&scope=group:a")).toEqual([
      "group:a",
      "group:a1",
      "service:sa",
      "service:sa1",
    ]);
    expect(await scopes("&scope=group:a1")).toEqual([
      "group:a1",
      "service:sa1",
    ]);
    expect(await scopes("&scope=service:sa1")).toEqual(["service:sa1"]);
    // A sibling group, or everything: refused.
    expect(
      (await call("GET", "/audit?scope=group:b", undefined, "ann")).status,
    ).toBe(403);
    expect((await call("GET", "/audit", undefined, "ann")).status).toBe(403);
    // Negative control: a global reader asking for group b sees b's entries, and only them.
    expect(await scopes("&scope=group:b", "alice")).toEqual([
      "group:b",
      "service:sb",
    ]);
  });
});

describe("retention", () => {
  it("purges only up to a checkpoint older than the cut, audits it, and the rest still verifies", async () => {
    const { api, call, clock } = testApi({
      audit: {
        signing: {
          keyId: "ak_1",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        checkpointEvery: 4,
        allowNoExternalCheckpoints: true,
      },
    });
    for (const id of ["a", "b", "c"])
      await call("POST", "/services", { id, name: id });
    // Entries 1–6; a checkpoint at 4.
    clock.advance(500 * 24 * 3_600_000);
    const cut = clock.now();
    await call("POST", "/services", { id: "d", name: "d" });
    const deleted = await api.purgeAudit({ before: cut });
    expect(deleted).toBe(4);
    const verified = await api.verifyAudit();
    expect(verified).toMatchObject({ ok: true, first: 5 });
    const purge = (await call("GET", "/audit?action=audit.purge")).body.items;
    expect(purge.map((item: { phase: string }) => item.phase).sort()).toEqual([
      "done",
      "intent",
    ]);
    expect(
      purge.find((item: { phase: string }) => item.phase === "done").entry,
    ).toMatchObject({ deleted: 4, actor: { kind: "system" } });
    // Nothing to purge without an older checkpoint.
    expect(await api.purgeAudit({ before: 0 })).toBe(0);
  });

  it("negative control: entries deleted past the last checkpoint leave the oldest kept one unanchored", async () => {
    const { api, call, store } = testApi({
      audit: {
        signing: {
          keyId: "ak_1",
          privateKey: generateKeyPairSync("ed25519").privateKey,
        },
        checkpointEvery: 4,
        allowNoExternalCheckpoints: true,
      },
    });
    for (const id of ["a", "b", "c"])
      await call("POST", "/services", { id, name: id });
    await store.deleteAuditBefore(6, 100);
    const verified = await api.verifyAudit();
    expect(verified.problems[0]).toMatchObject({ n: 6, reason: "anchor" });
  });
});
