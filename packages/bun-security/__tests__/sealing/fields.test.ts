/**
 * `sealedFields` and `resealStore` (storage.md §8, PR-D3) over SQLite and
 * Postgres: the default secrets sealed field by field, a sealed value
 * copied to another row, field, kind or version refused, tampering and
 * planted plain values refused, rotation (old keys read, the first key
 * writes, `resealStore` moves the rest), a wrong key refused, and the field
 * map's validation. The negative control: without the codec, the same
 * secrets sit in the SQLite file as plain text.
 */
import type { CacheKeyRing } from "@kingsleyweb/bun-cache/encryption";
import type { SealedFieldPaths } from "../../lib/sealing/index";
import type { SecurityStoreDriver, StoreCodec } from "../../lib/store/index";
import { SQL } from "bun";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { fieldKeyId } from "@kingsleyweb/bun-cache/encryption";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  DEFAULT_SEALED_FIELDS,
  resealStore,
  SEALED_MARKER,
  SealedFieldError,
  sealedFields,
} from "../../lib/sealing/index";
import { postgresStore, sqliteStore, storeTables } from "../../lib/store/index";
import {
  dropStore,
  freshPrefix,
  POSTGRES_URL,
  postgresAvailable,
} from "../store/pgBackend";

const dir = mkdtempSync(join(tmpdir(), "bun-security-sealing-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let files = 0;

const OLD = { id: "2026-10", key: new Uint8Array(32).fill(3) };
const NEW = { id: "2026-11", key: new Uint8Array(32).fill(4) };

/** The secrets the cases store, each findable in a dump. */
const AGENT_SECRET = "AGENT-SECRET-4f1c";
const HOOK_URL = "https://hooks.example.com/services/T0/HOOK-SECRET-9a2e";
const CHANNEL_SECRET = "CHANNEL-SECRET-77b0";
const TOTP_SEED = "TOTP-SECRET-JBSWY3DP";

/** One backend: stores over the same tables, and raw access to them. */
interface Backend {
  /** A store over the backend's tables, with `codec`. */
  readonly store: (codec?: StoreCodec) => SecurityStoreDriver;
  /** Every stored row of the three tables, as text. */
  readonly dump: () => Promise<string>;
  /** A document's stored body, parsed. */
  readonly doc: (kind: string, id: string) => Promise<Record<string, unknown>>;
  /** Writes a document's stored body by hand. */
  readonly setDoc: (kind: string, id: string, body: unknown) => Promise<void>;
  /** Copies a document's row to another kind and id by hand. */
  readonly copyDoc: (
    from: readonly [string, string],
    to: readonly [string, string],
  ) => Promise<void>;
  /** Writes one version's stored policy over another's by hand. */
  readonly copyPolicy: (
    policyId: string,
    from: string,
    to: string,
  ) => Promise<void>;
  /** Drops the tables or files. */
  readonly cleanup: () => Promise<void>;
}

/** A SQLite file of its own. */
function sqliteBackend(): Backend & { readonly path: string } {
  files += 1;
  const path = join(dir, `store-${files}.sqlite`);
  const tables = storeTables("bun_security_");
  const raw = async <T>(run: (sql: SQL) => Promise<T>): Promise<T> => {
    const sql = new SQL({ url: `sqlite://${path}` });
    try {
      return await run(sql);
    } finally {
      await sql.close();
    }
  };
  return {
    path,
    store: (codec) => sqliteStore({ path, codec }),
    dump: () =>
      raw(async (sql) =>
        JSON.stringify([
          ...(await sql.unsafe(`SELECT * FROM ${tables.docs}`)),
          ...(await sql.unsafe(`SELECT * FROM ${tables.versions}`)),
          ...(await sql.unsafe(`SELECT * FROM ${tables.bundles}`)),
        ]),
      ),
    doc: (kind, id) =>
      raw(async (sql) => {
        const rows: { doc: string }[] = await sql.unsafe<{ doc: string }[]>(
          `SELECT doc FROM ${tables.docs} WHERE kind = ? AND id = ?`,
          [kind, id],
        );
        return JSON.parse(rows[0].doc) as Record<string, unknown>;
      }),
    setDoc: (kind, id, body) =>
      raw(async (sql) => {
        await sql.unsafe(
          `UPDATE ${tables.docs} SET doc = ? WHERE kind = ? AND id = ?`,
          [JSON.stringify(body), kind, id],
        );
      }),
    copyDoc: (from, to) =>
      raw(async (sql) => {
        await sql.unsafe(
          `INSERT INTO ${tables.docs} (kind, id, revision, doc, updated_at) SELECT ?, ?, revision, doc, updated_at FROM ${tables.docs} WHERE kind = ? AND id = ?`,
          [to[0], to[1], from[0], from[1]],
        );
      }),
    copyPolicy: (policyId, from, to) =>
      raw(async (sql) => {
        await sql.unsafe(
          `UPDATE ${tables.versions} SET policy = (SELECT policy FROM ${tables.versions} WHERE policy_id = ? AND id = ?) WHERE policy_id = ? AND id = ?`,
          [policyId, from, policyId, to],
        );
      }),
    cleanup: async () => {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    },
  };
}

/** Postgres tables of their own. */
function postgresBackend(): Backend {
  const prefix = freshPrefix();
  const tables = storeTables(prefix);
  const raw = async <T>(run: (sql: SQL) => Promise<T>): Promise<T> => {
    const sql = new SQL(POSTGRES_URL!);
    try {
      return await run(sql);
    } finally {
      await sql.close();
    }
  };
  return {
    store: (codec) =>
      postgresStore({ url: POSTGRES_URL!, prefix, max: 2, codec }),
    dump: () =>
      raw(async (sql) =>
        JSON.stringify([
          ...(await sql.unsafe(
            `SELECT kind, id, doc::text FROM ${tables.docs}`,
          )),
          ...(await sql.unsafe(
            `SELECT policy_id, id, policy::text FROM ${tables.versions}`,
          )),
          ...(await sql.unsafe(
            `SELECT service_id, bundle::text FROM ${tables.bundles}`,
          )),
        ]),
      ),
    doc: (kind, id) =>
      raw(async (sql) => {
        const rows: { doc: string }[] = await sql.unsafe<{ doc: string }[]>(
          `SELECT doc::text AS doc FROM ${tables.docs} WHERE kind = $1 AND id = $2`,
          [kind, id],
        );
        // Stored as bun-sql writes it: a JSON string holding the body.
        const parsed = JSON.parse(rows[0].doc) as unknown;
        return (
          typeof parsed === "string" ? JSON.parse(parsed) : parsed
        ) as Record<string, unknown>;
      }),
    setDoc: (kind, id, body) =>
      raw(async (sql) => {
        await sql.unsafe(
          `UPDATE ${tables.docs} SET doc = $1 WHERE kind = $2 AND id = $3`,
          [JSON.stringify(body), kind, id],
        );
      }),
    copyDoc: (from, to) =>
      raw(async (sql) => {
        await sql.unsafe(
          `INSERT INTO ${tables.docs} (kind, id, revision, doc, updated_at) SELECT $1, $2, revision, doc, updated_at FROM ${tables.docs} WHERE kind = $3 AND id = $4`,
          [to[0], to[1], from[0], from[1]],
        );
      }),
    copyPolicy: (policyId, from, to) =>
      raw(async (sql) => {
        await sql.unsafe(
          `UPDATE ${tables.versions} SET policy = (SELECT policy FROM ${tables.versions} WHERE policy_id = $1 AND id = $2) WHERE policy_id = $1 AND id = $3`,
          [policyId, from, to],
        );
      }),
    cleanup: () => dropStore(prefix),
  };
}

/** Runs `run` on a fresh backend, closing every store it opened and dropping the tables. */
async function withBackend(
  make: () => Backend,
  run: (
    backend: Backend,
    open: (codec?: StoreCodec) => SecurityStoreDriver,
  ) => Promise<void>,
): Promise<void> {
  const backend = make();
  const opened: SecurityStoreDriver[] = [];
  try {
    await run(backend, (codec) => {
      const store = backend.store(codec);
      opened.push(store);
      return store;
    });
  } finally {
    for (const store of opened) await store.close();
    await backend.cleanup();
  }
}

/** What `run` rejected with, as a {@link SealedFieldError}. */
async function refusal(run: () => Promise<unknown>): Promise<SealedFieldError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SealedFieldError) return error;
    throw error;
  }
  throw new Error("expected a SealedFieldError, and the read succeeded");
}

/** The key id a stored marker's envelope names. */
function markerKeyId(value: unknown): string | undefined {
  const text = (value as Record<string, string>)[SEALED_MARKER];
  return fieldKeyId(Buffer.from(text, "base64url"));
}

/** The default secrets, stored. */
async function putSecrets(store: SecurityStoreDriver): Promise<void> {
  await store.put(
    "agentKey",
    "k1",
    { serviceId: "svc-pay", secret: AGENT_SECRET },
    null,
  );
  await store.put(
    "alertChannel",
    "c1",
    {
      name: "ops-room",
      type: "webhook",
      url: HOOK_URL,
      secret: CHANNEL_SECRET,
    },
    null,
  );
  await store.put("operator", "u1", { name: "ada", totpSeed: TOTP_SEED }, null);
  await store.put(
    "serviceIdentity",
    "pay-api",
    { verifier: `sha256:${"a".repeat(64)}`, forwardsClientIp: true },
    null,
  );
  await store.appendVersion(
    "global",
    { id: "v1", policy: { mode: "enforce", note: "POLICY-TEXT" } },
    null,
  );
}

function cases(name: string, make: () => Backend): void {
  describe(`sealedFields over ${name}`, () => {
    it("seals the default secrets field by field, and leaves the rest readable at rest", async () => {
      await withBackend(make, async (backend, open) => {
        const store = open(sealedFields({ keys: [NEW] }));
        await putSecrets(store);
        expect((await store.get("agentKey", "k1"))?.doc).toEqual({
          serviceId: "svc-pay",
          secret: AGENT_SECRET,
        });
        expect((await store.get("alertChannel", "c1"))?.doc).toEqual({
          name: "ops-room",
          type: "webhook",
          url: HOOK_URL,
          secret: CHANNEL_SECRET,
        });
        expect(
          (await store.list("operator", { limit: 5 })).items[0]?.doc,
        ).toEqual({
          name: "ada",
          totpSeed: TOTP_SEED,
        });
        const dump = await backend.dump();
        for (const secret of [
          AGENT_SECRET,
          "HOOK-SECRET",
          CHANNEL_SECRET,
          TOTP_SEED,
        ]) {
          expect(dump).not.toContain(secret);
        }
        // Field-level: every other field, the verifier and the policy stay as they were.
        for (const plain of [
          "svc-pay",
          "ops-room",
          "ada",
          "POLICY-TEXT",
          "aaaaaaaa",
        ]) {
          expect(dump).toContain(plain);
        }
        const stored = await backend.doc("agentKey", "k1");
        expect(stored.serviceId).toBe("svc-pay");
        expect(Object.keys(stored.secret as object)).toEqual([SEALED_MARKER]);
        expect(markerKeyId(stored.secret)).toBe("2026-11");
      });
    });

    it("a sealed value copied to another row, field, kind or version does not open there", async () => {
      await withBackend(make, async (backend, open) => {
        const codec = sealedFields({
          keys: [NEW],
          fields: { ...DEFAULT_SEALED_FIELDS, policy: ["note"] },
        });
        const store = open(codec);
        await putSecrets(store);
        // Another row.
        await backend.copyDoc(["agentKey", "k1"], ["agentKey", "k2"]);
        const row = await refusal(() => store.get("agentKey", "k2"));
        expect(row).toMatchObject({
          reason: "auth",
          kind: "agentKey",
          id: "k2",
          path: "secret",
        });
        expect(row.message).toBe(
          'sealed field "secret" of agentKey "k2" did not open (auth, key id "2026-11")',
        );
        // Another kind, the same id and field name.
        await backend.copyDoc(["agentKey", "k1"], ["serviceIdentity", "k1"]);
        expect(
          (await refusal(() => store.get("serviceIdentity", "k1"))).reason,
        ).toBe("auth");
        // Another field of the same row: the URL and the secret swapped.
        const channel = await backend.doc("alertChannel", "c1");
        await backend.setDoc("alertChannel", "c1", {
          ...channel,
          url: channel.secret,
          secret: channel.url,
        });
        expect(
          await refusal(() => store.get("alertChannel", "c1")),
        ).toMatchObject({
          reason: "auth",
          path: "url",
        });
        // Another version of the same policy.
        await store.appendVersion(
          "global",
          { id: "v2", policy: { note: "second" } },
          "v1",
        );
        await backend.copyPolicy("global", "v1", "v2");
        expect(
          await refusal(() => store.getVersion("global", "v2")),
        ).toMatchObject({
          reason: "auth",
          field: "policy",
          kind: "policy",
          id: "global",
          path: "note",
        });
        // The control: the rows left alone still open.
        expect((await store.get("agentKey", "k1"))?.doc).toMatchObject({
          secret: AGENT_SECRET,
        });
        expect((await store.getVersion("global", "v1"))?.policy).toMatchObject({
          note: "POLICY-TEXT",
        });
      });
    });

    it("tampering is refused, and so is a plain value planted in a sealed field unless acceptUnsealed", async () => {
      await withBackend(make, async (backend, open) => {
        const store = open(sealedFields({ keys: [NEW] }));
        await putSecrets(store);
        const stored = await backend.doc("agentKey", "k1");
        const text = (stored.secret as Record<string, string>)[SEALED_MARKER];
        const at = Math.floor(text.length / 2);
        const flipped = `${text.slice(0, at)}${text[at] === "A" ? "B" : "A"}${text.slice(at + 1)}`;
        await backend.setDoc("agentKey", "k1", {
          ...stored,
          secret: { [SEALED_MARKER]: flipped },
        });
        expect((await refusal(() => store.get("agentKey", "k1"))).reason).toBe(
          "auth",
        );
        await backend.setDoc("agentKey", "k1", {
          ...stored,
          secret: { [SEALED_MARKER]: "AAAA" },
        });
        expect((await refusal(() => store.get("agentKey", "k1"))).reason).toBe(
          "malformed",
        );
        await backend.setDoc("agentKey", "k1", {
          ...stored,
          secret: "planted-by-hand",
        });
        const planted = await refusal(() => store.get("agentKey", "k1"));
        expect(planted.reason).toBe("unsealed");
        expect(planted.message).not.toContain("planted-by-hand");
        // A whole page fails with the one row: nothing half-read.
        expect(
          (await refusal(() => store.list("agentKey", { limit: 10 }))).reason,
        ).toBe("unsealed");
        // With acceptUnsealed, the plain value is read as it is, and marked for resealing.
        const migrating = sealedFields({ keys: [NEW], acceptUnsealed: true });
        const lenient = open(migrating);
        const read = await lenient.get("agentKey", "k1");
        expect(read?.doc).toEqual({
          serviceId: "svc-pay",
          secret: "planted-by-hand",
        });
        expect(migrating.isStale(read!.doc)).toBe(true);
        // ...but a forged sealed value is still refused.
        await backend.setDoc("agentKey", "k1", {
          ...stored,
          secret: { [SEALED_MARKER]: flipped },
        });
        expect(
          (await refusal(() => lenient.get("agentKey", "k1"))).reason,
        ).toBe("auth");
      });
    });

    it("rotation: old values read, the first key writes, and resealStore moves the rest", async () => {
      await withBackend(make, async (backend, open) => {
        const before = open(sealedFields({ keys: [OLD] }));
        await putSecrets(before);
        await before.put("agentKey", "k2", { secret: "second" }, null);

        const codec = sealedFields({ keys: [NEW, OLD] });
        const rotated = open(codec);
        const read = await rotated.get("agentKey", "k1");
        expect(read?.doc).toEqual({
          serviceId: "svc-pay",
          secret: AGENT_SECRET,
        });
        expect(codec.isStale(read!.doc)).toBe(true);
        await rotated.put("agentKey", "k3", { secret: "third" }, null);
        expect(markerKeyId((await backend.doc("agentKey", "k3")).secret)).toBe(
          "2026-11",
        );
        expect(markerKeyId((await backend.doc("agentKey", "k1")).secret)).toBe(
          "2026-10",
        );

        // Without the old key, what it sealed no longer opens.
        const newOnly = open(sealedFields({ keys: [NEW] }));
        expect(
          await refusal(() => newOnly.get("agentKey", "k1")),
        ).toMatchObject({
          reason: "unknown-key",
          keyId: "2026-10",
        });

        // A writer racing the job: its write wins, and the job counts a conflict.
        const racing: SecurityStoreDriver = {
          ...rotated,
          list: async (kind, query) => {
            const page = await rotated.list(kind, query);
            if (kind === "agentKey") {
              const k2 = await rotated.get("agentKey", "k2");
              await rotated.put("agentKey", "k2", k2!.doc, k2!.revision);
            }
            return page;
          },
        };
        const result = await resealStore(racing, codec);
        // agentKey k1, k2, k3; alertChannel c1; operator u1; serviceIdentity pay-api.
        expect(result).toEqual({ scanned: 6, resealed: 3, conflicts: 1 });
        for (const [kind, id, field] of [
          ["agentKey", "k1", "secret"],
          ["agentKey", "k2", "secret"],
          ["alertChannel", "c1", "url"],
          ["alertChannel", "c1", "secret"],
          ["operator", "u1", "totpSeed"],
        ] as const) {
          expect(markerKeyId((await backend.doc(kind, id))[field])).toBe(
            "2026-11",
          );
        }
        expect((await newOnly.get("agentKey", "k1"))?.doc).toEqual({
          serviceId: "svc-pay",
          secret: AGENT_SECRET,
        });
        // A second pass finds nothing stale.
        expect(await resealStore(rotated, codec)).toEqual({
          scanned: 6,
          resealed: 0,
          conflicts: 0,
        });
      });
    });

    it("a wrong key is refused: another key under the same id, or an id the ring lacks", async () => {
      await withBackend(make, async (_backend, open) => {
        await putSecrets(open(sealedFields({ keys: [NEW] })));
        const sameId = open(
          sealedFields({
            keys: [{ id: NEW.id, key: new Uint8Array(32).fill(9) }],
          }),
        );
        expect(await refusal(() => sameId.get("operator", "u1"))).toMatchObject(
          {
            reason: "auth",
            keyId: "2026-11",
            path: "totpSeed",
          },
        );
        const otherId = open(sealedFields({ keys: [OLD] }));
        expect(
          (await refusal(() => otherId.get("operator", "u1"))).reason,
        ).toBe("unknown-key");
        // A document with no sealed field opens under any ring.
        expect(
          (await otherId.get("serviceIdentity", "pay-api"))?.doc,
        ).toMatchObject({
          forwardsClientIp: true,
        });
      });
    });

    it("binds each array element to its index, and never changes the caller's body", async () => {
      await withBackend(make, async (backend, open) => {
        const fields: SealedFieldPaths = {
          doc: { alertChannel: ["targets.*.secret"] },
        };
        const store = open(sealedFields({ keys: [NEW], fields }));
        const body = {
          targets: [
            { name: "a", secret: "S-ONE" },
            { name: "b", secret: "S-TWO" },
            { name: "c" },
          ],
        };
        const copy = structuredClone(body);
        await store.put("alertChannel", "c1", body, null);
        expect(body).toEqual(copy);
        expect((await store.get("alertChannel", "c1"))?.doc).toEqual(copy);
        const stored = await backend.doc("alertChannel", "c1");
        expect(JSON.stringify(stored)).not.toContain("S-ONE");
        const targets = stored.targets as Record<string, unknown>[];
        expect(targets[2]).toEqual({ name: "c" });
        await backend.setDoc("alertChannel", "c1", {
          targets: [
            { ...targets[0], secret: targets[1].secret },
            { ...targets[1], secret: targets[0].secret },
            targets[2],
          ],
        });
        expect(
          await refusal(() => store.get("alertChannel", "c1")),
        ).toMatchObject({
          reason: "auth",
          path: "targets.0.secret",
        });
      });
    });
  });
}

cases("sqlite", sqliteBackend);
if (await postgresAvailable()) cases("postgres", postgresBackend);

describe("the SQLite file", () => {
  /** Every byte the store left on disk: the database, its WAL and shared memory. */
  const onDisk = (path: string): string =>
    ["", "-wal", "-shm"]
      .map((suffix) => `${path}${suffix}`)
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file).toString("latin1"))
      .join("");

  it("holds no secret in any byte with the codec", async () => {
    const backend = sqliteBackend();
    const store = backend.store(sealedFields({ keys: [NEW] }));
    try {
      await putSecrets(store);
      const disk = onDisk(backend.path);
      for (const secret of [
        AGENT_SECRET,
        "HOOK-SECRET",
        CHANNEL_SECRET,
        TOTP_SEED,
      ]) {
        expect(disk).not.toContain(secret);
      }
      expect(disk).toContain("svc-pay");
    } finally {
      await store.close();
      await backend.cleanup();
    }
  });

  it("negative control: without the codec, every secret is plain text in the file", async () => {
    const backend = sqliteBackend();
    const store = backend.store();
    try {
      await putSecrets(store);
      const disk = onDisk(backend.path);
      for (const secret of [
        AGENT_SECRET,
        "HOOK-SECRET",
        CHANNEL_SECRET,
        TOTP_SEED,
      ]) {
        expect(disk).toContain(secret);
      }
    } finally {
      await store.close();
      await backend.cleanup();
    }
  });
});

describe("validation", () => {
  const configError = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    throw new Error("expected a ConfigError");
  };

  it("refuses a malformed ring without showing a key", () => {
    const passphrase = "correct horse battery staple";
    for (const keys of [
      [],
      [{ id: "has space", key: NEW.key }],
      [{ id: "a", key: passphrase }],
      [NEW, NEW],
    ] as CacheKeyRing[]) {
      expect(configError(() => sealedFields({ keys }))).not.toContain(
        passphrase,
      );
    }
    expect(
      configError(() => sealedFields({ keys: [{ id: "a", key: passphrase }] })),
    ).toStartWith("sealedFields(): keys: ");
  });

  it("refuses a malformed field map", () => {
    const bad: unknown[] = [
      null,
      [],
      { docs: {} },
      { doc: { nope: ["secret"] } },
      { doc: { agentKey: "secret" } },
      { doc: { agentKey: [""] } },
      { doc: { agentKey: ["a..b"] } },
      { doc: { agentKey: [`secret.${SEALED_MARKER}`] } },
      { doc: { agentKey: ["a", "a.b"] } },
      { doc: { agentKey: ["*.x", "y.x"] } },
      { doc: { agentKey: ["a", "a"] } },
      { policy: [42] },
    ];
    for (const fields of bad) {
      configError(() =>
        sealedFields({ keys: [NEW], fields: fields as SealedFieldPaths }),
      );
    }
    expect(
      configError(() =>
        sealedFields({
          keys: [NEW],
          fields: { doc: { agentKey: ["a", "a.b"] } },
        }),
      ),
    ).toContain('"a" and "a.b" overlap');
    // The controls: siblings and disjoint wildcards are fine.
    sealedFields({
      keys: [NEW],
      fields: { doc: { agentKey: ["a.b", "a.c", "*.d"] } },
    });
    sealedFields({ keys: [NEW], fields: {} });
  });

  it("refuses a malformed acceptUnsealed and page size", async () => {
    configError(() =>
      sealedFields({
        keys: [NEW],
        acceptUnsealed: "yes" as unknown as boolean,
      }),
    );
    const codec = sealedFields({ keys: [NEW] });
    const store = sqliteStore({ path: ":memory:", codec });
    try {
      await expect(
        resealStore(store, codec, { pageSize: 0 }),
      ).rejects.toBeInstanceOf(ConfigError);
    } finally {
      await store.close();
    }
  });

  it("names the defaults storage.md §8 asks for, and seals no policy or bundle", () => {
    expect(DEFAULT_SEALED_FIELDS).toEqual({
      doc: {
        agentKey: ["secret", "previous.secret"],
        serviceIdentity: ["secret"],
        alertChannel: ["url", "secret"],
        operator: ["totpSeed"],
      },
    });
  });
});
