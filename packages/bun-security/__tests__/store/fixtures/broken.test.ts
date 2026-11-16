/**
 * Broken stores for the kit's negative controls (`kit-controls.test.ts`),
 * which runs this file in a child `bun test` with `BUN_SECURITY_KIT_BROKEN`
 * naming the fault. Without it, the file registers one skipped test.
 */
import type { SecurityStoreDriver } from "../../../lib/store/index";
import process from "node:process";
import { test } from "bun:test";
import { memoryStore } from "../../../lib/store/index";
import { runSecurityStoreConformance } from "../../../lib/testing/index";

const fault = process.env.BUN_SECURITY_KIT_BROKEN;

/** A memory store with one fault planted. */
function broken(): SecurityStoreDriver {
  const store = memoryStore();
  switch (fault) {
    case "lost-update":
      // Ignores the revision named: writes over whatever is there, so every
      // writer "wins" and all but the last write are lost.
      return {
        ...store,
        put: async (kind, id, doc) => {
          for (;;) {
            const current = await store.get(kind, id);
            const result = await store.put(
              kind,
              id,
              doc,
              current?.revision ?? null,
            );
            if (result.ok) return result;
          }
        },
      };
    case "forked-head":
      // Ignores the head named: appends after whatever head is there.
      return {
        ...store,
        appendVersion: async (policyId, version) => {
          for (;;) {
            const head = await store.get("policy", policyId);
            const result = await store.appendVersion(
              policyId,
              version,
              head === undefined ? null : (head.doc as { head: string }).head,
            );
            if (result.ok || (await store.getVersion(policyId, version.id))) {
              return result;
            }
          }
        },
      };
    case "silent-delete":
      // Deletes without a change row: the feed misses it.
      return {
        ...store,
        changesSince: async (seq, limit) => {
          const read = await store.changesSince(seq, limit);
          return { ...read, changes: read.changes.filter((c) => !c.deleted) };
        },
      };
    case "unbound-cursor":
      // Takes any cursor for any walk.
      return {
        ...store,
        list: async (kind, query) =>
          await store.list(kind, { ...query, cursor: undefined }),
      };
    case "untested-multiprocess":
      return {
        ...store,
        capabilities: { ...store.capabilities, multiProcess: true },
      };
    default:
      return store;
  }
}

if (fault === undefined) {
  test.skip("a broken store for kit-controls.test.ts", () => {});
} else {
  await runSecurityStoreConformance(`broken: ${fault}`, () => ({
    store: broken(),
  }));
}
