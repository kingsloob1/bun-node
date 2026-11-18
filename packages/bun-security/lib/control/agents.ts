/**
 * Agents' keys and health on the control plane (control-plane.md §7,
 * PR-CP4): an agent has its own HMAC key, bound to one service, made by an
 * operator and shown once; a rotation makes a new one and keeps the old
 * one (sealed, `agentKey.previous.secret`) until the agent first signs
 * with the new one or the grace ends; a revocation is at once. Its health
 * is a document of its own (`agentHealth`), written by its heartbeats.
 */
import { randomBytes } from "node:crypto";
import type { StoredDoc } from "../store/types";
import type { AgentHeartbeat } from "../agent/protocol";
import { AGENT_ID_PATTERN, BAN_REPORT_LIMITS } from "../agent/protocol";
import type {
  AgentCreateInput,
  AgentDto,
  AgentSecretDto,
  AgentStatus,
} from "./contract/types";
import type { Operator, ResolvedAgentsOptions } from "./options";
import type { ControlPlane } from "./plane";
import { ApiProblem, conflict, notFound } from "./problems";
import { serviceScope } from "./scopes";

/** An agent key's stored body. Its `secret` and `previous.secret` are sealed by default (storage.md §8). */
export interface AgentKeyBody {
  /** The service it serves. */
  service: string;
  /** Its display name. */
  name: string;
  /** Its HMAC secret. */
  secret: string;
  /** The secret a rotation replaced, while it is still accepted. */
  previous: { secret: string; until: number } | null;
  /** When it was made. */
  createdAt: number;
  /** Who made it. */
  createdBy: string;
  /** When it was last rotated. */
  rotatedAt: number | null;
  /** When it was revoked. */
  revokedAt: number | null;
}

/** An agent's stored health. */
export interface AgentHealthBody {
  /** Its first signed request, epoch ms. */
  firstSeen: number;
  /** Its last heartbeat; `null` before the first. */
  lastSeen: number | null;
  /** What its last heartbeat said. */
  reported: AgentDto["reported"];
}

/** A new secret: 32 random bytes, base64url. */
function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Agents' keys and health; see the module's description. */
export class AgentRegistry {
  /**
   * @param plane The control plane.
   * @param options The agents' options.
   */
  constructor(
    private readonly plane: ControlPlane,
    private readonly options: ResolvedAgentsOptions,
  ) {}

  /** The control plane's clock. */
  get #now(): number {
    return this.plane.now();
  }

  /** The heartbeat interval, ms. */
  get heartbeatIntervalMs(): number {
    return this.options.heartbeatIntervalMs;
  }

  /** An agent's key record, or `undefined`. */
  async key(id: string): Promise<StoredDoc | undefined> {
    return AGENT_ID_PATTERN.test(id)
      ? await this.plane.store.get("agentKey", id)
      : undefined;
  }

  /** The secrets a request from this agent may be signed with: the current, then the replaced one while accepted. */
  secretsOf(body: AgentKeyBody): string[] {
    return body.previous !== null && body.previous.until > this.#now
      ? [body.secret, body.previous.secret]
      : [body.secret];
  }

  /** An agent's status from its key and health. */
  #status(
    body: AgentKeyBody,
    health: AgentHealthBody | undefined,
  ): AgentStatus {
    if (body.revokedAt !== null) return "revoked";
    if (health === undefined || health.lastSeen === null) return "never-seen";
    if (health.reported?.health === "signature-failing")
      return "signature-failing";
    const missed =
      (this.#now - health.lastSeen) / this.options.heartbeatIntervalMs;
    return missed > 10 ? "offline" : missed > 3 ? "late" : "ok";
  }

  /** An agent as the API answers it. */
  async dto(doc: StoredDoc): Promise<AgentDto> {
    const body = doc.doc as AgentKeyBody;
    const health = (await this.plane.store.get("agentHealth", doc.id))?.doc as
      AgentHealthBody | undefined;
    return {
      id: doc.id,
      service: body.service,
      name: body.name,
      createdAt: body.createdAt,
      createdBy: body.createdBy,
      rotatedAt: body.rotatedAt,
      previousAcceptedUntil:
        body.previous !== null && body.previous.until > this.#now
          ? body.previous.until
          : null,
      revokedAt: body.revokedAt,
      status: this.#status(body, health),
      lastSeen: health?.lastSeen ?? null,
      reported: health?.reported ?? null,
      revision: doc.revision,
    };
  }

  /** Makes an agent's key for a service. Audited; the secret is never in the entry. */
  async create(
    input: AgentCreateInput,
    operator: Operator,
  ): Promise<AgentSecretDto> {
    const id = input.id ?? `agent_${randomBytes(8).toString("hex")}`;
    if (!AGENT_ID_PATTERN.test(id)) {
      throw new ApiProblem(
        400,
        "invalid_request",
        `"${id}" is not an agent id ([\\w-]{1,64})`,
      );
    }
    await this.plane.getService(input.service);
    const secret = newSecret();
    const body: AgentKeyBody = {
      service: input.service,
      name: input.name ?? id,
      secret,
      previous: null,
      createdAt: this.#now,
      createdBy: operator.id,
      rotatedAt: null,
      revokedAt: null,
    };
    const doc = await this.plane.audited(
      {
        action: "agent.create",
        scope: serviceScope(input.service),
        target: { kind: "agentKey", id, revision: 1 },
        after: { service: body.service, name: body.name },
      },
      async () => {
        const written = await this.plane.store.put("agentKey", id, body, null);
        if (!written.ok) throw conflict(`agent "${id}" exists`, null);
        return (await this.plane.store.get("agentKey", id))!;
      },
    );
    return { agent: await this.dto(doc), secret };
  }

  /** The key record of `id` for a change at `revision`; a 404, or a 409 for a revoked one. */
  async #forChange(id: string, revision: number): Promise<StoredDoc> {
    const doc = await this.key(id);
    if (doc === undefined) throw notFound(`agent "${id}"`);
    if ((doc.doc as AgentKeyBody).revokedAt !== null) {
      throw new ApiProblem(409, "conflict", `agent "${id}" is revoked`);
    }
    if (doc.revision !== revision) {
      throw conflict(
        `agent "${id}" changed since revision ${revision}`,
        await this.dto(doc),
      );
    }
    return doc;
  }

  /**
   * A new secret for `id`, shown once; the old one stays accepted until the
   * agent first signs with the new one, or the grace ends. Audited.
   */
  async rotate(id: string, revision: number): Promise<AgentSecretDto> {
    const doc = await this.#forChange(id, revision);
    const old = doc.doc as AgentKeyBody;
    const secret = newSecret();
    const until = this.#now + this.options.rotationGraceMs;
    const body: AgentKeyBody = {
      ...old,
      secret,
      previous: { secret: old.secret, until },
      rotatedAt: this.#now,
    };
    const written = await this.plane.audited(
      {
        action: "agent.rotate",
        scope: serviceScope(old.service),
        target: { kind: "agentKey", id, revision: revision + 1 },
        after: { previousAcceptedUntil: until },
      },
      async () => {
        const put = await this.plane.store.put("agentKey", id, body, revision);
        if (!put.ok)
          throw conflict(
            `agent "${id}" changed since revision ${revision}`,
            null,
          );
        return (await this.plane.store.get("agentKey", id))!;
      },
    );
    return { agent: await this.dto(written), secret };
  }

  /** Revokes `id` at once: no secret of it is accepted again. Audited. */
  async revoke(
    id: string,
    revision: number,
    operator: Operator,
  ): Promise<AgentDto> {
    const doc = await this.#forChange(id, revision);
    const old = doc.doc as AgentKeyBody;
    const body: AgentKeyBody = { ...old, previous: null, revokedAt: this.#now };
    const written = await this.plane.audited(
      {
        action: "agent.revoke",
        scope: serviceScope(old.service),
        target: { kind: "agentKey", id, revision: revision + 1 },
        after: { revokedBy: operator.id },
      },
      async () => {
        const put = await this.plane.store.put("agentKey", id, body, revision);
        if (!put.ok)
          throw conflict(
            `agent "${id}" changed since revision ${revision}`,
            null,
          );
        return (await this.plane.store.get("agentKey", id))!;
      },
    );
    return await this.dto(written);
  }

  /** A page of agents by id. */
  async list(
    limit: number,
    cursor?: string,
  ): Promise<{ items: AgentDto[]; next?: string }> {
    const page = await this.plane.store.list("agentKey", {
      limit,
      sort: "id",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const items: AgentDto[] = [];
    for (const doc of page.items) items.push(await this.dto(doc));
    return { items, ...(page.next === undefined ? {} : { next: page.next }) };
  }

  /** One agent. */
  async get(id: string): Promise<AgentDto> {
    const doc = await this.key(id);
    if (doc === undefined) throw notFound(`agent "${id}"`);
    return await this.dto(doc);
  }

  /**
   * After a verified request: records the first contact, and ends a
   * rotation when the agent signed with its new secret. Both are audit
   * events (the user's decision); a race loses quietly.
   */
  async verified(doc: StoredDoc, keyIndex: number): Promise<void> {
    const body = doc.doc as AgentKeyBody;
    const now = this.#now;
    const first = await this.plane.store.put(
      "agentHealth",
      doc.id,
      {
        firstSeen: now,
        lastSeen: null,
        reported: null,
      } satisfies AgentHealthBody,
      null,
    );
    if (first.ok) {
      await this.plane.audit.event(
        "agent.firstContact",
        serviceScope(body.service),
        {
          target: { kind: "agentKey", id: doc.id },
        },
      );
    }
    if (keyIndex === 0 && body.previous !== null) {
      const put = await this.plane.store.put(
        "agentKey",
        doc.id,
        { ...body, previous: null } satisfies AgentKeyBody,
        doc.revision,
      );
      if (put.ok) {
        await this.plane.audit.event(
          "agent.keyRotated",
          serviceScope(body.service),
          {
            target: { kind: "agentKey", id: doc.id },
          },
        );
      }
    }
  }

  /**
   * Records a heartbeat; a change of `signature-failing` is an audit event
   * (and its start an alert). Retries a raced write once.
   */
  async heartbeat(doc: StoredDoc, beat: AgentHeartbeat): Promise<void> {
    const body = doc.doc as AgentKeyBody;
    const reported: NonNullable<AgentDto["reported"]> = {
      agentVersion: beat.agentVersion,
      bundleVersion: beat.bundle?.version ?? null,
      bundleKeyId: beat.bundle?.keyId ?? null,
      bundleExpired: beat.bundle?.expired ?? false,
      banSeq: beat.bans.seq,
      banCount: beat.bans.count,
      health: beat.health,
      ...(beat.lastError === undefined ? {} : { lastError: beat.lastError }),
      ...(beat.intel === undefined
        ? {}
        : {
            intel: {
              feeds: beat.intel.feeds.map((feed) => ({
                id: feed.id,
                size: feed.size,
                refreshedAt: feed.refreshedAt,
                attemptedAt: feed.attemptedAt,
                ...(feed.error === undefined ? {} : { error: feed.error }),
              })),
            },
          }),
      ...(beat.crawlers === undefined
        ? {}
        : {
            crawlers: {
              conflicts: beat.crawlers.conflicts.map((c) => ({
                crawler: c.crawler,
                ...(c.entry === undefined ? {} : { entry: c.entry }),
                ...(c.ban === undefined ? {} : { ban: c.ban }),
                range: c.range,
              })),
              total: beat.crawlers.total,
            },
          }),
      ...(beat.warnings === undefined
        ? {}
        : {
            warnings: beat.warnings.map((w) => ({
              kind: w.kind,
              since: w.since,
              ...(w.share === undefined ? {} : { share: w.share }),
            })),
          }),
      ...(beat.bansDropped === undefined
        ? {}
        : { bansDropped: beat.bansDropped }),
    };
    if (beat.bansDropped !== undefined && beat.bansDropped > 0) {
      // Never silent: the operators hear of every report an agent dropped.
      this.plane.alert({
        kind: "agent.banReportsDropped",
        severity: "warning",
        message: `agent "${doc.id}" of ${serviceScope(body.service)} dropped ${beat.bansDropped} ban report${beat.bansDropped === 1 ? "" : "s"} since its last heartbeat (past its cap of ${BAN_REPORT_LIMITS.perMinute} a minute, or unsendable); its engine still enforces them`,
        detail: {
          agent: doc.id,
          service: body.service,
          dropped: beat.bansDropped,
        },
      });
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.plane.store.get("agentHealth", doc.id);
      const previous = current?.doc as AgentHealthBody | undefined;
      const next: AgentHealthBody = {
        firstSeen: previous?.firstSeen ?? this.#now,
        lastSeen: this.#now,
        reported,
      };
      const put = await this.plane.store.put(
        "agentHealth",
        doc.id,
        next,
        current?.revision ?? null,
      );
      if (!put.ok) continue;
      const was = previous?.reported?.health === "signature-failing";
      const is = beat.health === "signature-failing";
      if (was !== is) {
        const scope = serviceScope(body.service);
        await this.plane.audit.event(
          is ? "agent.signatureFailing" : "agent.signatureRecovered",
          scope,
          {
            target: { kind: "agentKey", id: doc.id },
            ...(beat.lastError === undefined
              ? {}
              : { lastError: beat.lastError }),
          },
        );
        if (is) {
          this.plane.alert({
            kind: "agent.signatureFailing",
            severity: "critical",
            message: `agent "${doc.id}" of ${scope} refuses every bundle or ban batch it fetches: their signatures fail; it keeps enforcing its last good bundle`,
            detail: {
              agent: doc.id,
              service: body.service,
              lastError: beat.lastError ?? null,
            },
          });
        }
      }
      return;
    }
  }
}
