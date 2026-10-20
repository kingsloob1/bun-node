// S5: Bun.serve({ unix }): url/port/hostname, an existing file, unlink on stop, fetch({unix}).
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "pr6b-sock-"));
const path = join(dir, "a.sock");
const out: Record<string, unknown> = { bun: Bun.revision };
const S = Bun.serve({ unix: path, fetch: (req) => new Response(`ok ${new URL(req.url).pathname} ${req.headers.get("host")}`) });
out.port = S.port; out.hostname = S.hostname; out.url = String(S.url); out.protocol = (S as any).protocol;
out.address = (S as any).address;
out.fileExists = existsSync(path);
out.body = await fetch("http://localhost/x", { unix: path } as any).then((r) => r.text());
out.pending = S.pendingRequests;
try { const S2 = Bun.serve({ unix: path, fetch: () => new Response("2") }); out.secondOnSamePath = "bound"; S2.stop(true); } catch (e) { out.secondOnSamePath = String(e).slice(0, 100); }
await S.stop(true);
out.fileExistsAfterStop = existsSync(path);
const stale = join(dir, "stale.sock"); writeFileSync(stale, "");
try { const S3 = Bun.serve({ unix: stale, fetch: () => new Response("3") }); out.onExistingRegularFile = "bound"; S3.stop(true); } catch (e) { out.onExistingRegularFile = String(e).slice(0, 100); }
try { const S4 = Bun.serve({ unix: join(dir, "nope", "x.sock"), fetch: () => new Response("4") }); out.missingDir = "bound"; S4.stop(true); } catch (e) { out.missingDir = String(e).slice(0, 100); }
try { const S5 = Bun.serve({ unix: path, hostname: "127.0.0.1", fetch: () => new Response("5") } as any); out.unixPlusHostname = `bound url=${S5.url}`; S5.stop(true); } catch (e) { out.unixPlusHostname = String(e).slice(0, 100); }
console.log(JSON.stringify(out, null, 1));
