/**
 * Layer L2, client identity (layers.md L2.1–L2.4): the client address the
 * trusted-proxy foundation resolved, normalised; the keys derived from it
 * and from `identify()`; and service identity, a verified credential that
 * names a sibling service and, when the policy says so, carries the end-user
 * address the sibling forwards.
 *
 * bun-common's `req.ip` is Express-exact: an IPv4-mapped peer stays mapped,
 * and a malformed X-Forwarded-For entry can become the client. This module
 * normalises the address and falls back to the last good one; both
 * workarounds can go once kingsloob1/bun-node#787 gives a normalised client
 * address.
 */
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import { addressKey, parseAddress } from "../ip/address";
import type { ParsedAddress } from "../ip/address";
import type { CompiledService, PolicyInternals } from "../policy/compile";
import type {
  ClientSource,
  ExplainStep,
  RuleHit,
  SubjectKeys,
} from "./decision";
import type { RequestFacts } from "./facts";

/** The longest key kept as written; longer ones are keyed by their SHA-256 (layers.md L2.3). */
export const MAX_KEY_BYTES = 256;

/** The longest service token read; a longer header is not a token. */
const MAX_TOKEN_LENGTH = 1024;

/** A key bounded to {@link MAX_KEY_BYTES}: as written, or `sha256:<hex>` of it. */
export function boundKey(value: string): string {
  if (
    value.length * 3 <= MAX_KEY_BYTES ||
    Buffer.byteLength(value) <= MAX_KEY_BYTES
  ) {
    return value;
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** What L2 found. */
export interface ResolvedClient {
  /** The client's address, or null when the request counts against nobody. */
  readonly address: ParsedAddress | null;
  /** Where it came from. */
  readonly source: ClientSource;
  /** The verified calling service. */
  readonly service: CompiledService | undefined;
  /** L2's hit: the verified service (`allow`), or an invalid token (`log`). */
  readonly hit: RuleHit | undefined;
  /** The keys. */
  readonly subject: SubjectKeys;
}

/** The service whose verifier matches `token`, compared in constant time per verifier. */
function verifyToken(
  token: string,
  services: readonly CompiledService[],
): CompiledService | undefined {
  const digest = createHash("sha256").update(token).digest();
  let found: CompiledService | undefined;
  // Every verifier is compared, so the time taken does not say which matched.
  for (const service of services) {
    for (const verifier of service.verifiers) {
      if (timingSafeEqual(digest, verifier) && found === undefined) {
        found = service;
      }
    }
  }
  return found;
}

/** The client address from the facts: `client`, or the last good address of the chain. */
function clientFromFacts(facts: RequestFacts): {
  address: ParsedAddress | null;
  source: ClientSource;
} {
  const chain = facts.chain;
  const sourceOf = (index: number): ClientSource => {
    const entry = chain[index];
    if (entry?.source === "header") return "client-ip-header";
    return index === 0 ? "socket" : "trusted-proxy";
  };
  const direct = parseAddress(facts.client);
  if (direct) {
    const last = chain.length - 1;
    return {
      address: direct,
      source:
        last >= 0 && chain[last]?.address === facts.client
          ? sourceOf(last)
          : "socket",
    };
  }
  // A malformed entry ended the walk (layers.md L2.2 item 7): the last good
  // address before it, nearest the client, is the client. (bun-node#787)
  for (let i = chain.length - 1; i >= 0; i--) {
    const address = parseAddress(chain[i]?.address);
    if (address) {
      return { address, source: sourceOf(i) };
    }
  }
  return { address: null, source: "none" };
}

/** Records an explanation step when explaining. */
function step(trace: ExplainStep[] | undefined, value: ExplainStep): void {
  trace?.push(value);
}

/**
 * Resolves the request's client and keys (layer L2). Pure: reads only the
 * facts and the policy.
 */
export function resolveClient(
  facts: RequestFacts,
  policy: PolicyInternals,
  trace?: ExplainStep[],
): ResolvedClient {
  let service: CompiledService | undefined;
  let hit: RuleHit | undefined;
  const token =
    policy.services.length > 0
      ? facts.headers[policy.serviceHeader]
      : undefined;
  if (token !== undefined) {
    service =
      token.length > 0 && token.length <= MAX_TOKEN_LENGTH
        ? verifyToken(token, policy.services)
        : undefined;
    hit = service
      ? {
          layer: "L2",
          rule: `service:${service.id}`,
          action: "allow",
          reason: "verified service identity",
        }
      : {
          layer: "L2",
          rule: "service-identity",
          action: "log",
          reason: "invalid service token",
        };
    step(trace, {
      layer: "L2",
      check: "service-identity",
      rule: hit.rule,
      outcome: service
        ? `verified as service "${service.id}"`
        : `the ${policy.serviceHeader} header matched no service; treated as an ordinary client`,
    });
  }

  let address: ParsedAddress | null;
  let source: ClientSource;
  if (service) {
    const forwarded = service.forwardsClientIp
      ? facts.headers[policy.clientIpHeader]
      : undefined;
    address = forwarded === undefined ? null : parseAddress(forwarded.trim());
    source = address ? "service" : "none";
    step(trace, {
      layer: "L2",
      check: "client",
      outcome: address
        ? `the client is ${address.text}, forwarded by service "${service.id}" in ${policy.clientIpHeader}`
        : service.forwardsClientIp
          ? `service "${service.id}" forwarded no usable address in ${policy.clientIpHeader}: the request counts against nobody`
          : `service "${service.id}" does not forward client addresses: the request counts against nobody`,
    });
  } else {
    ({ address, source } = clientFromFacts(facts));
    step(trace, {
      layer: "L2",
      check: "client",
      outcome: address
        ? `the client is ${address.text} (${source}${address.text === facts.client ? "" : `, from ${JSON.stringify(facts.client)}`})`
        : "no client address: the request counts against nobody",
    });
  }

  const identity = facts.identity;
  const subject: {
    -readonly [K in keyof SubjectKeys]: SubjectKeys[K];
  } = {};
  if (address) {
    subject.address = address.text;
    subject.ip = addressKey(address, policy.ipv6Prefix);
  }
  if (identity?.user !== undefined) subject.user = boundKey(identity.user);
  if (identity?.session !== undefined)
    subject.session = boundKey(identity.session);
  if (identity?.tenant !== undefined)
    subject.tenant = boundKey(identity.tenant);
  if (identity?.apiKey !== undefined)
    subject.apiKey = boundKey(identity.apiKey);
  if (service) subject.service = service.id;
  return { address, source, service, hit, subject };
}
