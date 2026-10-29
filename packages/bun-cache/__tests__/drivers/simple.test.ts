/**
 * The conformance kit's second proof: `fromSimpleDriver` over a plain Map —
 * the `tags: "stamps"` path, and the kit's capability gating (increment,
 * lock, bus and sweep are visibly skipped).
 */
import type { StoredEntry } from "../../lib/index";
import { fromSimpleDriver } from "../../lib/index";
import { runCacheDriverConformance } from "../../lib/testing/index";

await runCacheDriverConformance("fromSimpleDriver over a Map", () => {
  const map = new Map<string, StoredEntry>();
  const driver = fromSimpleDriver({
    name: "map",
    get: (ns, key) => {
      const entry = map.get(`${ns}\n${key}`);
      // Lazy expiry, as the kit's expiry case expects.
      if (
        entry !== undefined &&
        entry.expiresAt !== null &&
        entry.expiresAt <= Date.now()
      ) {
        map.delete(`${ns}\n${key}`);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(entry);
    },
    set: (ns, entry) => {
      map.set(`${ns}\n${entry.key}`, entry);
      return Promise.resolve();
    },
    delete: (ns, key) => Promise.resolve(map.delete(`${ns}\n${key}`)),
    clear: (ns) => {
      for (const key of [...map.keys()]) {
        if (key.startsWith(`${ns}\n`)) {
          map.delete(key);
        }
      }
      return Promise.resolve();
    },
  });
  return {
    driver,
    // The Map is the whole store: its keys, and each entry's bytes and tags.
    rawDump: () =>
      [...map].flatMap(([key, entry]) => [key, entry.value, ...entry.tags]),
  };
});
