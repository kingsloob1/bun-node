/**
 * Following a policy in a security store (storage.md §6): what
 * `createSecurity({ policy: { store, id } })` runs. The engine loads the
 * policy's head version, then follows the store's change feed — pushed
 * where the driver can (`subscribe`), polled every 250 ms where it cannot
 * (`changesSince`) — and, whatever the driver, reconciles with the head
 * every 60 s. A version the engine refuses (it does not compile) is never
 * swapped in: the last known good policy stays in force, a
 * `policy.refused` warning says why, and the same version is not retried.
 * A store that fails raises `policy.unavailable` once, until it answers
 * again.
 *
 * **Last known good on disk** (`lastKnownGood: path`): every policy the
 * engine accepts is written to that file atomically (a temporary file
 * renamed over it, mode `0600`), and read first at start, so a restart
 * during a store outage enforces what was enforced before it.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { PolicyHead, SecurityStoreDriver } from "./types";
import { ConfigError } from "@kingsleyweb/bun-common";
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A policy kept in a security store, as `createSecurity`'s `policy` takes one. */
export interface PolicyFromStore {
  /** The store: `policyFile(path)`, `sqliteStore({ path })`, `memoryStore()`. */
  readonly store: SecurityStoreDriver;
  /** The policy's id in the store. Default `default` (what `policyFile` uses). */
  readonly id?: string;
  /**
   * A file to keep the last policy the engine accepted in (`0600`), read
   * first at start. Without it, the engine starts on an empty policy until
   * the store answers.
   */
  readonly lastKnownGood?: string;
  /** How often a polled feed is read, in milliseconds. Default 250. */
  readonly pollIntervalMs?: number;
  /** How often the head is reconciled whatever the feed said, in milliseconds. Default 60,000. */
  readonly reconcileIntervalMs?: number;
}

/** Where the engine's policy came from, for `status()`. */
export interface PolicySourceStatus {
  /** The store's name. */
  readonly store: string;
  /** The policy's id in it. */
  readonly id: string;
  /** The version in force, once one was loaded from the store or the last-known-good file. */
  readonly version: string | undefined;
  /** When it was loaded, epoch milliseconds. */
  readonly loadedAt: number | undefined;
  /** Whether the version in force came from the last-known-good file, not the store. */
  readonly fromLastKnownGood: boolean;
  /** The last version refused, and why, until a later one loads. */
  readonly refused:
    | {
        /** The refused version's id. */
        readonly version: string;
        /** Why it was refused. */
        readonly message: string;
        /** When, epoch milliseconds. */
        readonly at: number;
      }
    | undefined;
  /** Whether the store is failing now. */
  readonly unavailable: boolean;
}

/** The default poll interval of a polled feed, in milliseconds (bun-cache's SQL bus). */
export const DEFAULT_POLICY_POLL_MS = 250;

/** The default reconcile interval, in milliseconds (storage.md §6). */
export const DEFAULT_POLICY_RECONCILE_MS = 60_000;

/** The last-known-good file's format id. */
const LKG_FORMAT = "bun-security.lkg/1";

/** Whether `value` is a {@link PolicyFromStore} rather than a policy. */
export function isPolicyFromStore(value: unknown): value is PolicyFromStore {
  if (typeof value !== "object" || value === null || !("store" in value)) {
    return false;
  }
  const store = (value as { store: unknown }).store;
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as SecurityStoreDriver).get === "function" &&
    typeof (store as SecurityStoreDriver).changesSince === "function"
  );
}

/** The last-known-good record of `id` in `path`, or `undefined` (missing, unreadable, another policy). */
export function readLastKnownGood(
  path: string,
  id: string,
): { readonly version: string; readonly policy: unknown } | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as {
      format?: unknown;
      policyId?: unknown;
      version?: unknown;
      policy?: unknown;
    };
    if (
      record.format !== LKG_FORMAT ||
      record.policyId !== id ||
      typeof record.version !== "string"
    ) {
      return undefined;
    }
    return { version: record.version, policy: record.policy };
  } catch {
    return undefined;
  }
}

/** Writes the last-known-good record atomically, mode `0600`. */
export function writeLastKnownGood(
  path: string,
  record: { id: string; version: string; policy: unknown; now: number },
): void {
  const temporary = join(
    dirname(path),
    `.${randomBytes(6).toString("hex")}.lkg.tmp`,
  );
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        format: LKG_FORMAT,
        policyId: record.id,
        version: record.version,
        savedAt: record.now,
        policy: record.policy,
      }),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** What the follower asks of the engine. */
export interface PolicyFollowerHooks {
  /** Compiles and swaps in a policy; throws, keeping the old one, when it is refused. */
  readonly load: (policy: unknown) => void;
  /** Raises a warning. */
  readonly warn: (
    kind: "policy.refused" | "policy.unavailable",
    message: string,
    since: number,
  ) => void;
  /** Where failures are logged. */
  readonly logger: Logger;
  /** The clock. */
  readonly now: () => number;
}

/** A positive whole number of milliseconds, or a `ConfigError`. */
function interval(
  value: number | undefined,
  fallback: number,
  what: string,
): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new ConfigError(
      `createSecurity(): policy.${what} must be a positive whole number of milliseconds`,
      { [what]: ms },
    );
  }
  return ms;
}

/** The engine's follower of one policy in a store; see the module's description. */
export class PolicyFollower {
  readonly #source: PolicyFromStore;
  readonly #hooks: PolicyFollowerHooks;
  readonly #id: string;
  readonly #pollMs: number;
  readonly #reconcileMs: number;
  readonly #timers: ReturnType<typeof setInterval>[] = [];
  #unsubscribe: (() => void) | undefined;
  #cursor = 0n;
  #chain: Promise<void> = Promise.resolve();
  #stopped = false;
  #version: string | undefined;
  #loadedAt: number | undefined;
  #fromLastKnownGood = false;
  #refused: PolicySourceStatus["refused"];
  #failingSince: number | undefined;
  #warnedUnavailable = false;

  constructor(
    /** The store and policy to follow. */
    source: PolicyFromStore,
    /** What the follower asks of the engine. */
    hooks: PolicyFollowerHooks,
  ) {
    this.#source = source;
    this.#hooks = hooks;
    this.#id = source.id ?? "default";
    if (typeof this.#id !== "string" || this.#id.length === 0) {
      throw new ConfigError(
        "createSecurity(): policy.id must be a non-empty string",
      );
    }
    this.#pollMs = interval(
      source.pollIntervalMs,
      DEFAULT_POLICY_POLL_MS,
      "pollIntervalMs",
    );
    this.#reconcileMs = interval(
      source.reconcileIntervalMs,
      DEFAULT_POLICY_RECONCILE_MS,
      "reconcileIntervalMs",
    );
  }

  /**
   * The policy to start on: the last-known-good file's, when it holds this
   * policy; else `undefined` (the engine starts empty).
   */
  initial(): unknown {
    if (this.#source.lastKnownGood === undefined) return undefined;
    const record = readLastKnownGood(this.#source.lastKnownGood, this.#id);
    if (record === undefined) return undefined;
    this.#version = record.version;
    this.#fromLastKnownGood = true;
    this.#loadedAt = this.#hooks.now();
    return record.policy;
  }

  /** Records that the policy {@link initial} gave was refused by the engine. */
  initialRefused(): void {
    this.#version = undefined;
    this.#fromLastKnownGood = false;
    this.#loadedAt = undefined;
  }

  /** Connects, loads the head, and starts following. Resolves after the first attempt; never rejects. */
  async start(): Promise<void> {
    const { store } = this.#source;
    try {
      await store.connect();
      this.#cursor = (await store.changesSince(0n, 1)).head;
    } catch (error) {
      this.#failed(error);
    }
    await this.#sync();
    if (this.#stopped) return;
    if (
      store.subscribe !== undefined &&
      store.capabilities.changeFeed === "push"
    ) {
      try {
        this.#unsubscribe = store.subscribe(
          () => this.#enqueue(() => this.#feed()),
          () => this.#enqueue(() => this.#reload()),
        );
      } catch (error) {
        this.#failed(error);
      }
    } else {
      this.#every(this.#pollMs, () => this.#feed());
    }
    this.#every(this.#reconcileMs, () => this.#reload());
  }

  /** Stops following. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Where the policy came from, and how the store is doing. */
  status(): PolicySourceStatus {
    return Object.freeze({
      store: this.#source.store.name,
      id: this.#id,
      version: this.#version,
      loadedAt: this.#loadedAt,
      fromLastKnownGood: this.#fromLastKnownGood,
      refused: this.#refused,
      unavailable: this.#failingSince !== undefined,
    });
  }

  /** Runs `work` every `ms`, queued behind whatever runs. */
  #every(ms: number, work: () => Promise<void>): void {
    const timer = setInterval(() => this.#enqueue(work), ms);
    timer.unref?.();
    this.#timers.push(timer);
  }

  /** Queues `work` after the one running, so two never overlap. */
  #enqueue(work: () => Promise<void>): void {
    if (this.#stopped) return;
    this.#chain = this.#chain.then(async () => {
      if (!this.#stopped) await work();
    });
  }

  /** Reads the feed from the cursor; reloads when this policy changed. */
  async #feed(): Promise<void> {
    try {
      let changed = false;
      for (;;) {
        const { changes, head } = await this.#source.store.changesSince(
          this.#cursor,
          1_000,
        );
        for (const change of changes) {
          if (change.kind === "policy" && change.id === this.#id) {
            changed = true;
          }
          this.#cursor = change.seq;
        }
        if (changes.length < 1_000) {
          if (head > this.#cursor) this.#cursor = head;
          break;
        }
      }
      this.#recovered();
      if (changed) await this.#sync();
    } catch (error) {
      this.#failed(error);
    }
  }

  /** A full reconcile: the head, whatever the feed said. */
  async #reload(): Promise<void> {
    await this.#sync();
  }

  /** Loads the head version when it is not the one in force. Never rejects. */
  async #sync(): Promise<void> {
    if (this.#stopped) return;
    const { store } = this.#source;
    try {
      const head = await store.get("policy", this.#id);
      if (head === undefined) {
        this.#recovered();
        return;
      }
      const { head: versionId } = head.doc as PolicyHead;
      if (versionId === this.#version || versionId === this.#refused?.version) {
        this.#recovered();
        return;
      }
      const version = await store.getVersion(this.#id, versionId);
      this.#recovered();
      if (version === undefined || this.#stopped) return;
      try {
        this.#hooks.load(version.policy);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const at = this.#hooks.now();
        this.#refused = Object.freeze({ version: versionId, message, at });
        this.#hooks.warn(
          "policy.refused",
          `bun-security: version ${versionId} of policy "${this.#id}" in the store "${store.name}" was refused, and the policy in force (${this.#version ?? "none"}) is kept: ${message}`,
          at,
        );
        return;
      }
      this.#version = versionId;
      this.#loadedAt = this.#hooks.now();
      this.#fromLastKnownGood = false;
      this.#refused = undefined;
      if (this.#source.lastKnownGood !== undefined) {
        try {
          writeLastKnownGood(this.#source.lastKnownGood, {
            id: this.#id,
            version: versionId,
            policy: version.policy,
            now: this.#hooks.now(),
          });
        } catch (error) {
          this.#hooks.logger.error(
            `bun-security: the last known good policy could not be written to ${this.#source.lastKnownGood}`,
            { error },
          );
        }
      }
    } catch (error) {
      this.#failed(error);
    }
  }

  /** Notes a store failure; warns once per outage. */
  #failed(error: unknown): void {
    const now = this.#hooks.now();
    this.#failingSince ??= now;
    this.#hooks.logger.warn(
      `bun-security: the policy store "${this.#source.store.name}" failed; the policy in force is kept`,
      { error },
    );
    if (!this.#warnedUnavailable) {
      this.#warnedUnavailable = true;
      this.#hooks.warn(
        "policy.unavailable",
        `bun-security: the policy store "${this.#source.store.name}" is failing; the policy in force (${this.#version ?? "none"}) is kept until it answers`,
        this.#failingSince,
      );
    }
  }

  /** Notes that the store answered. */
  #recovered(): void {
    this.#failingSince = undefined;
    this.#warnedUnavailable = false;
  }
}
