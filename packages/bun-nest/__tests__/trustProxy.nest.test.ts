/**
 * `trust proxy` on a Nest app over bun-nest: the adapter option,
 * `app.set("trust proxy", …)` as on `@nestjs/platform-express`, `@Ip()`,
 * host-scoped controllers behind a trusted proxy, and the adapter's router
 * carrying the setting (its `fetch()`, dedicated WebSocket servers). The
 * value-for-value comparison with Express is `trustProxy.express.test.ts`
 * and the `trust-proxy-*` groups of `expressCompat.nest.test.ts`.
 */
import type { INestApplication } from "@nestjs/common";
import { behindCloudflare } from "@kingsleyweb/bun-common";
import { Controller, Get, Ip, Module, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

@Controller()
class WhoController {
  @Get("who")
  who(
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

@Module({ controllers: [WhoController, TenantController] })
class WhoModule {}

const FORWARDED = {
  "x-forwarded-for": "203.0.113.9, 10.0.0.4",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "tenant.example",
};

describe("trust proxy on a Nest app", () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** Boots the module on a fresh adapter and listens on loopback. */
  async function boot(adapter = new BunHttpAdapter()) {
    app = await NestFactory.create(WhoModule, adapter, { logger: false });
    return adapter;
  }

  /** GETs `path` on the listening app with the forwarded headers. */
  async function get(adapter: BunHttpAdapter, path: string) {
    return fetch(`http://127.0.0.1:${adapter.listeningPort}${path}`, {
      headers: FORWARDED,
    });
  }

  it("is off by default: @Ip() is the peer and nothing forwarded is read", async () => {
    const adapter = await boot();
    await app!.listen(0, "127.0.0.1");
    const res = await get(adapter, "/who");
    expect(await res.json()).toEqual({
      ip: "127.0.0.1",
      ips: [],
      protocol: "http",
      hostname: "127.0.0.1",
    });
    expect((await get(adapter, "/tenant")).status).toBe(404);
  });

  it('app.set("trust proxy", "loopback") reads the forwarded client, proto and host', async () => {
    const adapter = await boot();
    (app as unknown as { set: (s: string, v: unknown) => unknown }).set(
      "trust proxy",
      "loopback, 10.0.0.0/8",
    );
    await app!.listen(0, "127.0.0.1");
    expect(await (await get(adapter, "/who")).json()).toEqual({
      ip: "203.0.113.9",
      ips: ["203.0.113.9", "10.0.0.4"],
      protocol: "https",
      hostname: "tenant.example",
    });
    // @Controller({ host }) matches the trusted forwarded host, as on Express.
    const tenant = await get(adapter, "/tenant");
    expect(tenant.status).toBe(200);
    expect(await tenant.text()).toBe("tenant");
  });

  it("the adapter option, and enable(), set the same setting on the router", async () => {
    const adapter = new BunHttpAdapter(0, { trustProxy: 1 });
    expect(adapter.trustProxy).toBe(1);
    expect(adapter.getInstance().trustProxy).toBe(1);
    expect(adapter.requestOpts.trustProxy).toBe(1);
    adapter.enable("trust proxy");
    expect(adapter.getInstance().trustProxy).toBe(true);
    adapter.setRequestOpts({ parseBody: false });
    expect(adapter.requestOpts.trustProxy).toBe(true);
    expect(() => adapter.set("trust proxy", "999.0.0.0/8")).toThrow(TypeError);
    expect(adapter.trustProxy).toBe(true);
  });

  it("behindCloudflare() spreads into the adapter's options", async () => {
    const adapter = new BunHttpAdapter(0, {
      ...behindCloudflare({ via: ["loopback"] }),
    });
    await boot(adapter);
    await app!.listen(0, "127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${adapter.listeningPort}/who`, {
      headers: {
        "x-forwarded-for": "198.51.100.23, 162.158.1.2",
        "cf-connecting-ip": "198.51.100.23",
      },
    });
    expect(((await res.json()) as { ip: string }).ip).toBe("198.51.100.23");
    // Not through Cloudflare: its header is not believed.
    const direct = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/who`,
      {
        headers: {
          "x-forwarded-for": "203.0.113.66",
          "cf-connecting-ip": "1.1.1.1",
        },
      },
    );
    expect(((await direct.json()) as { ip: string }).ip).toBe("203.0.113.66");
  });

  it("adapter.fetch() with a remoteAddress reaches @Ip() through trust proxy, without a socket", async () => {
    const adapter = new BunHttpAdapter(0, { trustProxy: "10.0.0.0/8" });
    await boot(adapter);
    await app!.init();
    const ask = async (remoteAddress: string) =>
      (await (
        await adapter.fetch("/who", { headers: FORWARDED, remoteAddress })
      ).json()) as { ip: string; protocol: string };

    // From a trusted proxy: the forwarded client and protocol.
    expect(await ask("10.0.0.5")).toMatchObject({
      ip: "203.0.113.9",
      protocol: "https",
    });
    // Negative control: from a peer outside the range, the headers are a
    // client's claim and @Ip() is the peer.
    expect(await ask("198.51.100.7")).toMatchObject({
      ip: "198.51.100.7",
      protocol: "http",
    });
  });
});
