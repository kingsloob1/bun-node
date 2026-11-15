/**
 * The built-in `internal` list (layers.md L3.1): ranges whose requests are
 * internal hops or have lost their client address, so refusing them could
 * refuse everyone behind them. ConcaveHR always allowed the same set
 * (write-up §2.0).
 */

/**
 * The ranges of the `internal` list: loopback, RFC 1918, carrier-grade NAT
 * (`100.64.0.0/10`, Railway's private network and edge hops), IPv4
 * link-local, IPv6 loopback, unique local and link-local.
 */
export const INTERNAL_RANGES: readonly string[] = Object.freeze([
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
]);
