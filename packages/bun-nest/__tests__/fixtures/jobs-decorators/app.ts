/**
 * Boots `BunJobsModule` in a process of its own, from a working directory the
 * test chooses: Bun reads the decorator options from it (oven-sh/bun#28605),
 * so that directory's tsconfig decides what this file's decorators do.
 *
 * `argv[2]` is `"syntax"` (a service injected with `@InjectQueue` as syntax,
 * which that tsconfig can silently drop) or `"by-call"` (the same service with
 * the decorator applied by call, which it cannot). Prints one `RESULT=` line.
 */
import type { BunQueue } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { MemoryDriver } from "@kingsleyweb/bun-jobs";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { BunJobsModule, InjectQueue } from "../../../lib/jobs/index";

/** A provider with its queue injected by decorator syntax. */
class WithSyntax {
  constructor(@InjectQueue("q") readonly queue: BunQueue) {}
}

/** The same provider, with the decorator applied by call. */
class ByCall {
  constructor(readonly queue: BunQueue) {}
}
InjectQueue("q")(ByCall, undefined, 0);

const provider = process.argv[2] === "syntax" ? WithSyntax : ByCall;

class AppModule {}
Module({
  imports: [
    BunJobsModule.forRoot({
      namespace: "decorators",
      driver: new MemoryDriver(),
    }),
    BunJobsModule.registerQueue({ name: "q" }),
  ],
  providers: [provider],
})(AppModule);

try {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const injected = app.get(provider).queue as BunQueue | undefined;
  console.log(`RESULT=ok queue=${injected?.name ?? "undefined"}`);
  await app.close();
} catch (error) {
  console.log(`RESULT=${(error as Error).name}: ${(error as Error).message}`);
}
process.exit(0);
