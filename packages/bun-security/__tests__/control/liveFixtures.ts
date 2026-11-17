/**
 * Fixtures of the live and analytics tests: an API with a group, two
 * services and operators bound as viewer, analyst and a group's analyst;
 * events that carry every field a viewer may not see; a recording
 * transport for the hub.
 */
import type { LiveTransport } from "../../lib/control/live/hub";
import type { SecurityApiOptions } from "../../lib/control/index";
import type { CounterRow, SecurityEvent } from "../../lib/store/index";
import { testApi } from "./helpers";

/** The fixture's clock start. */
export const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

/** Markers a viewer must never see: the user's and the API key's HMAC keys (#842) and the username's. */
export const SECRET_SUBJECTS = {
  user: "user-key-SECRET",
  apiKey: "apikey-hmac-SECRET",
  username: "username-hmac-SECRET",
};

/** An event of `service` carrying a sample and every subject. */
export function fullEvent(
  id: string,
  service: string,
  extra: Partial<SecurityEvent> = {},
): SecurityEvent {
  return {
    id,
    at: T0,
    service,
    action: "block",
    rule: `apiKey:${SECRET_SUBJECTS.apiKey}`,
    rules: [`apiKey:${SECRET_SUBJECTS.apiKey}`, "r-plain"],
    route: "POST /login",
    subjects: { ip: "203.0.113.7", ...SECRET_SUBJECTS },
    country: "NG",
    asn: 64_500,
    sample: {
      method: "POST",
      path: "/login",
      headers: { "user-agent": "SAMPLE-SECRET" },
    },
    ...extra,
  };
}

/** Counter rows of `service`: requests by action, and top-K by address and by API key. */
export function counters(service: string, value = 1): CounterRow[] {
  return [
    { service, at: T0, metric: "requests", dims: { action: "block" }, value },
    {
      service,
      at: T0,
      metric: "requests",
      dims: { action: "allow" },
      value: value * 10,
    },
    {
      service,
      at: T0,
      metric: "top.refused",
      dims: { kind: "ip", subject: "203.0.113.7" },
      value,
    },
    {
      service,
      at: T0,
      metric: "top.refused",
      dims: { kind: "apiKey", subject: SECRET_SUBJECTS.apiKey },
      value,
    },
    {
      service,
      at: T0,
      metric: "rules",
      dims: {
        rule: `apiKey:${SECRET_SUBJECTS.apiKey}`,
        action: "block",
        dryRun: "false",
      },
      value,
    },
  ];
}

/**
 * An API with group `payments` holding service `pay`, a service `shop`
 * outside it, and bindings: `vic` viewer and `ann` analyst on global,
 * `gina` analyst on the group.
 */
export async function liveApi(options: Partial<SecurityApiOptions> = {}) {
  const test = testApi(options);
  const { call } = test;
  await call("POST", "/groups", { id: "payments", name: "Payments" });
  await call("POST", "/services", {
    id: "pay",
    name: "Pay",
    groups: ["payments"],
  });
  await call("POST", "/services", { id: "shop", name: "Shop" });
  for (const [operator, role, scope] of [
    ["vic", "viewer", "global"],
    ["ann", "analyst", "global"],
    ["gina", "analyst", "group:payments"],
  ] as const) {
    const answer = await call("POST", "/role-bindings", {
      operator,
      role,
      scope,
    });
    if (answer.status !== 201)
      throw new Error(`binding ${operator}: ${answer.status}`);
  }
  return test;
}

/** A transport that records what it is sent. */
export function recorder(): LiveTransport & {
  /** Every message, in order. */
  readonly sent: { type: string; data: any; id?: string }[];
  /** The close, when closed. */
  closed?: { code: number; reason: string };
  /** What `buffered()` answers. */
  bufferedBytes: number;
} {
  const transport = {
    sent: [] as { type: string; data: any; id?: string }[],
    closed: undefined as { code: number; reason: string } | undefined,
    bufferedBytes: 0,
    send: (type: string, data: unknown, id?: string) => {
      transport.sent.push({ type, data, ...(id === undefined ? {} : { id }) });
    },
    buffered: () => transport.bufferedBytes,
    close: (code: number, reason: string) => {
      transport.closed = { code, reason };
    },
  };
  return transport;
}

/** Lets pending promises settle. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Bun.sleep(0);
};
