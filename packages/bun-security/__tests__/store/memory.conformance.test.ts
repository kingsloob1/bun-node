/** The security store kit against `memoryStore()` (storage.md §9). */
import { memoryStore } from "../../lib/store/index";
import { runSecurityStoreConformance } from "../../lib/testing/index";

await runSecurityStoreConformance("memory", () => ({ store: memoryStore() }));
