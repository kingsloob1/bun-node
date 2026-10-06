process.env.ROUTES = "1000";
const lib = await import("../../../../../packages/bun-common/lib/index.ts");
const { registerExpressStyle } = await import("../../../../../docs/plans/evidence/bun-native-routes/bench/servers.ts");
const stub = { requestIP: () => null, upgrade: () => false } as never;
const app = new lib.BunHttpAdapter(0);
registerExpressStyle(app as never);
const which = process.argv[2];
let seq = 10_000_000;
const rs = Array.from({ length: 256 }, () => new Request(`http://localhost${which === "async" ? "/async" : which === "headers" ? "/headers" : which === "static" ? "/static" : "/r999/7"}`));
for (let i = 0; i < 600_000; i++) {
  const r = which === "random" ? new Request(`http://localhost/r999/${seq++}`) : rs[i & 255];
  const x = (app as any).serveNativeRequest(r, stub);
  if (x instanceof Promise) await x;
}
