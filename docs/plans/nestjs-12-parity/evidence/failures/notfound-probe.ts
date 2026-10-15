// Usage (cwd = <repo>/packages/bun-nest): bun <this> <repo> <group> <path> [method] [body]
import "reflect-metadata";
const [repo, groupName, path, method, body] = process.argv.slice(2);
const base = `${repo}/packages/bun-nest/__tests__/expressCompat`;
const { GROUPS } = await import(`${base}/probes.ts`);
const { bootBoth, observe } = await import(`${base}/app.ts`);
const group = GROUPS.find((g: { name: string }) => g.name === groupName);
const apps = await bootBoth(group.module, group.configure, group.options);
const init: RequestInit = method ? { method, body, headers: body ? { "content-type": "application/json" } : {} } : {};
for (const side of ["express", "bun"] as const) {
  const o = await observe(apps[side].base, path, init);
  console.log(side, o.status, JSON.stringify(o.headers["content-type"]), JSON.stringify(o.body));
}
await apps.express.app.close();
await apps.bun.app.close();
process.exit(0);
