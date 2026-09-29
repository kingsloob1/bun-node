/**
 * What the *current* bun-common adapter answers for the same probes as
 * semantics.ts — the behaviour a native-routes variant must reproduce.
 * Runs through `adapter.fetch()`, which is the production path.
 *
 *   bun docs/plans/evidence/bun-native-routes/spikes/bunrouter-baseline.ts
 */
import type { RouterHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const adapter = new BunHttpAdapter(0, {});
const tag = (key: string): RouterHandler => (req, res) => {
  res.json({ by: key, method: req.method, params: req.params });
};
adapter.get("/users/:id", tag("/users/:id"));
adapter.get("/users/new", tag("/users/new"));
adapter.get("/files/*", tag("/files/*"));
adapter.get("/named/*rest", tag("/named/*rest"));
adapter.get("/a", tag("/a"));
adapter.get("/b/", tag("/b/"));
adapter.get("/Case", tag("/Case"));
adapter.get("/p/:x", tag("/p/:x"));
adapter.get("/opt/:a?", tag("/opt/:a?"));
adapter.get("/re/:id(\\d+)", tag("/re/:id(\\d+)"));
adapter.get("/m", tag("/m GET"));
adapter.post("/m", tag("/m POST"));

const probes: [string, string][] = [
  ["GET", "/users/new"], ["GET", "/users/42"], ["GET", "/users/42/"], ["GET", "/files"], ["GET", "/files/"],
  ["GET", "/files/a/b%20c"], ["GET", "/named/x/y"], ["GET", "/a"], ["GET", "/a/"], ["GET", "/b"], ["GET", "/b/"],
  ["GET", "/case"], ["GET", "/Case"], ["GET", "/p/hello%20world"], ["GET", "/p/a%2Fb"], ["GET", "/p/%zz"],
  ["GET", "/p/"], ["GET", "/opt"], ["GET", "/opt/1"], ["GET", "/re/12"], ["GET", "/re/abc"],
  ["GET", "/m"], ["HEAD", "/m"], ["POST", "/m"], ["PUT", "/m"], ["OPTIONS", "/m"], ["GET", "//a"], ["GET", "/a?x=1"],
];
console.log(`Bun ${Bun.version} (${Bun.revision}); BunHttpAdapter defaults (caseSensitive: true)\n`);
for (const [method, path] of probes) {
  const res = await adapter.fetch(path, { method });
  const body = (await res.text()).replace(/\n/g, " ").slice(0, 110);
  console.log(`${method.padEnd(7)} ${path.padEnd(18)} -> ${res.status} ${body}`);
}
