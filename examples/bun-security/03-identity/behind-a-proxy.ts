/**
 * Who the client is: the socket peer, or the address a trusted proxy names;
 * IPv6 keyed by its /64; and a sibling service's verified identity, whose
 * own address is never counted.
 *
 * ```bash
 * bun 03-identity/behind-a-proxy.ts
 * ```
 *
 * - `requestFacts(request, { peer, trustProxy })` is what every integration
 *   builds for the engine; here it is called directly, so each step shows
 *   one request's resolution (`explain().client`).
 * - `trustProxy` is bun-common's (Express's `trust proxy`): a list of
 *   ranges, a hop count, or a preset. An `X-Forwarded-For` from a peer it
 *   does not trust is never read.
 * - A service token is checked against its SHA-256 in the policy (the token
 *   itself never is in the policy). With `forwardsClientIp`, the end user it
 *   names in `x-service-client-ip` becomes the client.
 */
import { createHash } from "node:crypto";
import { createSecurity, requestFacts } from "@kingsleyweb/bun-security";
import type { RequestFactsInit } from "@kingsleyweb/bun-security";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("client identity behind a proxy");

/** The pay service's token: in real life, a secret from its environment. */
const PAY_TOKEN = "pay-api-token-0123456789abcdef";

const security = createSecurity({
  policy: {
    lists: [{ ip: "203.0.113.0/24", action: "block" }],
    serviceIdentity: {
      services: [
        {
          id: "pay-api",
          verifier: `sha256:${createHash("sha256").update(PAY_TOKEN).digest("hex")}`,
          forwardsClientIp: true,
        },
      ],
    },
  },
  logger: () => {},
});

/** The engine's view of one request: who the client is, and its verdict. */
async function resolve(
  headers: Record<string, string>,
  init: RequestFactsInit,
) {
  const facts = requestFacts(
    new Request("http://app.test/", { headers }),
    init,
  );
  const { decision, client } = await security.explain(facts);
  return {
    address: client.address,
    source: client.source,
    key: client.key,
    action: decision.action,
  };
}

/* ------------------------------------------------------------------ */
step(
  "behind a trusted proxy (10.0.0.0/8): the forwarded address is the client",
);
const proxied = await resolve(
  { "x-forwarded-for": "198.51.100.20" },
  { peer: "10.0.0.5", trustProxy: ["10.0.0.0/8"] },
);
show("resolved", proxied);
checkEqual("the client", proxied.address, "198.51.100.20");
checkEqual("from the trusted proxy", proxied.source, "trusted-proxy");

const listed = await resolve(
  { "x-forwarded-for": "203.0.113.9" },
  { peer: "10.0.0.5", trustProxy: ["10.0.0.0/8"] },
);
checkEqual(
  "a listed client behind the proxy is refused",
  listed.action,
  "block",
);

/* ------------------------------------------------------------------ */
step("a spoofed X-Forwarded-For from an untrusted peer is never read");
const spoofed = await resolve(
  { "x-forwarded-for": "198.51.100.99" },
  { peer: "203.0.113.9", trustProxy: ["10.0.0.0/8"] },
);
show("resolved", spoofed);
checkEqual("the peer is the client", spoofed.address, "203.0.113.9");
checkEqual("and it is still refused", spoofed.action, "block");

/* ------------------------------------------------------------------ */
step("an IPv4 client on a dual-stack listener, and IPv6 by its /64");
const mapped = await resolve({}, { peer: "::ffff:203.0.113.5" });
checkEqual("::ffff:203.0.113.5 is 203.0.113.5", mapped.address, "203.0.113.5");
checkEqual("…so the IPv4 entry matches it", mapped.action, "block");
const a = await resolve({}, { peer: "2001:db8:1:2::a" });
const b = await resolve({}, { peer: "2001:db8:1:2:ffff:1:2:3" });
show("two addresses of one /64", [a.key, b.key]);
checkEqual("one key", a.key, b.key);

/* ------------------------------------------------------------------ */
step("a sibling service: verified by its token, forwarding its end user");
const service = await resolve(
  { "x-service-token": PAY_TOKEN, "x-service-client-ip": "198.51.100.30" },
  { peer: "10.1.2.3" },
);
show("resolved", service);
checkEqual("the end user is the client", service.address, "198.51.100.30");
checkEqual("named by the service", service.source, "service");
const wrong = await resolve(
  { "x-service-token": "a-guess", "x-service-client-ip": "198.51.100.30" },
  { peer: "198.51.100.40" },
);
checkEqual(
  "a wrong token is an ordinary client",
  wrong.address,
  "198.51.100.40",
);

security.close();
summary();
