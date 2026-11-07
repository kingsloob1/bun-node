/**
 * Compile-time assertions for `trustProxy` and `clientIpHeader`: every
 * Express `trust proxy` form is accepted on the adapter, the router and the
 * request options; anything else is refused; the helpers' results spread
 * into any of them. Checked by `bun run check`, not by `bun test`.
 *
 * Every `@ts-expect-error` is a guard: if the error stops appearing, the
 * check fails on the unused directive.
 */
import type {
  BunRequestOptions,
  ProxyChainEntry,
  ProxyTrustSettings,
  TrustProxyFn,
  TrustProxyOption,
} from "../lib";
import {
  behindCloudflare,
  behindRailway,
  BunHttpAdapter,
  BunRouter,
  CLOUDFLARE_IP_RANGES,
  trustChain,
} from "../lib";

const values: TrustProxyOption[] = [
  false,
  true,
  2,
  "loopback",
  "loopback, 10.0.0.0/8",
  ["127.0.0.1", "10.0.0.0/255.0.0.0"],
  CLOUDFLARE_IP_RANGES,
  (addr: string, i: number) => addr.startsWith("10.") || i === 0,
  trustChain([true, "loopback", CLOUDFLARE_IP_RANGES]),
];
void values;

// @ts-expect-error -- not an Express `trust proxy` value
const notAValue: TrustProxyOption = { ranges: ["10.0.0.0/8"] };
void notAValue;
// @ts-expect-error -- an array of addresses holds strings only
const mixed: TrustProxyOption = [2, "loopback"];
void mixed;
// @ts-expect-error -- the function returns a boolean
const notBoolean: TrustProxyFn = () => "yes";
void notBoolean;

void [
  new BunHttpAdapter(0, {
    trustProxy: "loopback",
    clientIpHeader: "x-real-ip",
  }),
  new BunHttpAdapter(0, { ...behindCloudflare({ via: ["loopback"] }) }),
  new BunHttpAdapter(0, { ...behindRailway({ cloudflare: true }) }),
  new BunHttpAdapter(0, { request: { trustProxy: 1 } }),
  new BunRouter({ trustProxy: true }),
  // @ts-expect-error -- the header is a name, not a list
  new BunRouter({ clientIpHeader: ["x-real-ip"] }),
];

const settings: ProxyTrustSettings = behindRailway();
const requestOptions: Partial<NonNullable<BunRequestOptions>> = settings;
void requestOptions;

const adapter = new BunHttpAdapter(0);
const current: TrustProxyOption | undefined = adapter.trustProxy;
void current;
adapter.trustProxy = 1;
adapter.get("/", (req) => {
  const ip: string = req.ip;
  const ips: string[] = req.ips;
  const chain: readonly ProxyChainEntry[] = req.proxyChain;
  const source: "socket" | "x-forwarded-for" | "header" | undefined =
    chain[0]?.source;
  const host: string | undefined = req.forwardedHost;
  void [ip, ips, source, host];
  // @ts-expect-error -- the chain is read-only
  req.proxyChain.push({ address: "x", source: "header", trusted: true });
});
