import type { FetchLike } from "../../../app/api/client";
import type { JobUiHarness, JobUiHarnessModule } from "../job/integrationSteps";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  createJobsApi,
  JOBS_API_ACTIONS,
  MemoryDriver,
} from "@kingsleyweb/bun-jobs";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { native } from "../register-dom";

/**
 * The job screen and the add-job dialog against a REAL `createJobsApi`
 * (memory driver, `jobs.add` and `jobs.update` opted in, one defined job),
 * driven through the rendered UI. After each step the API's own state is
 * read back through the driver, so this proves the requests the UI builds
 * are the ones the API accepts and acts on.
 *
 * This project compiles without the DOM lib, so the TSX harness is loaded at
 * run time; its interface comes from the DOM-free `integrationSteps.ts`.
 */

const CSRF = "x-bun-jobs-csrf";
const BASE = "/jobs-api";

/** The harness module, loaded without letting the type-checker follow it. */
const HARNESS_URL = new URL("../job/integrationHarness.tsx", import.meta.url)
  .href;
const harnessModule = (await import(HARNESS_URL)) as JobUiHarnessModule;
harnessModule.installDom();

const jobs = new BunJobs({
  namespace: "ui-job-integration",
  driver: new MemoryDriver(),
});
jobs.define("send-welcome", async () => "sent");

const api = createJobsApi({
  jobs,
  basePath: BASE,
  authorize: () => true,
  logger: noopLogger,
  limits: { queueCacheMs: 0 },
  csrf: { header: CSRF },
  // An allow-list: every action, the opt-ins jobs.add and jobs.update included.
  actions: [...JOBS_API_ACTIONS],
});
// The add route answers 404 QUEUE_NOT_FOUND for a queue the backend does not
// know yet (no job was ever added), so the queue is seeded first.
await jobs.queue("emails").add("send-welcome", { seed: true });
const root = new BunRouter();
root.use(api.basePath, api.router);

/**
 * Routes the client's requests into the API, as Bun's own `Request`.
 * `BunRouter.fetch` recognises it by shape, so happy-dom owning the global
 * `Request` does not matter. The signal is dropped: it is happy-dom's
 * `AbortSignal`, which Bun's `Request` refuses.
 */
const fetchShim: FetchLike = async (input, init) => {
  const { signal: _signal, ...rest } = init;
  return root.fetch(
    new native.Request(new URL(input, "http://localhost").href, rest),
  );
};

const ui: JobUiHarness = harnessModule.createJobUiHarness({
  fetch: fetchShim,
  csrfHeader: CSRF,
});

afterEach(() => {
  ui.cleanup();
});

afterAll(async () => {
  await jobs.close();
});

/** Makes a job in `queue` that failed an attempt and awaits its retry. */
async function failedJob(queue: string, id: string) {
  await jobs.queue(queue).add("send-welcome", { id }, { jobId: id });
  await jobs.driver.connect();
  const ref = { ns: jobs.namespace, queue };
  const token = "token-1";
  const record = await jobs.driver.claimJob(ref, {
    workerId: "worker-1",
    token,
    lockMs: 60_000,
    now: Date.now(),
  });
  expect(record?.id).toBe(id);
  await jobs.driver.failJob(
    ref,
    id,
    token,
    { name: "Error", message: "smtp down" },
    { retry: true, runAt: Date.now() + 3_600_000 },
    Date.now(),
    5,
  );
}

describe("the job UI against a real createJobsApi", () => {
  const ID = "welcome/ada 1";

  it("adds a job through the dialog (201), then answers the same id with 'already exists' (200)", async () => {
    const toast = await ui.addJob({
      queue: "emails",
      name: "send-welcome",
      data: '{"to":"ada@example.com"}',
      jobId: ID,
    });
    expect(toast).toContain("Job added to emails");
    const job = await jobs.queue("emails").getJob(ID);
    expect(job?.state).toBe("waiting");
    expect(job?.name).toBe("send-welcome");
    expect(job?.data).toEqual({ to: "ada@example.com" });

    ui.cleanup();
    const again = await ui.addJob({
      queue: "emails",
      name: "send-welcome",
      data: '{"to":"someone-else@example.com"}',
      jobId: ID,
    });
    expect(again).toContain("A job with this id already exists");
    expect((await jobs.queue("emails").getJob(ID))?.data).toEqual({
      to: "ada@example.com",
    });
  });

  it("opens the job and updates its priority", async () => {
    const view = await ui.openJob("emails", ID);
    expect(view.heading).toContain("send-welcome");
    expect(view.heading).toContain("Waiting");
    expect(view.id).toBe(ID);

    const updated = await ui.updatePriority(7);
    expect(updated.priority).toBe("7");
    expect((await jobs.queue("emails").getJob(ID))?.priority).toBe(7);
  });

  it("retries a failed job, resetting its attempts", async () => {
    await failedJob("billing", "invoice 9");
    const before = await jobs.queue("billing").getJob("invoice 9");
    expect(before?.state).toBe("failed");
    expect(before?.attemptsMade).toBe(1);

    const view = await ui.openJob("billing", "invoice 9");
    expect(view.heading).toContain("Failed");
    await ui.retry();
    const after = await jobs.queue("billing").getJob("invoice 9");
    expect(after?.state).toBe("waiting");
    expect(after?.attemptsMade).toBe(0);
  });

  it("removes a job and returns to its queue", async () => {
    await ui.openJob("emails", ID);
    expect(await ui.remove()).toBe("/jobs/queues/emails");
    expect(await jobs.queue("emails").getJob(ID)).toBeNull();
  });
});
