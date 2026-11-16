/**
 * `policyFile(path)` (storage.md §5): a read-only store over one JSON
 * policy file — the kit's read-only cases, the version ids, and file
 * watching: a write, an editor's replace-by-rename, a revert, a file that
 * stops being JSON, and watching turned off.
 */
import type { Change, SecurityStoreDriver } from "../../lib/store/index";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError } from "@kingsleyweb/bun-common";
import { policyFile } from "../../lib/store/index";
import { runSecurityStoreConformance } from "../../lib/testing/index";

const dir = mkdtempSync(join(tmpdir(), "bun-security-policy-file-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
let files = 0;

/** A fresh policy file holding `policy`. */
function fileWith(policy: unknown): string {
  files += 1;
  const path = join(dir, `policy-${files}.json`);
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

/** The head version id and policy of the store's `default` policy. */
async function headOf(
  store: SecurityStoreDriver,
): Promise<{ id: string; policy: unknown } | undefined> {
  const head = await store.get("policy", "default");
  if (head === undefined) return undefined;
  const id = (head.doc as { head: string }).head;
  return { id, policy: (await store.getVersion("default", id))?.policy };
}

/** Waits until `check` holds, checking every 10 ms, at most 3 s. */
async function until(
  what: string,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

await runSecurityStoreConformance("policy-file", () => ({
  store: policyFile(fileWith({ service: "kit" }), { watch: false }),
}));

describe("policyFile", () => {
  it("holds the file's policy as the head version, its id the content's hash", async () => {
    const store = policyFile(fileWith({ service: "a", mode: "dryRun" }), {
      watch: false,
    });
    try {
      const head = await headOf(store);
      expect(head?.policy).toEqual({ service: "a", mode: "dryRun" });
      expect(head?.id).toMatch(/^sha256:[0-9a-f]{16}$/);
      // The same bytes are the same version, wherever they are read.
      const other = policyFile(fileWith({ service: "a", mode: "dryRun" }), {
        watch: false,
      });
      expect((await headOf(other))?.id).toBe(head!.id);
      await other.close();
      expect(store.capabilities).toMatchObject({
        readOnly: true,
        changeFeed: "push",
      });
      await expect(store.put("service", "a", {}, null)).rejects.toThrow(
        ConfigError,
      );
    } finally {
      await store.close();
    }
  });

  it("names its policy by the id option", async () => {
    const store = policyFile(fileWith({}), { id: "checkout", watch: false });
    expect(await store.get("policy", "checkout")).toBeDefined();
    expect(await store.get("policy", "default")).toBeUndefined();
    await store.close();
  });

  it("refuses a file that is missing, or is not JSON, at connect", async () => {
    await expect(
      policyFile(join(dir, "missing.json")).connect(),
    ).rejects.toThrow("could not be read");
    const path = join(dir, "broken.json");
    writeFileSync(path, "{ not json");
    await expect(policyFile(path).connect()).rejects.toThrow("is not JSON");
  });

  it("appends each new content written, and pushes the head", async () => {
    const path = fileWith({ service: "w", mode: "enforce" });
    const store = policyFile(path, { debounceMs: 20 });
    try {
      await store.connect();
      const first = await headOf(store);
      const heard: bigint[] = [];
      const stop = store.subscribe!(
        (head) => heard.push(head),
        () => undefined,
      );
      writeFileSync(path, JSON.stringify({ service: "w", mode: "dryRun" }));
      await until(
        "the new version",
        async () => (await headOf(store))?.id !== first?.id,
      );
      expect((await headOf(store))?.policy).toEqual({
        service: "w",
        mode: "dryRun",
      });
      await until("the push", async () => heard.length > 0);
      stop();
      // Written again unchanged: nothing new.
      const { head } = await store.changesSince(0n, 1);
      writeFileSync(path, JSON.stringify({ service: "w", mode: "dryRun" }));
      await Bun.sleep(150);
      expect((await store.changesSince(0n, 1)).head).toBe(head);
    } finally {
      await store.close();
    }
  });

  it("sees an editor's replace-by-rename, and a revert as a new head", async () => {
    const path = fileWith({ service: "r", mode: "enforce" });
    const store = policyFile(path, { debounceMs: 20 });
    try {
      await store.connect();
      const first = await headOf(store);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify({ service: "r", mode: "off" }));
      renameSync(temporary, path);
      await until(
        "the renamed file",
        async () => (await headOf(store))?.id !== first?.id,
      );
      writeFileSync(path, JSON.stringify({ service: "r", mode: "enforce" }));
      await until(
        "the revert",
        async () => (await headOf(store))?.id === `${first!.id}@3`,
      );
      expect((await headOf(store))?.policy).toEqual({
        service: "r",
        mode: "enforce",
      });
      const versions = await store.listVersions("default", { limit: 10 });
      expect(versions.items.map((v) => v.number)).toEqual([1, 2, 3]);
    } finally {
      await store.close();
    }
  });

  it("keeps the head when the file stops being JSON, and says why", async () => {
    const path = fileWith({ service: "j" });
    const errors: Error[] = [];
    const store = policyFile(path, {
      debounceMs: 20,
      onError: (error) => errors.push(error),
    });
    try {
      await store.connect();
      const first = await headOf(store);
      writeFileSync(path, "{ half");
      await until("the error", async () => errors.length > 0);
      expect(errors[0]?.message).toContain("could not be read as JSON");
      expect((await headOf(store))?.id).toBe(first!.id);
      // Fixed: read again.
      writeFileSync(path, JSON.stringify({ service: "j", mode: "off" }));
      await until(
        "the fix",
        async () => (await headOf(store))?.id !== first?.id,
      );
    } finally {
      await store.close();
    }
  });

  it("with watch: false, reads the file once", async () => {
    const path = fileWith({ service: "o" });
    const store = policyFile(path, { watch: false, debounceMs: 0 });
    try {
      await store.connect();
      const feed: Change[] = [...(await store.changesSince(0n, 10)).changes];
      writeFileSync(path, JSON.stringify({ service: "o", mode: "off" }));
      await Bun.sleep(150);
      expect((await store.changesSince(0n, 10)).changes).toEqual(feed);
    } finally {
      await store.close();
    }
  });

  it("stops watching on close", async () => {
    const path = fileWith({ service: "c" });
    const errors: Error[] = [];
    const store = policyFile(path, {
      debounceMs: 0,
      onError: (e) => errors.push(e),
    });
    await store.connect();
    await store.close();
    writeFileSync(path, "{ broken");
    await Bun.sleep(100);
    expect(errors).toEqual([]);
    await expect(store.connect()).rejects.toThrow("closed");
  });
});
