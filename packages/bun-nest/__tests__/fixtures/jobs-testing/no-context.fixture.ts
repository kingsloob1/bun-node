/**
 * `runJob` and `drainJobs` on an application with no jobs context, from `NestFactory.create`
 * with `abortOnError` at its default, where `app.get` of what is missing ends the process.
 * `jobsTesting.nest.test.ts` reads what this prints, and the exit code.
 */
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunHttpAdapter } from "../../../lib/BunHttpAdapter";
import { drainJobs, runJob } from "../../../lib/jobs/testing/index";
import "reflect-metadata";

@Module({})
class Empty {}

const app = await NestFactory.create(Empty, new BunHttpAdapter(30000), {
  logger: false,
});
await app.init();

for (const [name, call] of [
  ["runJob", () => runJob(app, "q", "n", {})],
  ["drainJobs", () => drainJobs(app)],
] as const) {
  await call().catch((error: unknown) => {
    console.log(
      `${name} ${(error as Error).name}: ${(error as Error).message}`,
    );
  });
}
console.log("still running");
await app.close();
