/**
 * Q: Why did the spikes inject `undefined` before this folder had its own
 * tsconfig.json? Bun applies legacy (experimental) decorators, and emits
 * design:paramtypes, only from a tsconfig that it uses for the file. Each
* subdirectory has one tsconfig (or none) and the same probe: a provider that injects
 * ModuleRef with @Inject. Each probe runs with its own directory as the
 * working directory: the finding is that the cwd's tsconfig.json decides.
 *
 * Run: bun decorator-config.ts
 */
for (const dir of ["include-empty", "include-covers", "no-decorator-flags", "no-tsconfig-here"]) {
  const at = `${import.meta.dir}/decorator-config/${dir}`;
  await Bun.write(`${at}/probe.ts`, Bun.file(`${import.meta.dir}/decorator-config/probe.ts`));
  const proc = Bun.spawn([process.execPath, "probe.ts"], { cwd: at, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  await proc.exited;
  await Bun.file(`${at}/probe.ts`).delete();
  console.log(`${dir.padEnd(19)} ${(await Bun.file(`${at}/tsconfig.json`).exists()) ? (await Bun.file(`${at}/tsconfig.json`).text()).trim() : "(no tsconfig.json here, though parent directories have ones that enable decorators)"}\n${" ".repeat(20)}-> ${(out || err.split("\n").find((l) => /Error/.test(l)) || "").trim()}`);
}
