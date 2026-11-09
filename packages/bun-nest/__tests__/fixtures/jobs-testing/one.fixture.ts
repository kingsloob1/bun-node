/**
 * One of two files `jobsTesting.nest.test.ts` runs in parallel, each on queue "shared": all
 * it sees is its own jobs.
 */
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { expect, it } from "bun:test";
import { getBunJobsToken, Process, Processor } from "../../../lib/jobs/index";
import { BunJobsTestingModule, runJob } from "../../../lib/jobs/testing/index";
import "reflect-metadata";

@Processor("shared")
class Shared {
  @Process()
  run() {
    return "one";
  }
}

@Module({ providers: [Shared] })
class SharedModule {}

it("sees only its own jobs", async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [BunJobsTestingModule.forRoot({ logger: false }), SharedModule],
  }).compile();
  const app = await moduleRef.init();
  try {
    for (let index = 0; index < 20; index++) {
      expect((await runJob(app, "shared", "x", {})).result).toBe("one");
    }
    const jobs = app.get(getBunJobsToken(), { strict: false });
    expect(await jobs.queue("shared").count("completed")).toBe(20);
  } finally {
    await app.close();
  }
});
