/**
 * Namespaces — several services on one backend, without colliding.
 *
 * ```bash
 * bun 09-integrations/namespaces.ts
 * ```
 *
 * Every queue, worker and runner belongs to a namespace, and it is required.
 * The same queue name, job id or runner id in two namespaces are two different
 * things. Give each service its own — typically its name — and a shared Redis
 * or Postgres needs no coordination beyond that.
 *
 * `BunJobs` makes it structural: set the namespace once per service and
 * everything derived from the context inherits it.
 */
import { BunJobs, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("Namespaces");

// One backend, shared by two services.
const driver = createDriver(exampleDriver());

const billing = new BunJobs({ namespace: exampleNamespace("billing"), driver });
const accounts = new BunJobs({
  namespace: exampleNamespace("accounts"),
  driver,
});

/* ------------------------------------------------------------------ */
step("Both services use a queue called `emails` and a job id `welcome-42`");

const received: string[] = [];

for (const [service, jobs] of [
  ["billing", billing],
  ["accounts", accounts],
] as const) {
  jobs
    .worker<{ template: string }>(
      "emails",
      async (job) => {
        received.push(`${service} got ${job.id} (${job.data.template})`);
      },
      { pollInterval: 25 },
    )
    .run();

  await jobs
    .queue<{ template: string }>("emails")
    .add(
      "send",
      { template: `${service}-welcome` },
      { jobId: "welcome-42", removeOnComplete: false },
    );
}

await waitFor("each service's email", () => received.length === 2);
show("delivered", received);
show("billing's queues", await billing.listQueues());
show("accounts' queues", await accounts.listQueues());

/* ------------------------------------------------------------------ */
step("purge() one namespace; the other is untouched");

await billing.purge();
show(
  "billing's welcome-42 after purge",
  await billing.queue("emails").getJob("welcome-42"),
);
show(
  "accounts' welcome-42 after billing's purge",
  (await accounts.queue("emails").getJob("welcome-42"))?.data,
);

await accounts.purge();
await Promise.all([billing.close(), accounts.close()]);
await driver.close();
