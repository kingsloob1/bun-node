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
// No seeding: adding an addable name creates its queue (the first job of a
// brand-new queue is the dialog's own).
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

/**
 * Adds a waiting job through the API's own queue. Each test that needs a job
 * makes its own, so none depends on another having run first (`bun test
 * --randomize` reorders them).
 */
async function waitingJob(queue: string, id: string) {
  await jobs.queue(queue).add("send-welcome", { id }, { jobId: id });
  expect((await jobs.queue(queue).getJob(id))?.state).toBe("waiting");
}

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
    const id = "welcome/grace 2";
    await waitingJob("emails", id);
    const view = await ui.openJob("emails", id);
    expect(view.heading).toContain("send-welcome");
    expect(view.heading).toContain("Waiting");
    expect(view.id).toBe(id);

    const updated = await ui.updatePriority(7);
    expect(updated.priority).toBe("7");
    expect((await jobs.queue("emails").getJob(id))?.priority).toBe(7);
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
    const id = "welcome/linus 3";
    await waitingJob("emails", id);
    await ui.openJob("emails", id);
    expect(await ui.remove()).toBe("/jobs/queues/emails");
    expect(await jobs.queue("emails").getJob(id)).toBeNull();
  });

  it("fails a waiting job through the dialog: the API reads it back dead, with the reason", async () => {
    const id = "welcome/fail 4";
    await waitingJob("emails", id);
    const view = await ui.openJob("emails", id);
    expect(view.heading).toContain("Waiting");
    const toast = await ui.fail("customer cancelled", id);
    expect(toast).toContain("Job failed");
    const after = await jobs.queue("emails").getJob(id);
    expect(after?.state).toBe("dead");
    expect(after?.failedReason?.message).toBe("customer cancelled");
    // Read afresh, the screen shows it dead.
    expect((await ui.openJob("emails", id)).heading).toContain("Dead");
  });

  it("disables then enables a real repeat series, reading `disabled` back", async () => {
    const queue = jobs.queue("digests");
    await queue.add(
      "send-welcome",
      {},
      { repeat: { every: 60_000, key: "hourly" } },
    );
    const series = async () =>
      (await queue.listRepeatables()).find((record) => record.key === "hourly");
    expect((await series())?.disabled ?? false).toBe(false);
    const pending = (await series())!.nextJobId!;
    expect(await queue.getJob(pending)).not.toBeNull();

    await ui.toggleRepeatable("digests", "hourly", "disable");
    expect((await series())?.disabled).toBe(true);
    // Its pending occurrence went with it.
    expect(await queue.getJob(pending)).toBeNull();

    ui.cleanup();
    await ui.toggleRepeatable("digests", "hourly", "enable");
    expect((await series())?.disabled ?? false).toBe(false);
    const next = (await series())?.nextJobId;
    expect(next).not.toBeNull();
    expect((await queue.getJob(next!))?.state).toBe("delayed");
  });
});
