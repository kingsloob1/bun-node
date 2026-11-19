/**
 * The store's secrets sealed at rest (`./sealing`, storage.md §8): an alert
 * channel's webhook URL and signing secret, sealed field by field in a SQLite
 * store, opened only with the key ring, bound to their row, and moved onto a
 * new key with `resealStore`.
 *
 * ```bash
 * bun 14-shared-store/sealing.ts
 * ```
 *
 * - `sealedFields({ keys })` is a `StoreCodec`: `sqliteStore({ codec })` and
 *   `postgresStore({ codec })` seal the fields it names on the way in and
 *   open them on the way out. The default fields are the secrets the control
 *   plane keeps (agent keys, alert channels, the break-glass seed).
 * - The ring's first key seals; every key opens what it sealed. Keys come
 *   from the environment or a secret manager, never from the store.
 * - A wrong key, an unknown key id, or a sealed value copied to another row
 *   is refused with a `SealedFieldError` naming the place and the reason,
 *   never the value.
 * - The files are temporary ones, deleted at the end; the keys are fixed
 *   bytes, for the example only.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resealStore,
  SEALED_MARKER,
  SealedFieldError,
  sealedFields,
} from "@kingsleyweb/bun-security/sealing";
import { sqliteStore, storeTables } from "@kingsleyweb/bun-security/store";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("secrets sealed at rest");

/** Two keys of 32 bytes: last month's and this month's. */
const OCTOBER = { id: "2026-10", key: new Uint8Array(32).fill(7) };
const NOVEMBER = { id: "2026-11", key: new Uint8Array(32).fill(9) };

/** The channel's secrets: findable in a file only if they were not sealed. */
const HOOK_URL = "https://hooks.example.com/services/T0/HOOK-SECRET-9a2e";
const SIGNING_SECRET = "SIGNING-SECRET-77b0";
const channel = {
  name: "on-call",
  kind: "webhook",
  url: HOOK_URL,
  secret: SIGNING_SECRET,
};
const billing = { ...channel, name: "billing", secret: "OTHER-SECRET-11d4" };

const dir = mkdtempSync(join(tmpdir(), "bun-security-example-"));
const docs = storeTables("bun_security_").docs;

/** Everything in a file's documents table, as text. */
function fileText(path: string): string {
  const db = new Database(path, { readonly: true });
  try {
    return JSON.stringify(db.query(`SELECT * FROM ${docs}`).all());
  } finally {
    db.close();
  }
}

/** Whether a file's documents hold either of the channel's secrets. */
function holdsSecrets(path: string): boolean {
  const text = fileText(path);
  return text.includes(HOOK_URL) || text.includes(SIGNING_SECRET);
}

/** What a read did: `"opened"`, or the `SealedFieldError`'s reason. */
async function readOutcome(read: () => Promise<unknown>): Promise<string> {
  try {
    await read();
    return "opened";
  } catch (error) {
    return error instanceof SealedFieldError ? error.reason : String(error);
  }
}

/** Reads `id` through a store on `path` with `keys`, closing it after. */
async function readWith(
  path: string,
  keys: Parameters<typeof sealedFields>[0]["keys"],
  id: string,
): Promise<string> {
  const store = sqliteStore({ path, codec: sealedFields({ keys }) });
  try {
    return await readOutcome(() => store.get("alertChannel", id));
  } finally {
    await store.close();
  }
}

/** A store file with both channels written through `codec`. */
async function writeChannels(
  path: string,
  codec?: ReturnType<typeof sealedFields>,
): Promise<void> {
  const store = sqliteStore({ path, codec });
  await store.put("alertChannel", "on-call", channel, null);
  await store.put("alertChannel", "billing", billing, null);
  await store.close();
}

try {
  /* ------------------------------------------------------------------ */
  step("the negative control: without the codec, the secrets sit in the file");
  const plainPath = join(dir, "plain.sqlite");
  await writeChannels(plainPath);
  check(
    "the URL and the secret are readable in the file",
    holdsSecrets(plainPath),
  );

  /* ------------------------------------------------------------------ */
  step("with sealedFields, they are sealed in the file and open in the store");
  const path = join(dir, "sealed.sqlite");
  await writeChannels(path, sealedFields({ keys: [OCTOBER] }));
  check("neither secret is in the file", !holdsSecrets(path));
  check(
    `the fields are stored under ${SEALED_MARKER}`,
    fileText(path).includes(SEALED_MARKER),
  );
  const store = sqliteStore({ path, codec: sealedFields({ keys: [OCTOBER] }) });
  const opened = await store.get("alertChannel", "on-call");
  show("read back", opened?.doc);
  checkEqual("read back as written", opened?.doc, channel);
  await store.close();

  /* ------------------------------------------------------------------ */
  step("a wrong key, or no key with its id, does not open it");
  checkEqual(
    "the right id with the wrong key: auth",
    await readWith(
      path,
      [{ id: OCTOBER.id, key: new Uint8Array(32).fill(1) }],
      "on-call",
    ),
    "auth",
  );
  checkEqual(
    "a ring without the id: unknown-key",
    await readWith(path, [NOVEMBER], "on-call"),
    "unknown-key",
  );

  /* ------------------------------------------------------------------ */
  step("a sealed value copied into another row does not open there");
  // On a file of its own, so the rotation below starts from a clean one.
  const copyPath = join(dir, "copied.sqlite");
  await writeChannels(copyPath, sealedFields({ keys: [OCTOBER] }));
  const db = new Database(copyPath);
  db.run(
    `UPDATE ${docs} SET doc = (SELECT doc FROM ${docs} WHERE kind = 'alertChannel' AND id = 'on-call') WHERE kind = 'alertChannel' AND id = 'billing'`,
  );
  db.close();
  checkEqual(
    "on-call's sealed fields under billing's id: refused",
    await readWith(copyPath, [OCTOBER], "billing"),
    "auth",
  );
  checkEqual(
    "on-call itself still opens",
    await readWith(copyPath, [OCTOBER], "on-call"),
    "opened",
  );

  /* ------------------------------------------------------------------ */
  step(
    "rotation: November seals, October still opens, resealStore moves the rest",
  );
  const rotated = sealedFields({ keys: [NOVEMBER, OCTOBER] });
  const rotating = sqliteStore({ path, codec: rotated });
  checkEqual(
    "on-call opens with the rotated ring",
    (await rotating.get("alertChannel", "on-call"))?.doc,
    channel,
  );
  const result = await resealStore(rotating, rotated);
  show("resealStore", result);
  checkEqual("both channels resealed", result.resealed, 2);
  await rotating.close();
  checkEqual(
    "November alone opens them now",
    await readWith(path, [NOVEMBER], "billing"),
    "opened",
  );
  checkEqual(
    "October alone no longer does",
    await readWith(path, [OCTOBER], "on-call"),
    "unknown-key",
  );
  check("and the file still holds neither secret", !holdsSecrets(path));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

summary();
