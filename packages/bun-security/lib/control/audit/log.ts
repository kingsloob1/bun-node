/**
 * The audit log (control-plane.md §6): a hash chain over every control-plane
 * change, with signed checkpoints written to the store and to external
 * sinks, `verify`, export and retention.
 *
 * A change is recorded twice (the user's rule, PR-CP3): an **intent** is
 * appended before it (refused with a `503` and nothing changed when the
 * append fails), and a **done** naming the intent after it (when that one
 * fails, the change stands and the answer says so). `verify` and the list
 * reconcile an intent with no done against the store: the change is there
 * (`completed-unconfirmed`) or it is not (`not-applied`), never tampering.
 */
import type { KeyObject } from "node:crypto";
import type { Logger } from "@kingsleyweb/bun-common";
import type {
  AuditCheckpoint,
  AuditHead,
  AuditRecord,
  SecurityStoreDriver,
} from "../../store/types";
import type {
  AuditActorDto,
  AuditEntryDto,
  AuditProblemDto,
  AuditTargetDto,
  AuditVerifyDto,
  SecurityAlertDto,
} from "../contract/types";
import type { CheckpointSink } from "./sinks";
import type { AuditSigner } from "./keys";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../bundle/bundle";
import { AUDIT_GENESIS_HASH } from "../../store/shared";
import { ApiProblem } from "../problems";
import { currentAuditContext } from "./context";
import { checkpointValid, signCheckpoint } from "./keys";

/** A JSON object. */
type JsonObject = Record<string, unknown>;

/** `SHA-256(prevHash || canonical JSON of entry)`, hex (control-plane.md §6.2). */
export function auditHash(prevHash: string, entry: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonicalJson(entry))
    .digest("hex");
}

/** What an intent names. */
export interface AuditIntentInput {
  /** The action (`service.put`). */
  readonly action: string;
  /** The scope. */
  readonly scope: string;
  /** Where the change will land, for reconciling a missing done. */
  readonly target: AuditTargetDto;
  /** The state before, when cheap to have. */
  readonly before?: unknown;
  /** The intended state after (or a diff). */
  readonly after?: unknown;
  /** More: the approval's id, `emergency`, the message. */
  readonly extra?: JsonObject;
}

/** An appended intent, for its done. */
export interface AuditIntent {
  /** Its number. */
  readonly n: number;
  /** What it named. */
  readonly input: AuditIntentInput;
}

/** Options of the audit log. */
export interface AuditLogOptions {
  /** The store. */
  readonly store: SecurityStoreDriver;
  /** The audit key. */
  readonly signer: AuditSigner;
  /** Older audit keys' public halves, by id, still accepted on old checkpoints. */
  readonly previousKeys: ReadonlyMap<string, KeyObject>;
  /** The external sinks. */
  readonly sinks: readonly CheckpointSink[];
  /** A checkpoint every this many entries. */
  readonly checkpointEvery: number;
  /** A checkpoint when the last is older than this, ms. */
  readonly checkpointIntervalMs: number;
  /** The clock. */
  readonly now: () => number;
  /** Raises an alert. */
  readonly alert: (alert: Omit<SecurityAlertDto, "at">) => void;
  /** Where failures are logged. */
  readonly logger: Logger;
}

/** How many times an append is tried (a raced head, a store blip). */
const APPEND_ATTEMPTS = 3;

/** The most checkpoints a sink keeps waiting for a retry. */
const MAX_PENDING_PER_SINK = 100;

/** The audit log; see the module's description. */
export class AuditLog {
  /** Appends run one at a time in this process. */
  #tail: Promise<unknown> = Promise.resolve();
  /** The last checkpoint written, once read. */
  #lastCheckpoint: AuditCheckpoint | null | undefined;
  /** When the oldest entry was written, while there is no checkpoint yet. */
  #firstAt: number | undefined;
  /** Checkpoints a sink failed to take, by sink, retried with the next. */
  readonly #pending = new Map<string, AuditCheckpoint[]>();

  /** @param options The log's options. */
  constructor(private readonly options: AuditLogOptions) {}

  /** Every key a checkpoint may be signed with. */
  get keys(): ReadonlyMap<string, KeyObject> {
    return new Map([
      ...this.options.previousKeys,
      [this.options.signer.keyId, this.options.signer.publicKey],
    ]);
  }

  /** Runs `task` after every append before it. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Appends `entry` (the hashed body) on the head, retrying a raced head; the record. */
  async #append(
    action: string,
    scope: string,
    entry: JsonObject,
  ): Promise<AuditRecord> {
    return await this.#serial(async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
        try {
          const head = await this.options.store.getAuditHead();
          const prevHash = head?.hash ?? AUDIT_GENESIS_HASH;
          const at = this.options.now();
          // The indexed columns are in the hashed body too, so none can be edited unseen.
          const body = { ...entry, action, scope, at };
          const hash = auditHash(prevHash, body);
          const actor =
            (entry.actor as AuditActorDto | undefined)?.id ?? "system";
          const input = {
            hash,
            prevHash,
            at,
            actor,
            action,
            scope,
            entry: body,
          };
          const result = await this.options.store.appendAudit(
            input,
            head?.hash ?? null,
          );
          if (result.ok) {
            const record: AuditRecord = { ...input, n: result.n };
            await this.#maybeCheckpoint({ n: result.n, hash }).catch(
              (error: unknown) =>
                this.options.logger.error(
                  "bun-security audit: a checkpoint failed",
                  { error },
                ),
            );
            return record;
          }
          lastError = new Error("the audit head moved");
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
    });
  }

  /** The request's context as entry fields. */
  #who(): JsonObject {
    const context = currentAuditContext();
    return {
      actor: context.actor,
      address: context.address,
      sessionId: context.sessionId,
      requestId: context.requestId,
      permissions: [...context.permissions],
      stepUp: context.stepUp,
    };
  }

  /**
   * Appends an intent before a change; a `503` (`audit_unavailable`) when
   * it cannot be written, so the change is refused and nothing changes.
   */
  async intent(input: AuditIntentInput): Promise<AuditIntent> {
    try {
      const record = await this.#append(input.action, input.scope, {
        phase: "intent",
        ...this.#who(),
        target: input.target,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...input.extra,
      });
      return { n: record.n, input };
    } catch (error) {
      this.options.logger.error(
        "bun-security audit: an intent could not be written; the change is refused",
        { error },
      );
      throw new ApiProblem(
        503,
        "audit_unavailable",
        "the audit log cannot be written now, so no change is made; try again",
      );
    }
  }

  /**
   * Appends the done of `intent` (`outcome` `applied`, or `refused` with
   * why); answers whether it was written. A failure is logged and marks the
   * request's answer incomplete; the change stands.
   */
  async done(
    intent: AuditIntent,
    outcome: "applied" | "refused",
    extra: JsonObject = {},
  ): Promise<boolean> {
    try {
      await this.#append(intent.input.action, intent.input.scope, {
        phase: "done",
        ...this.#who(),
        intent: intent.n,
        outcome,
        ...extra,
      });
      return true;
    } catch (error) {
      currentAuditContext().incomplete = true;
      this.options.logger.error(
        "bun-security audit: a change landed but its done entry could not be written; the intent stands for it",
        { error, intent: intent.n, action: intent.input.action },
      );
      return false;
    }
  }

  /** Appends an event (a login, an export, a purge); rejects when it cannot. */
  async event(
    action: string,
    scope: string,
    extra: JsonObject,
  ): Promise<number> {
    return (
      await this.#append(action, scope, {
        phase: "event",
        ...this.#who(),
        ...extra,
      })
    ).n;
  }

  /** Signs and writes a checkpoint of `head` when one is due. */
  async #maybeCheckpoint(head: AuditHead): Promise<void> {
    if (this.#lastCheckpoint === undefined) {
      const latest = await this.options.store.listCheckpoints({
        limit: 1,
        direction: "desc",
      });
      this.#lastCheckpoint = latest.items[0] ?? null;
    }
    const last = this.#lastCheckpoint;
    // The interval runs from the last checkpoint, or from the oldest entry before the first.
    let since = last?.at;
    if (since === undefined) {
      this.#firstAt ??=
        (await this.options.store.listAudit({ limit: 1, direction: "asc" }))
          .items[0]?.at ?? this.options.now();
      since = this.#firstAt;
    }
    const due =
      head.n - (last?.n ?? 0) >= this.options.checkpointEvery ||
      (head.n > (last?.n ?? 0) &&
        this.options.now() - since >= this.options.checkpointIntervalMs);
    if (due) await this.#checkpoint(head);
  }

  /** Signs a checkpoint of `head`, stores it, and writes it (and any a sink missed) to every sink. */
  async #checkpoint(head: AuditHead): Promise<AuditCheckpoint> {
    const checkpoint = await signCheckpoint(
      head.n,
      head.hash,
      this.options.now(),
      this.options.signer,
    );
    await this.options.store.appendCheckpoint(checkpoint);
    this.#lastCheckpoint = checkpoint;
    for (const sink of this.options.sinks) {
      const queue = [...(this.#pending.get(sink.name) ?? []), checkpoint];
      const left: AuditCheckpoint[] = [];
      for (const item of queue) {
        try {
          if (left.length > 0)
            throw new Error("an earlier checkpoint is still waiting");
          await sink.write(item);
        } catch (error) {
          left.push(item);
          if (item === checkpoint) {
            this.options.alert({
              kind: "checkpoint.sinkFailed",
              severity: "warning",
              message: `the audit checkpoint of entry ${item.n} could not be written to ${sink.name}; it is retried with the next`,
              detail: {
                sink: sink.name,
                n: item.n,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }
      this.#pending.set(sink.name, left.slice(-MAX_PENDING_PER_SINK));
    }
    return checkpoint;
  }

  /** Checkpoints the head now (a host's job, before a purge); `null` with an empty chain. */
  async checkpointNow(): Promise<AuditCheckpoint | null> {
    return await this.#serial(async () => {
      const head = await this.options.store.getAuditHead();
      return head === null ? null : await this.#checkpoint(head);
    });
  }

  /** Every entry in order, walked page by page. */
  async *entries(
    query: { since?: number; until?: number } = {},
  ): AsyncGenerator<AuditRecord> {
    let cursor: string | undefined;
    do {
      const page = await this.options.store.listAudit({
        limit: 1_000,
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      yield* page.items;
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** Every stored checkpoint, in order. */
  async #storedCheckpoints(): Promise<AuditCheckpoint[]> {
    const out: AuditCheckpoint[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.store.listCheckpoints({
        limit: 1_000,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return out;
  }

  /** How an intent with no done stands: the change is in the store, or it is not. */
  async reconcile(
    target: AuditTargetDto,
  ): Promise<"completed-unconfirmed" | "not-applied"> {
    const store = this.options.store;
    if (target.kind === "version") {
      return (await store.getVersion(target.scope ?? "", target.id)) ===
        undefined
        ? "not-applied"
        : "completed-unconfirmed";
    }
    if (target.kind === "ban") {
      // A ban is never deleted: a lift is its `liftedAt`.
      const ban = await store.getBan(target.id).catch(() => undefined);
      if (target.deleted === true)
        return ban !== undefined && ban.liftedAt !== null
          ? "completed-unconfirmed"
          : "not-applied";
      return ban !== undefined && ban.revision >= (target.revision ?? 1)
        ? "completed-unconfirmed"
        : "not-applied";
    }
    const doc = await store
      .get(target.kind as never, target.id)
      .catch(() => undefined);
    if (target.deleted === true)
      return doc === undefined ? "completed-unconfirmed" : "not-applied";
    return doc !== undefined && doc.revision >= (target.revision ?? 1)
      ? "completed-unconfirmed"
      : "not-applied";
  }

  /** Entries as their DTOs, each intent with its status. */
  async describe(records: readonly AuditRecord[]): Promise<AuditEntryDto[]> {
    const out: AuditEntryDto[] = [];
    for (const record of records) {
      const entry = record.entry as JsonObject;
      const phase = entry.phase as AuditEntryDto["phase"];
      let status: AuditEntryDto["status"];
      if (phase === "intent") status = await this.#statusOf(record);
      out.push({
        n: record.n,
        at: record.at,
        hash: record.hash,
        prevHash: record.prevHash,
        actor: record.actor,
        action: record.action,
        scope: record.scope,
        phase,
        ...(status === undefined ? {} : { status }),
        entry,
      });
    }
    return out;
  }

  /** An intent's status: its done found after it (same action and scope), or reconciled. */
  async #statusOf(
    record: AuditRecord,
  ): Promise<NonNullable<AuditEntryDto["status"]>> {
    const page = await this.options.store.listAudit({
      limit: 200,
      fromN: record.n + 1,
      action: record.action,
      scope: record.scope,
    });
    if (
      page.items.some((item) => (item.entry as JsonObject).intent === record.n)
    )
      return "done";
    return await this.reconcile(
      (record.entry as JsonObject).target as AuditTargetDto,
    );
  }

  /**
   * Recomputes the chain from the oldest retained entry and checks every
   * checkpoint (stored, and read back from each sink that can); names the
   * first entry where it broke, and reconciles intents with no done.
   */
  async verify(): Promise<AuditVerifyDto> {
    const problems: AuditProblemDto[] = [];
    const keys = this.keys;
    const stored = await this.#storedCheckpoints();
    const external: { source: string; checkpoint: AuditCheckpoint }[] = [];
    let readable = 0;
    for (const sink of this.options.sinks) {
      if (sink.read === undefined) continue;
      try {
        for (const checkpoint of await sink.read())
          external.push({ source: sink.name, checkpoint });
        readable++;
      } catch (error) {
        this.options.logger.warn(
          "bun-security audit: a sink could not be read back",
          { error, sink: sink.name },
        );
      }
    }
    const checkpoints = [
      ...stored.map((checkpoint) => ({ source: "store", checkpoint })),
      ...external,
    ];
    for (const { source, checkpoint } of checkpoints) {
      if (!checkpointValid(checkpoint, keys)) {
        problems.push({
          n: checkpoint.n,
          reason: "checkpoint-signature",
          detail: `the checkpoint of entry ${checkpoint.n} is not signed by an audit key`,
          source,
        });
      }
    }
    const trusted = checkpoints.filter(({ checkpoint }) =>
      checkpointValid(checkpoint, keys),
    );
    const byN = new Map<
      number,
      { source: string; checkpoint: AuditCheckpoint }[]
    >();
    for (const item of trusted)
      byN.set(item.checkpoint.n, [...(byN.get(item.checkpoint.n) ?? []), item]);

    const head = await this.options.store.getAuditHead();
    const hashes = new Map<number, string>();
    const doneOf = new Set<number>();
    const intents: AuditRecord[] = [];
    let previous: AuditRecord | undefined;
    let first: number | null = null;
    let checked = 0;
    for await (const record of this.entries()) {
      checked++;
      first ??= record.n;
      const entry = record.entry as JsonObject;
      if (previous === undefined) {
        // The oldest retained entry: the genesis, or anchored by a checkpoint of its predecessor.
        const anchored =
          record.n === 1
            ? record.prevHash === AUDIT_GENESIS_HASH
            : (byN.get(record.n - 1) ?? []).some(
                ({ checkpoint }) => checkpoint.hash === record.prevHash,
              );
        if (!anchored) {
          problems.push({
            n: record.n,
            reason: "anchor",
            detail: `entry ${record.n} is not anchored: no genesis or checkpoint of entry ${record.n - 1} vouches for its predecessor`,
          });
        }
      } else if (record.n !== previous.n + 1) {
        problems.push({
          n: previous.n + 1,
          reason: "gap",
          detail: `entries ${previous.n + 1} to ${record.n - 1} are missing`,
        });
      } else if (record.prevHash !== previous.hash) {
        problems.push({
          n: record.n,
          reason: "order",
          detail: `entry ${record.n} does not follow entry ${previous.n}: moved or reordered`,
        });
      }
      const columnsAgree =
        record.at === entry.at &&
        record.action === entry.action &&
        record.scope === entry.scope &&
        record.actor ===
          ((entry.actor as AuditActorDto | undefined)?.id ?? "system");
      if (auditHash(record.prevHash, entry) !== record.hash || !columnsAgree) {
        problems.push({
          n: record.n,
          reason: "hash-mismatch",
          detail: columnsAgree
            ? `entry ${record.n} does not match its hash: edited`
            : `entry ${record.n}'s columns (time, actor, action or scope) disagree with its hashed body: edited`,
        });
      }
      hashes.set(record.n, record.hash);
      if (entry.phase === "intent") intents.push(record);
      if (entry.phase === "done" && typeof entry.intent === "number")
        doneOf.add(entry.intent);
      previous = record;
    }
    const last = previous?.n ?? null;
    if (head !== null && (last === null || head.n > last) && head.n > 0) {
      problems.push({
        n: (last ?? 0) + 1,
        reason: "truncated",
        detail: `the head says entry ${head.n}, the chain ends at ${last ?? "nothing"}`,
      });
    }
    const headCut = head !== null && (last === null || head.n > last);
    let checkpointCut = false;
    for (const { source, checkpoint } of trusted) {
      const hash = hashes.get(checkpoint.n);
      if (last === null || checkpoint.n > last) {
        // The chain ends before a checkpoint vouched for it: cut off (once).
        if (!headCut && !checkpointCut) {
          checkpointCut = true;
          problems.push({
            n: (last ?? 0) + 1,
            reason: "truncated",
            detail: `a checkpoint of entry ${checkpoint.n} exists, the chain ends at ${last ?? "nothing"}`,
            source,
          });
        }
      } else if (hash !== undefined && hash !== checkpoint.hash) {
        problems.push({
          n: checkpoint.n,
          reason: "checkpoint-mismatch",
          detail: `the checkpoint of entry ${checkpoint.n} disagrees with the chain`,
          source,
        });
      }
    }
    problems.sort((a, b) => a.n - b.n);
    const unconfirmed: AuditVerifyDto["unconfirmed"][number][] = [];
    for (const intent of intents) {
      if (doneOf.has(intent.n)) continue;
      unconfirmed.push({
        n: intent.n,
        action: intent.action,
        scope: intent.scope,
        status: await this.reconcile(
          (intent.entry as JsonObject).target as AuditTargetDto,
        ),
      });
    }
    const result: AuditVerifyDto = {
      ok: problems.length === 0,
      checked,
      first,
      last,
      checkpoints: {
        checked: checkpoints.length,
        latest: stored.at(-1)?.n ?? null,
      },
      external:
        this.options.sinks.length === 0
          ? "none-configured"
          : readable > 0
            ? "checked"
            : "write-only",
      problems,
      unconfirmed,
    };
    if (!result.ok) {
      this.options.alert({
        kind: "audit.verifyFailed",
        severity: "critical",
        message: `the audit chain is broken at entry ${problems[0]?.n} (${problems[0]?.reason})`,
        detail: { problems: problems.slice(0, 10) },
      });
    }
    return result;
  }

  /**
   * Retention (control-plane.md §6.2; never a route): deletes entries
   * older than `before`, only up to the latest checkpoint whose entry is
   * older, so the oldest kept entry stays anchored, in batches; recorded as
   * an intent and a done. How many entries went.
   */
  async purge(before: number, batch = 1_000): Promise<number> {
    const stored = await this.#storedCheckpoints();
    let anchor: AuditCheckpoint | undefined;
    for (const checkpoint of stored) {
      const page = await this.options.store.listAudit({
        limit: 1,
        fromN: checkpoint.n,
        toN: checkpoint.n,
      });
      const entry = page.items[0];
      if (entry !== undefined && entry.at < before) anchor = checkpoint;
    }
    if (anchor === undefined) return 0;
    const intent = await this.intent({
      action: "audit.purge",
      scope: "global",
      target: { kind: "audit", id: String(anchor.n), deleted: true },
      extra: { before, throughEntry: anchor.n },
    });
    let total = 0;
    for (;;) {
      const deleted = await this.options.store.deleteAuditBefore(
        anchor.n + 1,
        batch,
      );
      total += deleted;
      if (deleted < batch) break;
    }
    await this.done(intent, "applied", { deleted: total });
    return total;
  }
}
