/**
 * `policyFile(path)` (storage.md §5): policies from a reviewed file in the
 * app's repository (GitOps), as a read-only security store. The file holds
 * one policy, as JSON; each distinct content read becomes a version of the
 * policy `options.id` (default `default`), whose id is `sha256:` and the
 * first 16 hex digits of the file's SHA-256, so the same file is the same
 * version wherever it is read. Every write is refused (a `ConfigError`):
 * the UI shows such a policy locked, "from file".
 *
 * Watching (default on): the file's directory is watched, so an editor's
 * replace-by-rename is seen as well as a write, and a change is read once
 * the file has been quiet for `debounceMs`; a new content is appended and
 * pushed to subscribers. A file that is missing or is not JSON appends
 * nothing: the version in force stays, and `onError` hears why. A JSON file
 * that is not a valid policy is appended like any other — the engine
 * refuses it when it compiles it, and keeps the policy it has.
 */
import type { FSWatcher } from "node:fs";
import type {
  PolicyHead,
  SecurityStoreCapabilities,
  SecurityStoreDriver,
} from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { memoryStore } from "./memory";
import { refuseReadOnly } from "./shared";

/** Options for {@link policyFile}. */
export interface PolicyFileOptions {
  /** The policy's id in the store. Default `default`. */
  readonly id?: string;
  /** Watch the file and append each new content. Default `true`. */
  readonly watch?: boolean;
  /** How long the file must be quiet before a change is read, in milliseconds. Default 50. */
  readonly debounceMs?: number;
  /** Hears a read that appended nothing: the file missing, unreadable or not JSON. */
  readonly onError?: (error: Error) => void;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** What a policy file can do: read-only, pushed on change, one process. */
const CAPABILITIES: SecurityStoreCapabilities = Object.freeze({
  durable: true,
  multiProcess: false,
  multiHost: false,
  transactions: true,
  changeFeed: "push",
  analytics: false,
  cidrQuery: false,
  readOnly: true,
});

/** The version id of a file's bytes. */
function versionId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

/** A read-only security store over one policy file; see the module's description. */
export function policyFile(
  path: string,
  options: PolicyFileOptions = {},
): SecurityStoreDriver {
  if (typeof path !== "string" || path.length === 0) {
    throw new ConfigError("policyFile(): path must be a file path");
  }
  const id = options.id ?? "default";
  const debounceMs = options.debounceMs ?? 50;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
    throw new ConfigError(
      "policyFile(): debounceMs must be a whole number of milliseconds",
      { debounceMs },
    );
  }
  const file = resolve(path);
  const name = `policy-file:${basename(file)}`;
  const inner = memoryStore({ name, now: options.now });
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected: Promise<void> | undefined;
  let closed = false;

  /** Hears a failed read. */
  const fail = (error: unknown): void => {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      options.onError?.(err);
    } catch {
      // The hook's own failure changes nothing.
    }
  };

  /** Reads the file; appends its content when new. Never rejects. */
  const reload = async (): Promise<void> => {
    if (closed) return;
    let bytes: Uint8Array;
    let policy: unknown;
    try {
      bytes = readFileSync(file);
      policy = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error) {
      fail(
        new Error(`policyFile(): ${file} could not be read as JSON`, {
          cause: error,
        }),
      );
      return;
    }
    const version = versionId(bytes);
    const head = await inner.get("policy", id);
    const current = head === undefined ? undefined : (head.doc as PolicyHead);
    // A head appended for a revert is `<hash>@<number>`: the same content.
    if (current !== undefined && current.head.split("@")[0] === version) {
      return;
    }
    const seen = (await inner.getVersion(id, version)) !== undefined;
    await inner.appendVersion(
      id,
      {
        // A content seen before (a revert) is appended again under a new
        // id, so it becomes the head and its number shows the history.
        id: seen ? `${version}@${(current?.number ?? 0) + 1}` : version,
        policy,
        message: `from ${file}`,
      },
      current?.head ?? null,
    );
  };

  /** Starts watching the file's directory. */
  const startWatching = (): void => {
    if (options.watch === false || watcher !== undefined) return;
    watcher = watch(dirname(file), (_event, changed) => {
      if (changed !== null && changed !== basename(file)) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, debounceMs);
    });
    watcher.on("error", fail);
    watcher.unref?.();
  };

  /** Reads the file the first time: a missing file, or one that is not JSON, is an error here. */
  const first = async (): Promise<void> => {
    try {
      readFileSync(file);
    } catch (error) {
      throw new ConfigError(`policyFile(): ${file} could not be read`, {
        cause: String(error),
      });
    }
    await reload();
    if ((await inner.get("policy", id)) === undefined) {
      throw new ConfigError(
        `policyFile(): ${file} is not JSON, so it holds no policy`,
      );
    }
    startWatching();
  };

  // The memory store's analytics stay out: a policy file holds a policy.
  const {
    appendEvents: _appendEvents,
    addCounters: _addCounters,
    listEvents: _listEvents,
    series: _series,
    topK: _topK,
    rollup: _rollup,
    deleteBefore: _deleteBefore,
    ...configuration
  } = inner;
  const store: SecurityStoreDriver = {
    ...configuration,
    name,
    capabilities: CAPABILITIES,
    connect: async () => {
      if (closed) {
        throw new ConfigError(`security store "${name}" is closed`);
      }
      connected ??= first().catch((error: unknown) => {
        connected = undefined;
        throw error;
      });
      await connected;
    },
    close: async () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
      await inner.close();
    },
    get: async (kind, docId) => {
      await store.connect();
      return await inner.get(kind, docId);
    },
    list: async (kind, query) => {
      await store.connect();
      return await inner.list(kind, query);
    },
    getVersion: async (policyId, version) => {
      await store.connect();
      return await inner.getVersion(policyId, version);
    },
    listVersions: async (policyId, query) => {
      await store.connect();
      return await inner.listVersions(policyId, query);
    },
    changesSince: async (seq, limit) => {
      await store.connect();
      return await inner.changesSince(seq, limit);
    },
    put: async () => refuseReadOnly(name, "put()"),
    delete: async () => refuseReadOnly(name, "delete()"),
    appendVersion: async () => refuseReadOnly(name, "appendVersion()"),
    putBundle: async () => refuseReadOnly(name, "putBundle()"),
    appendAudit: async () => refuseReadOnly(name, "appendAudit()"),
    appendAuditAtHead: async () => refuseReadOnly(name, "appendAuditAtHead()"),
    appendCheckpoint: async () => refuseReadOnly(name, "appendCheckpoint()"),
    deleteAuditBefore: async () => refuseReadOnly(name, "deleteAuditBefore()"),
    incrementCounter: async () => refuseReadOnly(name, "incrementCounter()"),
    resetCounter: async () => refuseReadOnly(name, "resetCounter()"),
    claimKey: async () => refuseReadOnly(name, "claimKey()"),
    upsertBan: async () => refuseReadOnly(name, "upsertBan()"),
    liftBan: async () => refuseReadOnly(name, "liftBan()"),
    // A policy file keeps no counters.
    getCounter: async () => undefined,
    // A policy file has no audit chain: these read the empty one.
    getAuditHead: async () => {
      await store.connect();
      return await inner.getAuditHead();
    },
    listAudit: async (query) => {
      await store.connect();
      return await inner.listAudit(query);
    },
    listCheckpoints: async (query) => {
      await store.connect();
      return await inner.listCheckpoints(query);
    },
    // A policy file holds one policy and no bundle: an EP reading it
    // compiles the policy itself.
    getBundle: async (serviceId, ifNoneMatch) => {
      await store.connect();
      return await inner.getBundle(serviceId, ifNoneMatch);
    },
  };
  return Object.freeze(store);
}
