/**
 * Shallow size and own-property count of each per-request object, from
 * JavaScriptCore (`bun:jsc` estimateShallowMemoryUsageOf). Size matters
 * beyond the constructor's time: every field is written per request, and a
 * served request runs with cold caches (results/inproc-pollute.txt).
 *
 *   NODE_ENV=production BUN_OPTIONS= PKG_ROOT=<snapshot> bun sizes.ts
 */
import { estimateShallowMemoryUsageOf } from "bun:jsc";
import process from "node:process";

const PKG_ROOT = process.env.PKG_ROOT ?? "@kingsleyweb";
const { BunHttpAdapter, BunRequest, BunResponse } = (await import(`${PKG_ROOT}/bun-common`)) as typeof import("@kingsleyweb/bun-common");
const stub = { requestIP: () => null, upgrade: () => false, port: 0 } as never;
const native = new Request("http://localhost/user/42");
const req = BunRequest.init(native, stub, new BunHttpAdapter(0).requestOpts) as InstanceType<typeof BunRequest>;
const res = new BunResponse(req, { etag: false });
res.send("42");
class Context {
  request: Request;
  set: { headers: Record<string, string>; status: number | undefined; cookie: unknown };
  qi = -1;
  path = "";
  server: unknown = null;
  params: Record<string, string> = {};
  constructor(request: Request) {
    this.request = request;
    this.set = { headers: Object.create(null), status: undefined, cookie: undefined };
  }
}
const ctx = new Context(native);
const row = (name: string, o: object, fields: number) =>
  console.log(`${name.padEnd(44)} ${String(estimateShallowMemoryUsageOf(o)).padStart(6)} bytes  ${String(fields).padStart(4)} fields`);
// Private (#) fields are not own properties; count them from the class source.
const privateFields = async (file: string, cls: string) => {
  const src = await Bun.file(file).text();
  const start = src.indexOf(`export class ${cls}`);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  return (body.match(/^ {2}(?:readonly )?#[A-Za-z_]+\s*[:=;?]/gm) ?? []).length;
};
const root = Bun.resolveSync(`${PKG_ROOT}/bun-common`, import.meta.dir).replace(/index\.ts$/, "");
console.log(`Bun ${Bun.version}\n`);
row("BunRequest (after init, GET, defaults)", req, Object.keys(req).length + (await privateFields(`${root}BunRequest.ts`, "BunRequest")));
row("BunResponse (after send)", res, Object.keys(res).length + (await privateFields(`${root}BunResponse.ts`, "BunResponse")));
row("Elysia 2-shaped Context (+ set record)", ctx, Object.keys(ctx).length);
row("  its set record", ctx.set, 3);
row("native Request", native, 0);
row("native Response('42')", new Response("42"), 0);
console.log(`\npublic own keys: BunRequest ${Object.keys(req).length}, BunResponse ${Object.keys(res).length}`);
