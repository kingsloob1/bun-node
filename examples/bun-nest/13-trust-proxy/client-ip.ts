/**
 * The client's real address in a Nest app behind proxies: Express's
 * `app.set("trust proxy", …)`, the adapter's `trustProxy` and
 * `clientIpHeader` options, `@Ip()`, a host-scoped controller behind a proxy,
 * and a gateway client's `client.data.ip`. Each behaviour is asserted.
 *
 * ```bash
 * bun 13-trust-proxy/client-ip.ts
 * ```
 *
 * - **Off by default**, as on `@nestjs/platform-express`: `@Ip()` is the
 *   socket peer and no `X-Forwarded-*` header is read.
 * - **`app.set("trust proxy", value)`** takes every value Express takes. The
 *   socket here is loopback, so `"loopback"` plays a reverse proxy on the
 *   same host.
 * - **`@Controller({ host })`** matches the forwarded host only from a
 *   trusted proxy.
 * - **Cloudflare** in front: `behindCloudflare({ via: ["loopback"] })` reads
 *   `CF-Connecting-IP`, and only from a chain that checks out.
 * - **Gateways**: `client.data.ip` is the upgrade's `req.ip`; Bun's
 *   `client.remoteAddress` is always the socket peer.
 */
import type { INestApplication } from "@nestjs/common";
import type { OnGatewayConnection } from "@nestjs/websockets";
import { behindCloudflare } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Get, Ip, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

@Controller()
class WhoController {
  @Get("whoami")
  whoami(
    @Ip() ip: string,
    @Req() req: { ips: string[]; protocol: string; hostname: string },
  ) {
    return { ip, ips: req.ips, protocol: req.protocol, hostname: req.hostname };
  }
}

@Controller({ host: "tenant.example" })
class TenantController {
  @Get("tenant")
  tenant() {
    return "tenant";
  }
}

const connected = Promise.withResolvers<{ ip?: string; peer: string }>();

@WebSocketGateway({ path: "/live" })
class LiveGateway implements OnGatewayConnection {
  handleConnection(
    @ConnectedSocket()
    client: { data: { ip?: string }; remoteAddress: string; close: () => void },
  ) {
    connected.resolve({ ip: client.data.ip, peer: client.remoteAddress });
    client.close();
  }

  @SubscribeMessage("noop")
  noop() {
    return undefined;
  }
}

@Module({
  controllers: [WhoController, TenantController],
  providers: [LiveGateway],
})
class AppModule {}

interface WhoAmI {
  ip: string;
  ips: string[];
  protocol: string;
  hostname: string;
}

title("trust proxy in a Nest app");

const forwarded = {
  "X-Forwarded-For": "6.6.6.6, 203.0.113.9",
  "X-Forwarded-Proto": "https",
  "X-Forwarded-Host": "tenant.example",
};

/** Boots the module on `adapter`, on port 0, and returns its base URL. */
async function boot(adapter: BunHttpAdapter): Promise<{
  app: INestApplication;
  base: string;
}> {
  const app = await NestFactory.create(AppModule, adapter, { logger: false });
  app.useWebSocketAdapter(adapter.webSocketAdapter);
  await app.listen(0, "127.0.0.1");
  return { app, base: `http://127.0.0.1:${adapter.listeningPort}` };
}

/* ------------------------------------------------------------------ */
step("Off by default");

const plain = new BunHttpAdapter();
const first = await boot(plain);
const off = (await (
  await fetch(`${first.base}/whoami`, { headers: forwarded })
).json()) as WhoAmI;
show("trust off", off);
checkEqual("@Ip() is the socket peer", off.ip, "127.0.0.1");
checkEqual("req.ips is []", off.ips, []);
checkEqual("X-Forwarded-Proto is ignored", off.protocol, "http");
checkEqual(
  "the host-scoped controller ignores X-Forwarded-Host",
  (await fetch(`${first.base}/tenant`, { headers: forwarded })).status,
  404,
);

/* ------------------------------------------------------------------ */
step('app.set("trust proxy", "loopback")');

(
  first.app as unknown as { set: (setting: string, value: unknown) => void }
).set("trust proxy", "loopback");
const on = (await (
  await fetch(`${first.base}/whoami`, { headers: forwarded })
).json()) as WhoAmI;
show("trusting loopback", on);
checkEqual(
  "@Ip() is the first untrusted address from the right",
  on.ip,
  "203.0.113.9",
);
checkEqual("req.ips: the chain, client first", on.ips, ["203.0.113.9"]);
checkEqual("req.protocol from the trusted proxy", on.protocol, "https");
checkEqual(
  "req.hostname from the trusted proxy",
  on.hostname,
  "tenant.example",
);
const tenant = await fetch(`${first.base}/tenant`, { headers: forwarded });
checkEqual(
  "@Controller({ host }) matches the forwarded host",
  [tenant.status, await tenant.text()],
  [200, "tenant"],
);
checkEqual("adapter.trustProxy reads it", plain.trustProxy, "loopback");
await first.app.close();

/* ------------------------------------------------------------------ */
step("Cloudflare → nginx → app, and a gateway");

const cloudflare = new BunHttpAdapter(0, {
  ...behindCloudflare({ via: ["loopback"] }),
});
const second = await boot(cloudflare);
const viaCloudflare = (await (
  await fetch(`${second.base}/whoami`, {
    headers: {
      "X-Forwarded-For": "198.51.100.23, 162.158.1.2",
      "CF-Connecting-IP": "198.51.100.23",
    },
  })
).json()) as WhoAmI;
checkEqual("@Ip() from CF-Connecting-IP", viaCloudflare.ip, "198.51.100.23");
const bypass = (await (
  await fetch(`${second.base}/whoami`, {
    headers: {
      "X-Forwarded-For": "203.0.113.66",
      "CF-Connecting-IP": "1.1.1.1",
    },
  })
).json()) as WhoAmI;
checkEqual(
  "without Cloudflare in the chain, CF-Connecting-IP is ignored",
  bypass.ip,
  "203.0.113.66",
);

const socket = new WebSocket(
  `ws://127.0.0.1:${cloudflare.listeningPort}/live`,
  {
    headers: {
      "X-Forwarded-For": "198.51.100.23, 162.158.1.2",
      "CF-Connecting-IP": "198.51.100.23",
    },
  },
);
const client = await connected.promise;
show("gateway client", client);
checkEqual(
  "client.data.ip is the client; client.remoteAddress the proxy",
  client,
  { ip: "198.51.100.23", peer: "127.0.0.1" },
);
socket.close();
await second.app.close();

summary();
