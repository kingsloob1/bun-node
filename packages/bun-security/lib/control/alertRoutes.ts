/**
 * The alerts routes (README §9.3, PR-CP6): rules, channels, the delivery
 * log, dead letters and the open alerts.
 *
 * Who may do what (the user's decisions, 2026-11-17): `alerts:read`
 * (analyst and up) reads rules, channels (redacted), the open alerts, the
 * delivery log and dead letters; `alerts:write` (admin) makes and changes
 * rules and channels, sends a test and replays a dead letter. Minting or
 * rotating a webhook's secret needs a step-up, as an agent key does. A rule is checked
 * on its scope; channels, the log and dead letters on `global`.
 *
 * A channel's secret and URL are write-only: the secret is minted here and
 * shown once (when the channel is made or its secret rotated), and a URL is
 * answered as scheme and host. Every change is audited intent-first, its
 * entry holding the channel as the API shows it, never its secret or URL.
 */
import type { Alerting, AlertLogEntry } from "./alerts/alerting";
import type { AlertChannelSpec, AlertRuleSpec } from "./alerts/types";
import type {
  AlertChannelDto,
  AlertChannelReceives,
  AlertDeadLetterDto,
  AlertRuleDto,
} from "./contract/alerts";
import type { Operator } from "./options";
import type { ControlPlane } from "./plane";
import type { AnyRoute } from "./routes";
import type { Infer } from "./schema";
import type { StoredDoc } from "../store/types";
import { randomBytes } from "node:crypto";
import { ConfigError } from "@kingsleyweb/bun-common";
import * as A from "./alertSchemas";
import { checkCondition } from "./alerts/conditions";
import { ALERT_API_LIMITS } from "./contract/alerts";
import { ApiProblem, conflict, notFound } from "./problems";

/** A channel as the API answers it: its URL as scheme and host, never its secret. */
export function channelDto(doc: StoredDoc): AlertChannelDto {
  const spec = doc.doc as AlertChannelSpec;
  return {
    id: spec.id,
    name: spec.name,
    type: spec.type,
    ...(spec.type === "email"
      ? { to: [...spec.to] }
      : { url: schemeAndHost(spec.url) }),
    ...(spec.receives === undefined ? {} : { receives: spec.receives }),
    revision: doc.revision,
  };
}

/** A URL's scheme and host (`https://hooks.example.com`); `""` for one that does not parse. */
function schemeAndHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

/** A rule as the API answers it. */
function ruleDto(doc: StoredDoc): AlertRuleDto {
  const spec = doc.doc as AlertRuleSpec;
  return {
    id: spec.id,
    title: spec.title,
    scope: spec.scope,
    severity: spec.severity,
    condition: spec.condition,
    channels: [...spec.channels],
    enabled: spec.enabled !== false,
    revision: doc.revision,
  };
}

/** Whether `host` is a loopback host. */
function loopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Checks a channel URL: `https:`, or `http:` to a loopback host; no credentials in it. */
function checkUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiProblem(
      400,
      "invalid_request",
      "the channel's url is not a URL",
    );
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && loopback(parsed.hostname))
  ) {
    throw new ApiProblem(
      400,
      "invalid_request",
      "the channel's url must be https: (http: only to a loopback host)",
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ApiProblem(
      400,
      "invalid_request",
      "the channel's url must not carry credentials",
    );
  }
  return parsed.href;
}

/**
 * Minting or rotating a webhook's signing secret needs a fresh second
 * factor where a hook is configured; under two-person approvals with no
 * hook it is refused (an approval would have to show the secret to
 * someone), as for an agent key.
 */
async function secretStepUp(stepUp: () => Promise<boolean>): Promise<void> {
  if (!(await stepUp())) {
    throw new ApiProblem(
      403,
      "forbidden",
      "minting or rotating a webhook's signing secret needs a step-up hook (stepUp); under approvals without one it is refused",
    );
  }
}

/** A new webhook secret: 32 random bytes, base64url. */
function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Every document of `kind`, up to `max`. */
async function allOf(
  plane: ControlPlane,
  kind: "alertRule" | "alertChannel",
  max: number,
): Promise<StoredDoc[]> {
  const out: StoredDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await plane.store.list(kind, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined && out.length < max);
  return out;
}

/** A page of `items` at an offset cursor. */
function pageOf<T>(
  items: readonly T[],
  limit: number | undefined,
  cursor: string | undefined,
): { items: T[]; next?: string } {
  const from = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(from) || from < 0) {
    throw new ApiProblem(400, "invalid_request", "the cursor is not valid");
  }
  const size = limit ?? 50;
  const slice = items.slice(from, from + size);
  return {
    items: slice,
    ...(from + size < items.length ? { next: String(from + size) } : {}),
  };
}

/** A stored doc or a 404. */
async function getOr404(
  plane: ControlPlane,
  kind: "alertRule" | "alertChannel",
  id: string,
): Promise<StoredDoc> {
  const doc = await plane.store.get(kind, id);
  if (doc === undefined)
    throw notFound(
      `${kind === "alertRule" ? "alert rule" : "channel"} "${id}"`,
    );
  return doc;
}

/** Writes a doc at `revision`, or a 409 with what is there. */
async function write(
  plane: ControlPlane,
  kind: "alertRule" | "alertChannel",
  id: string,
  doc: unknown,
  revision: number | null,
): Promise<StoredDoc> {
  const put = await plane.store.put(kind, id, doc, revision);
  if (!put.ok) {
    throw conflict(
      revision === null
        ? `"${id}" already exists`
        : `"${id}" changed since revision ${revision}`,
      put.conflict === undefined
        ? null
        : kind === "alertChannel"
          ? channelDto(put.conflict)
          : ruleDto(put.conflict),
    );
  }
  return { kind, id, revision: put.revision, doc } as StoredDoc;
}

/** The receives a channel stores. */
function receivesOf(receives: AlertChannelReceives | undefined): {
  receives?: AlertChannelReceives;
} {
  return receives === undefined
    ? {}
    : {
        receives: {
          kinds: [...receives.kinds],
          ...(receives.minSeverity === undefined
            ? {}
            : { minSeverity: receives.minSeverity }),
        },
      };
}

/** A dead letter as the API answers it (never its message). */
function deadLetterDto(
  letter: ReturnType<Alerting["deadLetters"]>[number],
): AlertDeadLetterDto {
  const { message } = letter;
  return {
    id: letter.id,
    channelId: letter.channelId,
    kind: message.type === "digest" ? "digest" : message.alert.kind,
    severity: message.type === "digest" ? null : message.alert.severity,
    attempts: letter.attempts,
    reason: letter.reason,
    queuedAt: letter.queuedAt,
    diedAt: letter.diedAt,
  };
}

/** The log entry as the API answers it. */
function logDto(entry: AlertLogEntry): AlertLogEntry {
  return { ...entry };
}

/** Whether `operator` may read alerts on `scope`. */
async function canRead(
  plane: ControlPlane,
  operator: Operator,
  scope: string,
): Promise<boolean> {
  return await plane.can(operator, "alerts:read", scope);
}

/** The alerts routes. */
export function alertRoutes(alerting: Alerting): AnyRoute[] {
  return [
    // ── Rules ──────────────────────────────────────────────────────────────
    {
      method: "get",
      path: "/alerts/rules",
      summary: "The alert rules the operator may read, a page at a time",
      tag: "alerts",
      query: A.AlertLogQuery,
      responses: { 200: A.AlertRules },
      handle: async ({ plane, query, operator }) => {
        const q = query as Infer<typeof A.AlertLogQuery>;
        const visible: AlertRuleDto[] = [];
        for (const doc of await allOf(
          plane,
          "alertRule",
          ALERT_API_LIMITS.maxRules,
        )) {
          const rule = ruleDto(doc);
          if (await canRead(plane, operator, rule.scope)) visible.push(rule);
        }
        return { status: 200, body: pageOf(visible, q.limit, q.cursor) };
      },
    },
    {
      method: "get",
      path: "/alerts/rules/:id",
      summary: "One alert rule",
      tag: "alerts",
      params: A.RuleIdParams,
      responses: { 200: A.AlertRule },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        const { id } = params as { id: string };
        const rule = ruleDto(await getOr404(plane, "alertRule", id));
        await require("alerts:read", rule.scope);
        return { status: 200, body: rule };
      },
    },
    {
      method: "put",
      path: "/alerts/rules/:id",
      summary:
        "Makes an alert rule (revision null) or updates it at the revision read",
      tag: "alerts",
      params: A.RuleIdParams,
      body: A.AlertRuleBody,
      responses: { 200: A.AlertRule, 201: A.AlertRule },
      problems: [404, 409],
      handle: async ({ plane, require, params, body }) => {
        const { id } = params as { id: string };
        const input = body as Infer<typeof A.AlertRuleBody>;
        await require("alerts:write", input.scope);
        const before = await plane.store.get("alertRule", id);
        if (before !== undefined)
          await require("alerts:write", (before.doc as AlertRuleSpec).scope);
        try {
          checkCondition(input.condition);
        } catch (error) {
          if (error instanceof ConfigError)
            throw new ApiProblem(400, "invalid_request", error.message);
          throw error;
        }
        for (const channel of new Set(input.channels)) {
          if ((await plane.store.get("alertChannel", channel)) === undefined) {
            throw new ApiProblem(
              400,
              "invalid_request",
              `the channel "${channel}" does not exist`,
            );
          }
        }
        if (input.revision === null) {
          const count = (
            await allOf(plane, "alertRule", ALERT_API_LIMITS.maxRules)
          ).length;
          if (count >= ALERT_API_LIMITS.maxRules) {
            throw new ApiProblem(
              400,
              "invalid_request",
              `at most ${ALERT_API_LIMITS.maxRules} alert rules`,
            );
          }
        }
        const spec: AlertRuleSpec = {
          id,
          title: input.title,
          scope: input.scope,
          severity: input.severity,
          condition: input.condition,
          channels: [...new Set(input.channels)],
          ...(input.enabled === false ? { enabled: false } : {}),
        };
        const doc = await plane.audited(
          {
            action: "alertRule.put",
            scope: input.scope,
            target: {
              kind: "alertRule",
              id,
              revision: input.revision === null ? 1 : input.revision + 1,
            },
            before: before?.doc,
            after: spec,
          },
          async () => await write(plane, "alertRule", id, spec, input.revision),
          (written) => ({ revision: written.revision }),
        );
        return {
          status: input.revision === null ? 201 : 200,
          body: ruleDto(doc),
        };
      },
    },
    {
      method: "delete",
      path: "/alerts/rules/:id",
      summary:
        "Deletes an alert rule at the revision read (its open alerts close)",
      tag: "alerts",
      params: A.RuleIdParams,
      query: A.AlertRevisionQuery,
      responses: { 204: null },
      problems: [404, 409],
      handle: async ({ plane, require, params, query }) => {
        const { id } = params as { id: string };
        const { revision } = query as { revision: number };
        const doc = await getOr404(plane, "alertRule", id);
        const scope = (doc.doc as AlertRuleSpec).scope;
        await require("alerts:write", scope);
        await plane.audited(
          {
            action: "alertRule.delete",
            scope,
            target: { kind: "alertRule", id, deleted: true },
            before: doc.doc,
          },
          async () => {
            if (!(await plane.store.delete("alertRule", id, revision))) {
              const now = await plane.store.get("alertRule", id);
              throw conflict(
                `"${id}" changed since revision ${revision}`,
                now === undefined ? null : ruleDto(now),
              );
            }
          },
        );
        return { status: 204 };
      },
    },
    {
      method: "get",
      path: "/alerts/open",
      summary:
        "The alerts open now on this instance, for the rules the operator may read",
      tag: "alerts",
      responses: { 200: A.OpenAlerts },
      handle: async ({ plane, operator }) => {
        const items = [];
        for (const open of alerting.open()) {
          if (await canRead(plane, operator, open.scope)) {
            items.push({
              rule: open.rule,
              scope: open.scope,
              since: open.since,
            });
          }
        }
        return { status: 200, body: { items } };
      },
    },

    // ── Channels (admin) ──────────────────────────────────────────────────
    {
      method: "get",
      path: "/alerts/channels",
      summary: "The channels: URLs as scheme and host, never a secret",
      tag: "alerts",
      query: A.AlertLogQuery,
      responses: { 200: A.AlertChannels },
      handle: async ({ plane, require, query }) => {
        await require("alerts:read", "global");
        const q = query as Infer<typeof A.AlertLogQuery>;
        const all = (
          await allOf(plane, "alertChannel", ALERT_API_LIMITS.maxChannels)
        ).map(channelDto);
        return { status: 200, body: pageOf(all, q.limit, q.cursor) };
      },
    },
    {
      method: "get",
      path: "/alerts/channels/:id",
      summary: "One channel: its URL as scheme and host, never its secret",
      tag: "alerts",
      params: A.RuleIdParams,
      responses: { 200: A.AlertChannel },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        await require("alerts:read", "global");
        const { id } = params as { id: string };
        return {
          status: 200,
          body: channelDto(await getOr404(plane, "alertChannel", id)),
        };
      },
    },
    {
      method: "post",
      path: "/alerts/channels",
      summary:
        "Makes a channel; a webhook's signing secret is minted and shown this once",
      tag: "alerts",
      body: A.AlertChannelCreateBody,
      responses: { 201: A.AlertChannelSecret },
      problems: [409],
      handle: async ({ plane, require, stepUp, body }) => {
        await require("alerts:write", "global");
        const input = body as Infer<typeof A.AlertChannelCreateBody>;
        let spec: AlertChannelSpec;
        let secret: string | undefined;
        if (input.type === "email") {
          if (
            input.to === undefined ||
            input.to.length === 0 ||
            input.url !== undefined
          ) {
            throw new ApiProblem(
              400,
              "invalid_request",
              "an email channel takes to (one address or more), not url",
            );
          }
          spec = {
            id: input.id,
            name: input.name,
            type: "email",
            to: [...input.to],
            ...receivesOf(input.receives),
          };
        } else {
          if (input.url === undefined || input.to !== undefined) {
            throw new ApiProblem(
              400,
              "invalid_request",
              `a ${input.type} channel takes url, not to`,
            );
          }
          const url = checkUrl(input.url);
          if (input.type === "webhook") {
            await secretStepUp(stepUp);
            secret = newSecret();
            spec = {
              id: input.id,
              name: input.name,
              type: "webhook",
              url,
              secret,
              ...receivesOf(input.receives),
            };
          } else {
            spec = {
              id: input.id,
              name: input.name,
              type: "slack",
              url,
              ...receivesOf(input.receives),
            };
          }
        }
        const count = (
          await allOf(plane, "alertChannel", ALERT_API_LIMITS.maxChannels)
        ).length;
        if (count >= ALERT_API_LIMITS.maxChannels) {
          throw new ApiProblem(
            400,
            "invalid_request",
            `at most ${ALERT_API_LIMITS.maxChannels} channels`,
          );
        }
        const view = (doc: StoredDoc) => channelDto(doc);
        const doc = await plane.audited(
          {
            action: "alertChannel.create",
            scope: "global",
            target: { kind: "alertChannel", id: input.id, revision: 1 },
            after: view({
              kind: "alertChannel",
              id: input.id,
              revision: 1,
              doc: spec,
            } as StoredDoc),
          },
          async () => await write(plane, "alertChannel", input.id, spec, null),
        );
        return {
          status: 201,
          body: {
            channel: channelDto(doc),
            ...(secret === undefined ? {} : { secret }),
          },
        };
      },
    },
    {
      method: "put",
      path: "/alerts/channels/:id",
      summary:
        "Updates a channel at the revision read; what is absent is kept (its URL is write-only)",
      tag: "alerts",
      params: A.RuleIdParams,
      body: A.AlertChannelUpdateBody,
      responses: { 200: A.AlertChannel },
      problems: [404, 409],
      handle: async ({ plane, require, params, body }) => {
        await require("alerts:write", "global");
        const { id } = params as { id: string };
        const input = body as Infer<typeof A.AlertChannelUpdateBody>;
        const current = await getOr404(plane, "alertChannel", id);
        const old = current.doc as AlertChannelSpec;
        if (
          old.type === "email"
            ? input.url !== undefined
            : input.to !== undefined
        ) {
          throw new ApiProblem(
            400,
            "invalid_request",
            old.type === "email"
              ? "an email channel takes to, not url"
              : `a ${old.type} channel takes url, not to`,
          );
        }
        const receives =
          input.receives === undefined
            ? receivesOf(old.receives)
            : input.receives === null
              ? {}
              : receivesOf(input.receives);
        const name = input.name ?? old.name;
        const spec: AlertChannelSpec =
          old.type === "email"
            ? {
                id,
                name,
                type: "email",
                to: input.to === undefined ? old.to : [...input.to],
                ...receives,
              }
            : old.type === "webhook"
              ? {
                  id,
                  name,
                  type: "webhook",
                  url: input.url === undefined ? old.url : checkUrl(input.url),
                  secret: old.secret,
                  ...receives,
                }
              : {
                  id,
                  name,
                  type: "slack",
                  url: input.url === undefined ? old.url : checkUrl(input.url),
                  ...receives,
                };
        const doc = await plane.audited(
          {
            action: "alertChannel.put",
            scope: "global",
            target: { kind: "alertChannel", id, revision: input.revision + 1 },
            before: channelDto(current),
            after: {
              ...channelDto({ ...current, doc: spec }),
              ...(input.url === undefined ? {} : { urlChanged: true }),
            },
          },
          async () =>
            await write(plane, "alertChannel", id, spec, input.revision),
        );
        return { status: 200, body: channelDto(doc) };
      },
    },
    {
      method: "post",
      path: "/alerts/channels/:id/secret",
      summary:
        "A new signing secret for a webhook channel, shown this once (the old one stops at once)",
      tag: "alerts",
      params: A.RuleIdParams,
      body: A.AlertChannelRevisionBody,
      responses: { 200: A.AlertChannelSecret },
      problems: [404, 409],
      handle: async ({ plane, require, stepUp, params, body }) => {
        await require("alerts:write", "global");
        const { id } = params as { id: string };
        const { revision } = body as { revision: number };
        const current = await getOr404(plane, "alertChannel", id);
        const old = current.doc as AlertChannelSpec;
        if (old.type !== "webhook") {
          throw new ApiProblem(
            400,
            "invalid_request",
            "only a webhook channel has a secret",
          );
        }
        await secretStepUp(stepUp);
        const secret = newSecret();
        const doc = await plane.audited(
          {
            action: "alertChannel.rotateSecret",
            scope: "global",
            target: { kind: "alertChannel", id, revision: revision + 1 },
          },
          async () =>
            await write(
              plane,
              "alertChannel",
              id,
              { ...old, secret },
              revision,
            ),
        );
        return { status: 200, body: { channel: channelDto(doc), secret } };
      },
    },
    {
      method: "delete",
      path: "/alerts/channels/:id",
      summary:
        "Deletes a channel at the revision read (refused while a rule sends to it)",
      tag: "alerts",
      params: A.RuleIdParams,
      query: A.AlertRevisionQuery,
      responses: { 204: null },
      problems: [404, 409],
      handle: async ({ plane, require, params, query }) => {
        await require("alerts:write", "global");
        const { id } = params as { id: string };
        const { revision } = query as { revision: number };
        const current = await getOr404(plane, "alertChannel", id);
        const users = (
          await allOf(plane, "alertRule", ALERT_API_LIMITS.maxRules)
        ).filter((doc) => (doc.doc as AlertRuleSpec).channels.includes(id));
        if (users.length > 0) {
          throw new ApiProblem(
            409,
            "conflict",
            `the rules ${users.map((doc) => `"${doc.id}"`).join(", ")} send to "${id}"`,
          );
        }
        await plane.audited(
          {
            action: "alertChannel.delete",
            scope: "global",
            target: { kind: "alertChannel", id, deleted: true },
            before: channelDto(current),
          },
          async () => {
            if (!(await plane.store.delete("alertChannel", id, revision))) {
              const now = await plane.store.get("alertChannel", id);
              throw conflict(
                `"${id}" changed since revision ${revision}`,
                now === undefined ? null : channelDto(now),
              );
            }
          },
        );
        return { status: 204 };
      },
    },
    {
      method: "post",
      path: "/alerts/channels/:id/test",
      summary:
        "Queues a test alert to a channel, past its rate limits; the delivery log shows how it went",
      tag: "alerts",
      params: A.RuleIdParams,
      responses: { 202: null },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        await require("alerts:write", "global");
        const { id } = params as { id: string };
        await getOr404(plane, "alertChannel", id);
        await plane.audited(
          {
            action: "alertChannel.test",
            scope: "global",
            target: { kind: "alertChannel", id },
          },
          async () => await alerting.test(id),
        );
        return { status: 202 };
      },
    },

    // ── Delivery log and dead letters ─────────────────────────────────────
    {
      method: "get",
      path: "/alerts/deliveries",
      summary:
        "The delivery log on this instance, newest first: each try's outcome, never the message (30 days, 10,000 a channel)",
      tag: "alerts",
      query: A.AlertLogQuery,
      responses: { 200: A.AlertDeliveryLogPage },
      handle: async ({ require, query }) => {
        await require("alerts:read", "global");
        const q = query as Infer<typeof A.AlertLogQuery>;
        return {
          status: 200,
          body: pageOf(
            alerting.deliveries(q.channel).map(logDto),
            q.limit,
            q.cursor,
          ),
        };
      },
    },
    {
      method: "get",
      path: "/alerts/dead-letters",
      summary:
        "Deliveries out of tries, newest first, never the message (30 days, 10,000 a channel)",
      tag: "alerts",
      query: A.AlertLogQuery,
      responses: { 200: A.AlertDeadLetters },
      handle: async ({ require, query }) => {
        await require("alerts:read", "global");
        const q = query as Infer<typeof A.AlertLogQuery>;
        return {
          status: 200,
          body: pageOf(
            alerting.deadLetters(q.channel).map(deadLetterDto),
            q.limit,
            q.cursor,
          ),
        };
      },
    },
    {
      method: "post",
      path: "/alerts/dead-letters/:id/replay",
      summary: "Queues a dead letter again with fresh tries",
      tag: "alerts",
      params: A.DeliveryIdParams,
      responses: { 202: null },
      problems: [404],
      handle: async ({ plane, require, params }) => {
        await require("alerts:write", "global");
        const { id } = params as { id: string };
        if (!alerting.deadLetters().some((letter) => letter.id === id))
          throw notFound(`dead letter "${id}"`);
        await plane.audited(
          {
            action: "alertDeadLetter.replay",
            scope: "global",
            target: { kind: "alertDeadLetter", id },
          },
          async () => {
            if (!(await alerting.replay(id)))
              throw notFound(`dead letter "${id}"`);
          },
        );
        return { status: 202 };
      },
    },
  ];
}
