/**
 * The three channels (README §9.3, PR-CP6): a JSON webhook signed like
 * CP3's checkpoint sink (`x-bun-security-timestamp`,
 * `x-bun-security-signature: sha256=<hex HMAC of "<timestamp>.<body>">`), a
 * Slack-compatible incoming webhook (`{ text }`), and email through the
 * host's `send` hook. A send that does not succeed throws, so the queue
 * retries it.
 *
 * What a message says is {@link renderMessage}'s alone, so what an alert
 * may carry is decided in one place.
 */
import type { AlertChannelSpec, AlertMessage } from "./types";
import { createHmac } from "node:crypto";

/** An email, for the host's hook. */
export interface AlertEmail {
  /** The addresses. */
  readonly to: readonly string[];
  /** The subject line. */
  readonly subject: string;
  /** The plain-text body. */
  readonly text: string;
}

/**
 * The facts a message may carry (the user's rule, 2026-11-17): counts
 * against their threshold, the window, the time, the rule id (redacted
 * when it names an account), the service and agent, the warning's kind,
 * the route's template (`POST /login`; anything else under `route`, such as
 * a raw path with a query, is dropped), and an address only on an alert
 * about it. Anything else a condition
 * reports is left out here, whatever it is.
 */
export const ALERT_FACTS = Object.freeze([
  "value",
  "threshold",
  "windowMs",
  "perMinute",
  "share",
  "baseline",
  "factor",
  "count",
  "bans",
  "rule",
  "service",
  "agent",
  "silentMs",
  "warning",
  "since",
  "ip",
  "route",
] as const);

/** A route template as the recorder keys it (`POST /login`, `GET /users/:id`): a method, a path, no query. */
const ROUTE_TEMPLATE = /^[A-Z]{3,10} \/[^\s?#]{0,190}$/;

/** What the senders need from the host. */
export interface SenderOptions {
  /** `fetch`, for the webhooks. Default the global. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Sends an email; without it, an email channel's deliveries fail (and dead-letter). */
  readonly email?: (message: AlertEmail) => Promise<void>;
  /** How long a webhook may take, ms. Default 10,000. */
  readonly timeoutMs?: number;
  /** The clock, epoch ms. */
  readonly now: () => number;
  /** The management UI's base URL; each alert links to its screen there. */
  readonly uiUrl?: string;
}

/** A message rendered: its title, its text and its JSON. */
export interface RenderedMessage {
  /** One line. */
  readonly title: string;
  /** Plain text, a line per fact. */
  readonly text: string;
  /** The JSON a webhook posts. */
  readonly json: Readonly<Record<string, unknown>>;
}

/** What a message says (one place, so what an alert may carry is decided here). */
export function renderMessage(
  message: AlertMessage,
  uiUrl?: string,
): RenderedMessage {
  const base = uiUrl?.replace(/\/+$/, "");
  if (message.type === "digest") {
    const total = message.held.reduce((sum, h) => sum + h.count, 0);
    const link = base === undefined ? undefined : `${base}/alerts`;
    return {
      title: `bun-security: ${total} alert${total === 1 ? "" : "s"} held back`,
      text: [
        ...message.held.map((h) => `${h.kind} (${h.severity}): ${h.count}`),
        ...(link === undefined ? [] : [link]),
      ].join("\n"),
      json: {
        type: "digest",
        at: message.at,
        held: message.held,
        ...(link === undefined ? {} : { link }),
      },
    };
  }
  const { alert } = message;
  const facts: Record<string, string | number | boolean> = {};
  for (const name of ALERT_FACTS) {
    const value = alert.facts[name];
    if (value === undefined) continue;
    if (
      name === "route" &&
      (typeof value !== "string" || !ROUTE_TEMPLATE.test(value))
    )
      continue;
    facts[name] = value;
  }
  if (facts.service === undefined && alert.scope.startsWith("service:"))
    facts.service = alert.scope.slice("service:".length);
  const link =
    base === undefined
      ? undefined
      : alert.kind.startsWith("rule:")
        ? `${base}/alerts/rules/${encodeURIComponent(alert.kind.slice(5))}`
        : `${base}/alerts`;
  return {
    title: `[${alert.severity}] ${alert.title} (${alert.scope})`,
    text: [
      alert.title,
      `kind: ${alert.kind}`,
      `scope: ${alert.scope}`,
      `at: ${new Date(alert.at).toISOString()}`,
      ...Object.entries(facts).map(
        ([name, value]) => `${name}: ${String(value)}`,
      ),
      ...(link === undefined ? [] : [link]),
    ].join("\n"),
    json: {
      type: "alert",
      kind: alert.kind,
      // Not the key: it may name a subject (a grouped rule's), and is the
      // control plane's own, for deduplication.
      severity: alert.severity,
      scope: alert.scope,
      title: alert.title,
      at: alert.at,
      facts,
      ...(link === undefined ? {} : { link }),
    },
  };
}

/** Signs a webhook body as CP3's sink does: the hex HMAC-SHA256 of `"<timestamp>.<body>"`. */
export function signWebhook(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

/** Sends one message to one channel; throws when it did not go. */
export async function sendMessage(
  channel: AlertChannelSpec,
  message: AlertMessage,
  options: SenderOptions,
): Promise<void> {
  const rendered = renderMessage(message, options.uiUrl);
  const post = options.fetch ?? ((url, init) => fetch(url, init));
  const timeout = options.timeoutMs ?? 10_000;
  const check = async (response: Response): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok)
      throw new Error(`the channel answered ${response.status}`);
  };
  switch (channel.type) {
    case "webhook": {
      const body = JSON.stringify(rendered.json);
      const timestamp = String(options.now());
      await check(
        await post(channel.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bun-security-timestamp": timestamp,
            "x-bun-security-signature": `sha256=${signWebhook(channel.secret, timestamp, body)}`,
          },
          body,
          signal: AbortSignal.timeout(timeout),
        }),
      );
      return;
    }
    case "slack": {
      await check(
        await post(channel.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `*${rendered.title}*\n${rendered.text}`,
          }),
          signal: AbortSignal.timeout(timeout),
        }),
      );
      return;
    }
    case "email": {
      if (options.email === undefined) {
        throw new Error(
          "no email hook: createSecurityApi's alerts.email is not set",
        );
      }
      await options.email({
        to: channel.to,
        subject: rendered.title,
        text: rendered.text,
      });
    }
  }
}
