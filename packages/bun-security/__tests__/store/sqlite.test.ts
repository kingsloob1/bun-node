/**
 * `sqliteStore` beyond the kit: the codec seam storage.md §8's sealing plugs
 * into (every body sealed at rest, bound to its row), schema sync after
 * drift, the table prefix, and `:memory:`.
 */
import type { StoreCodec, StoreCodecContext } from "../../lib/store/index";
import { SQL } from "bun";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  AUDIT_GENESIS_HASH,
  DEFAULT_STORE_PREFIX,
  sqliteStore,
  storeTables,
} from "../../lib/store/index";

const dir = mkdtempSync(join(tmpdir(), "bun-security-sqlite-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let files = 0;
const fresh = (): string => join(dir, `store-${(files += 1)}.sqlite`);

/** The context a sealed body is bound to, as text. */
const bound = (context: StoreCodecContext): string =>
  `${context.field}|${context.kind}|${context.id}|${context.version ?? ""}`;

/**
 * A stand-in codec, so the seam is tested apart from `./sealing`: the
 * body's JSON reversed, base64, tagged with its context; opening under
 * another context throws.
 */
const sealing: StoreCodec = {
  seal: (body, context) =>
    `sealed:${bound(context)}:${Buffer.from([...JSON.stringify(body)].reverse().join("")).toString("base64")}`,
  open: (stored, context) => {
    const text = String(stored);
    const prefix = `sealed:${bound(context)}:`;
    if (!text.startsWith(prefix)) throw new Error("sealed for another row");
    return JSON.parse(
      [...Buffer.from(text.slice(prefix.length), "base64").toString()]
        .reverse()
        .join(""),
    ) as unknown;
  },
};

describe("sqliteStore", () => {
  it("seals every body at rest through its codec, and opens it on the way out", async () => {
    const path = fresh();
    const store = sqliteStore({ path, codec: sealing });
    try {
      await store.put("agentKey", "k1", { secret: "hunter2-SECRET" }, null);
      await store.appendVersion(
        "p",
        { id: "v1", policy: { canary: "POLICY-SECRET" } },
        null,
      );
      expect((await store.get("agentKey", "k1"))?.doc).toEqual({
        secret: "hunter2-SECRET",
      });
      expect((await store.getVersion("p", "v1"))?.policy).toEqual({
        canary: "POLICY-SECRET",
      });
      expect(
        (await store.list("agentKey", { limit: 5 })).items[0]?.doc,
      ).toEqual({
        secret: "hunter2-SECRET",
      });
      // At rest: no plaintext in any table.
      const raw = new SQL({ url: `sqlite://${path}` });
      const { docs, versions } = storeTables("bun_security_");
      const rows = JSON.stringify([
        ...(await raw.unsafe(`SELECT * FROM ${docs}`)),
        ...(await raw.unsafe(`SELECT * FROM ${versions}`)),
      ]);
      expect(rows).not.toContain("SECRET");
      expect(rows).toContain("sealed:doc|agentKey|k1|");
      // A sealed body copied to another row does not open there.
      await raw.unsafe(
        `INSERT INTO ${docs} (kind, id, revision, doc, updated_at) SELECT kind, 'k2', revision, doc, updated_at FROM ${docs} WHERE id = 'k1'`,
      );
      await raw.close();
      await expect(store.get("agentKey", "k2")).rejects.toThrow(
        "sealed for another row",
      );
    } finally {
      await store.close();
    }
  });

  it("negative control: without a codec the same body is plaintext at rest", async () => {
    const path = fresh();
    const store = sqliteStore({ path });
    await store.put("agentKey", "k1", { secret: "hunter2-SECRET" }, null);
    await store.close();
    const raw = new SQL({ url: `sqlite://${path}` });
    const rows = JSON.stringify(
      await raw.unsafe(`SELECT * FROM ${storeTables("bun_security_").docs}`),
    );
    await raw.close();
    expect(rows).toContain("SECRET");
  });

  it("syncSchema reports drift as a plan, repairs it, and runs on connect when asked", async () => {
    const path = fresh();
    const first = sqliteStore({ path, prefix: "app_" });
    await first.connect();
    expect(await first.syncSchema!({ dryRun: true })).toEqual([]);
    await first.close();
    const raw = new SQL({ url: `sqlite://${path}` });
    await raw.unsafe("DROP INDEX ix_app_docs_updated");
    await raw.unsafe("CREATE INDEX ix_app_docs_retired ON app_docs (revision)");
    await raw.close();
    const second = sqliteStore({ path, prefix: "app_" });
    const plan = await second.syncSchema!({ dryRun: true });
    expect(plan.map((change) => [change.kind, change.target]).sort()).toEqual([
      ["create-index", "ix_app_docs_updated"],
      ["drop-index", "ix_app_docs_retired"],
    ]);
    await second.close();
    const third = sqliteStore({ path, prefix: "app_", syncSchema: true });
    await third.connect();
    expect(await third.syncSchema!({ dryRun: true })).toEqual([]);
    await third.close();
  });

  it("keeps two prefixes apart in one file, and refuses a prefix that is not a name", async () => {
    const path = fresh();
    const a = sqliteStore({ path, prefix: "a_" });
    const b = sqliteStore({ path, prefix: "b_" });
    await a.put("service", "s", { from: "a" }, null);
    expect(await b.get("service", "s")).toBeUndefined();
    await a.close();
    await b.close();
    expect(() => sqliteStore({ path, prefix: "x; DROP TABLE y" })).toThrow(
      ConfigError,
    );
    expect(() => sqliteStore({ path: "" })).toThrow(ConfigError);
  });

  it("works on :memory:", async () => {
    const store = sqliteStore({ path: ":memory:" });
    await store.put("group", "g", { n: 1 }, null);
    expect((await store.get("group", "g"))?.doc).toEqual({ n: 1 });
    await store.close();
  });

  it("refuses use after close", async () => {
    const store = sqliteStore({ path: fresh() });
    await store.connect();
    await store.close();
    await expect(store.get("service", "a")).rejects.toThrow("closed");
  });
});

describe("the bans table's filter columns (PR-U3)", () => {
  /** A store file whose bans table has one ban and none of the filter columns, as an earlier version left it. */
  async function oldShapeFile(): Promise<{ path: string; id: string }> {
    const path = fresh();
    const store = sqliteStore({ path, codec: sealing });
    const ban = await store.upsertBan({
      scope: "global",
      subject: { type: "ip", value: "203.0.113.50" },
      action: "ban",
      reason: "old row",
      source: "manual",
      expiresAt: null,
    });
    const audited = await store.appendAudit(
      {
        hash: "a".repeat(64),
        prevHash: AUDIT_GENESIS_HASH,
        at: 1,
        actor: "op",
        action: "ban.create",
        scope: "global",
        entry: { target: { kind: "ban", id: ban.id } },
      },
      null,
    );
    expect(audited.ok).toBe(true);
    await store.close();
    const sql = new SQL(`sqlite://${path}`);
    const { bans, audit } = storeTables(DEFAULT_STORE_PREFIX);
    await sql.unsafe(`DROP INDEX ix_${DEFAULT_STORE_PREFIX}audit_target`);
    await sql.unsafe(`ALTER TABLE ${audit} DROP COLUMN target`);
    for (const index of ["created", "expires", "subject"]) {
      await sql.unsafe(`DROP INDEX ix_${DEFAULT_STORE_PREFIX}bans_${index}`);
    }
    for (const column of [
      "kind",
      "subject",
      "source",
      "rule",
      "created_at",
      "expires_sort",
      "country",
      "asn",
    ]) {
      await sql.unsafe(`ALTER TABLE ${bans} DROP COLUMN ${column}`);
    }
    await sql.close();
    return { path, id: ban.id };
  }

  it("refuses an old bans table without syncSchema, naming the fix", async () => {
    const { path } = await oldShapeFile();
    const store = sqliteStore({ path, codec: sealing });
    let caught: unknown;
    try {
      await store.listBans({ limit: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain("syncSchema");
    await store.close();
  });

  it("syncSchema adds the columns and fills them from each row, so filters find old rows", async () => {
    const { path, id } = await oldShapeFile();
    const store = sqliteStore({ path, codec: sealing, syncSchema: true });
    const page = await store.listBans({
      limit: 10,
      kind: "ip",
      source: "manual",
      values: ["203.0.113.50"],
      sort: "expires",
    });
    expect(page.items.map((ban) => ban.id)).toEqual([id]);
    expect(
      (await store.listAudit({ limit: 10, target: `ban:${id}` })).items.map(
        (entry) => entry.action,
      ),
    ).toEqual(["ban.create"]);
    await store.close();
    // Control: a dry run changes nothing, so the table is still refused.
    const { path: other } = await oldShapeFile();
    const dry = sqliteStore({ path: other, codec: sealing });
    await dry.syncSchema!({ dryRun: true }).catch(() => undefined);
    await expect(dry.listBans({ limit: 1 })).rejects.toThrow("syncSchema");
    await dry.close();
  });
});
