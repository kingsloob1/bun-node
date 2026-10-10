/**
 * Child for boot-cost.ts: what a worker-thread or child-process attempt would
 * have to do before it could call a DI-built processor — load Nest and
 * bun-jobs, build a small application context, resolve the processor — then
 * report the time and exit. `--bare` skips Nest: just bun-jobs' import.
 */
import "reflect-metadata";
const t0 = performance.now();
const bare = process.argv.includes("--bare");
const { BunJobs } = await import("@kingsleyweb/bun-jobs");
let result = "bare";
if (!bare) {
  const { Inject, Injectable, Module } = await import("@nestjs/common");
  const { NestFactory } = await import("@nestjs/core");
  @Injectable() class Config { url = "memory://"; }
  @Injectable() class Repo { constructor(@Inject(Config) readonly config: Config) {} }
  @Injectable() class EmailProcessor { constructor(@Inject(Repo) readonly repo: Repo) {} handle(data: { to: string }) { return `sent:${data.to}`; } }
  @Module({ providers: [Config, Repo, EmailProcessor] }) class WorkerModule {}
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
  result = app.get(EmailProcessor).handle({ to: "ada@example.com" });
  await app.close();
}
void BunJobs;
const ms = performance.now() - t0;
if (!Bun.isMainThread) {
  (globalThis as unknown as Worker).postMessage({ ms, result });
} else {
  console.log(JSON.stringify({ ms, result }));
}
