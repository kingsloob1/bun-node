import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { BunHttpAdapter, BunWebSocketAdapter } from "../../../../../packages/bun-nest/lib";
const seen: string[] = [];
@WebSocketGateway({ path: "/live" })
class G implements OnGatewayConnection {
  handleConnection() { seen.push("connect"); }
  @SubscribeMessage("ping") ping() { return { event: "pong", data: 1 }; }
}
@Module({ providers: [G] }) class M {}
const owner = new BunHttpAdapter();
await owner.listen(0);
const port = owner.getBunServer()!.port;
const app = await NestFactory.create(M, new BunHttpAdapter(), { logger: false });
app.useWebSocketAdapter(new BunWebSocketAdapter({ httpAdapter: owner, localOptions: { newInstance: false, getServer: () => owner.getBunServer() } }) as any);
await app.init();
async function tryWs() {
  return await new Promise<string>((r) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
    const t = setTimeout(() => r("timeout"), 1500);
    ws.onopen = () => { ws.send(JSON.stringify({ event: "ping", data: 1 })); ws.onmessage = (e) => { clearTimeout(t); r(`open + reply ${e.data}`); ws.close(); }; setTimeout(() => { clearTimeout(t); r("open, no reply"); ws.close(); }, 500); };
    ws.onerror = (e) => { clearTimeout(t); r(`error ${(e as any).message ?? "refused"}`); };
  });
}
const before = await tryWs();
const seenBefore = seen.length;
await app.close();
const after = await tryWs();
const plain = await fetch(`http://127.0.0.1:${port}/live`, { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } }).then((r) => r.status);
console.log(JSON.stringify({ nest: require("@nestjs/core/package.json").version, before, seenBefore, after, seenAfter: seen.length - seenBefore, rawUpgradeStatusAfter: plain }));
await owner.close();
process.exit(0);
