/**
 * The page `persist.e2e.test.ts` loads in Chrome: query-core's
 * `persistQueryClient` over `idbPersister`, on the browser's own IndexedDB,
 * driven from the test through `window.persistTest`. Bundled for the
 * browser by the test; never imported by one.
 */
import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { dehydrate, QueryClient } from "@tanstack/query-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { idbPersister } from "../../../lib/persist";

/** The database the page persists into. */
const DATABASE = "bun-client-e2e";

/** The query every step writes or reads. */
const KEY = ["item"];

/** What of IndexedDB this page reads directly (the project has no DOM lib). */
interface RawRequest {
  result: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface RawDatabase {
  objectStoreNames: { contains: (name: string) => boolean };
  transaction: (store: string) => {
    objectStore: (name: string) => { get: (key: string) => RawRequest };
  };
  close: () => void;
}
const page = globalThis as unknown as {
  indexedDB: { open: (name: string) => RawRequest };
  persistTest: unknown;
};

/** The stored record, read with IndexedDB itself, not the persister. */
async function raw(database = DATABASE): Promise<unknown> {
  const opened = page.indexedDB.open(database);
  const db = await new Promise<RawDatabase>((resolve, reject) => {
    opened.onsuccess = () => resolve(opened.result as RawDatabase);
    opened.onerror = () => reject(new Error("open failed"));
  });
  try {
    if (!db.objectStoreNames.contains("queries")) return null;
    const request = db
      .transaction("queries")
      .objectStore("queries")
      .get("client");
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(new Error("get failed"));
    });
  } finally {
    db.close();
  }
}

/** Restores into a new QueryClient: the item's data, or `null`. */
async function restore(
  buster: string,
  maxAge?: number,
  database = DATABASE,
): Promise<unknown> {
  const queryClient = new QueryClient();
  const [stop, restored] = persistQueryClient({
    queryClient,
    persister: idbPersister({ database }),
    buster,
    ...(maxAge === undefined ? {} : { maxAge }),
  });
  await restored;
  stop();
  return queryClient.getQueryData(KEY) ?? null;
}

/** Sets the item through a persisted QueryClient; resolves once IndexedDB holds it. */
async function save(buster: string, value: unknown): Promise<boolean> {
  const queryClient = new QueryClient();
  const [stop, restored] = persistQueryClient({
    queryClient,
    persister: idbPersister({ database: DATABASE, throttleTime: 0 }),
    buster,
  });
  await restored;
  queryClient.setQueryData(KEY, value);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = (await raw()) as PersistedClient | null;
    if (
      record?.buster === buster &&
      JSON.stringify(record.clientState.queries[0]?.state.data) ===
        JSON.stringify(value)
    ) {
      stop();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop();
  return false;
}

/** Writes the item as persisted `age` ms ago, with the persister alone. */
async function saveAged(
  buster: string,
  age: number,
  value: unknown,
): Promise<void> {
  const source = new QueryClient();
  source.setQueryData(KEY, value);
  const persister = idbPersister({ database: DATABASE, throttleTime: 0 });
  persister.persistClient({
    buster,
    timestamp: Date.now() - age,
    clientState: dehydrate(source),
  });
  // The write's timer fires first; a read made after it sees it (IndexedDB
  // runs the two transactions in order), so once it answers the write is done.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await persister.restoreClient();
}

page.persistTest = { raw, restore, save, saveAged };
