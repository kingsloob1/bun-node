/**
 * The client's real address behind proxies: `trustProxy` (Express 5's
 * `trust proxy`, value for value) and `clientIpHeader`, over a real socket.
 * Each behaviour is asserted.
 *
 * ```bash
 * bun 15-trust-proxy/client-ip.ts
 * ```
 *
 * - **The walk.** The request's chain is the socket peer, then
 *   `X-Forwarded-For` from right to left. `req.ip` is the first address
 *   `trustProxy` does not trust. It is never simply the left-most entry, which
 *   the client wrote. `req.ips` is the chain without the socket, client
 *   first; `req.proxyChain` marks each address trusted or not.
 * - **Off by default.** `req.ip` is the peer, `req.ips` is `[]`, and
 *   `X-Forwarded-Proto` and `X-Forwarded-Host` are ignored.
 * - **A client address header** (`CF-Connecting-IP`) is believed only when
 *   every address of the chain is trusted, so a request that skipped the
 *   proxy setting it cannot choose its own `req.ip`.
 * - **Cloudflare → Railway → app.** Here the socket is loopback, so it plays
 *   Railway's proxy: `behindCloudflare({ via: ["loopback", true] })` is
 *   `behindRailway({ cloudflare: true })` with the first hop checked by
 *   address instead of position.
 * - **WebSockets.** An upgrade carries its `req.ip` as `ws.data.ip`.
 */
import {
  behindCloudflare,
  BunHttpAdapter,
  CLOUDFLARE_IP_RANGES_DATE,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("The client's address behind proxies");

const adapter = new BunHttpAdapter(0, { logger: () => {} });
adapter.get("/whoami", (req, res) =>
  res.json({
    ip: req.ip,
    ips: req.ips,
    protocol: req.protocol,
    hostname: req.hostname,
    chain: req.proxyChain.map(
      (hop) =>
        `${hop.address} (${hop.source}${hop.trusted ? ", trusted" : ""})`,
    ),
  }),
);
await adapter.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${adapter.listeningPort}`;

interface WhoAmI {
  ip: string;
  ips: string[];
  protocol: string;
  hostname: string;
  chain: string[];
}

/** GETs `/whoami` with `headers`, as if through proxies that set them. */
async function whoami(headers: Record<string, string>): Promise<WhoAmI> {
  const res = await fetch(`${base}/whoami`, {
    headers: { host: "origin.test", ...headers },
  });
  return (await res.json()) as WhoAmI;
}

const forwarded = {
  "X-Forwarded-For": "6.6.6.6, 203.0.113.9, 10.0.0.2",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "app.example.com",
};

/* ------------------------------------------------------------------ */
step("Off by default: the socket peer, nothing forwarded");

const off = await whoami(forwarded);
show("trust off", off);
checkEqual("req.ip is the socket peer", off.ip, "127.0.0.1");
checkEqual("req.ips is []", off.ips, []);
checkEqual("X-Forwarded-Proto is ignored", off.protocol, "http");
checkEqual("X-Forwarded-Host is ignored", off.hostname, "origin.test");

/* ------------------------------------------------------------------ */
step('set("trust proxy", "loopback, 10.0.0.0/8"): the walk');

adapter.set("trust proxy", "loopback, 10.0.0.0/8");
const walked = await whoami(forwarded);
show("trusting loopback and 10/8", walked);
checkEqual(
  "req.ip is the first untrusted address from the right",
  walked.ip,
  "203.0.113.9",
);
checkEqual(
  "not the left-most entry, the client's own claim",
  walked.ip !== "6.6.6.6",
  true,
);
checkEqual("req.ips: client first, socket left out", walked.ips, [
  "203.0.113.9",
  "10.0.0.2",
]);
checkEqual("req.protocol from a trusted peer", walked.protocol, "https");
checkEqual(
  "req.hostname from a trusted peer",
  walked.hostname,
  "app.example.com",
);
checkEqual("req.proxyChain", walked.chain, [
  "127.0.0.1 (socket, trusted)",
  "10.0.0.2 (x-forwarded-for, trusted)",
  "203.0.113.9 (x-forwarded-for)",
]);

adapter.set("trust proxy", 1);
checkEqual(
  "a hop count: 1 trusts the socket only",
  (await whoami(forwarded)).ip,
  "10.0.0.2",
);
check(
  "a bad value throws Express's TypeError and changes nothing",
  (() => {
    try {
      adapter.set("trust proxy", "10.0.0.0/0");
      return false;
    } catch (error) {
      return error instanceof TypeError && adapter.trustProxy === 1;
    }
  })(),
);

/* ------------------------------------------------------------------ */
step("Cloudflare → Railway → app");

// Cloudflare connected to Railway from one of its edge addresses and put
// the client in CF-Connecting-IP; Railway's edge rewrote X-Forwarded-For to
// `<its client>, <itself>`. The loopback socket plays Railway's proxy.
const settings = behindCloudflare({ via: ["loopback", true] });
adapter.trustProxy = settings.trustProxy;
adapter.clientIpHeader = settings.clientIpHeader;
show(`Cloudflare's ranges as of ${CLOUDFLARE_IP_RANGES_DATE}`);

const real = await whoami({
  "X-Forwarded-For": "172.68.10.20, 34.120.0.8",
  "CF-Connecting-IP": "198.51.100.23",
});
show("through Cloudflare and Railway", real);
checkEqual(
  "req.ip is the client, from CF-Connecting-IP",
  real.ip,
  "198.51.100.23",
);
checkEqual("req.ips: the header leads the chain", real.ips, [
  "198.51.100.23",
  "172.68.10.20",
  "34.120.0.8",
]);

const spoofed = await whoami({
  "X-Forwarded-For": "203.0.113.66, 34.120.0.8",
  "CF-Connecting-IP": "1.1.1.1",
});
show("sent to Railway directly, claiming 1.1.1.1", spoofed);
checkEqual(
  "the header is ignored: hop 2 is not a Cloudflare address",
  spoofed.ip,
  "203.0.113.66",
);

/* ------------------------------------------------------------------ */
step("WebSockets: ws.data.ip");

const opened = Promise.withResolvers<string | undefined>();
adapter.ws("/live", {
  message() {},
  open(ws) {
    opened.resolve(ws.data.ip);
    ws.close();
  },
});
const socket = new WebSocket(`ws://127.0.0.1:${adapter.listeningPort}/live`, {
  headers: {
    "X-Forwarded-For": "172.68.10.20, 34.120.0.8",
    "CF-Connecting-IP": "198.51.100.23",
  },
});
checkEqual(
  "ws.data.ip is the upgrade's req.ip",
  await opened.promise,
  "198.51.100.23",
);
socket.close();

/* ------------------------------------------------------------------ */
step("Socket-free fetch(): no peer");

adapter.trustProxy = "loopback";
adapter.clientIpHeader = undefined;
const socketFree = (await (
  await adapter.fetch("/whoami", {
    headers: { "X-Forwarded-For": "203.0.113.9" },
  })
).json()) as WhoAmI;
checkEqual(
  "a range never matches the missing peer: req.ip is ''",
  socketFree.ip,
  "",
);
await checkRejects(
  "an unknown preset is refused at construction",
  async () => new BunHttpAdapter(0, { trustProxy: "lan" }),
  { name: "TypeError" },
);

await adapter.close();
summary();
