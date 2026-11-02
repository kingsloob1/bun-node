// Bun-only reproduction: under `bun --hot`, an atomic save (write a sibling
// file, then rename(2) it over the entry) is not picked up when the entry file
// lies outside the process's cwd. The same save inside the cwd, and an in-place
// write outside it, are picked up. Exits 1 while the bug is present.
//
//   bun bun-repro-hot-rename-outside-cwd.ts
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function trial(insideCwd: boolean, save: "rename" | "in-place") {
  const root = mkdtempSync(join(tmpdir(), "hot-rename-"));
  const cwd = insideCwd ? root : mkdtempSync(join(tmpdir(), "hot-cwd-"));
  const file = join(root, "server.ts");
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const source = (v: string) =>
    `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response(${JSON.stringify(v)}) });\n`;
  writeFileSync(file, source("v1"));
  const child = Bun.spawn([process.execPath, "--hot", file], {
    cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  const get = () =>
    fetch(`http://127.0.0.1:${port}/`)
      .then((r) => r.text())
      .catch(() => undefined);
  for (let i = 0; i < 100 && (await get()) !== "v1"; i++) await Bun.sleep(50);
  if (save === "rename") {
    writeFileSync(`${file}.next`, source("v2"));
    renameSync(`${file}.next`, file);
  } else {
    writeFileSync(file, source("v2"));
  }
  let body: string | undefined;
  for (let i = 0; i < 60; i++) {
    body = await get();
    if (body === "v2") break;
    await Bun.sleep(50);
  }
  child.kill();
  await child.exited;
  rmSync(root, { recursive: true, force: true });
  if (!insideCwd) rmSync(cwd, { recursive: true, force: true });
  return body === "v2";
}

const results = {
  "rename, file inside cwd": await trial(true, "rename"),
  "in-place, file outside cwd": await trial(false, "in-place"),
  "rename, file outside cwd": await trial(false, "rename"),
};
console.log(Bun.version, Bun.revision, process.platform, process.arch);
for (const [name, reloaded] of Object.entries(results)) {
  console.log(`${name}: ${reloaded ? "reloaded" : "NOT reloaded (expected reloaded)"}`);
}
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
