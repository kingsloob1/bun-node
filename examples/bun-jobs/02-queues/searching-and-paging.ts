/**
 * Searching, paging and reading jobs by id — the reads behind an admin
 * screen.
 *
 * ```bash
 * bun 02-queues/searching-and-paging.ts
 * EXAMPLE_DRIVER=sqlite bun 02-queues/searching-and-paging.ts
 * ```
 *
 * Worth knowing:
 *
 * - `name` is an **exact** match (one name or several); `search` is a
 *   case-insensitive substring of a job's **id or name**, and never of its
 *   payload. Every character in a search is taken literally, so `%`, `_` and
 *   regular-expression characters match themselves on every backend.
 * - `page()` is `list()` plus the count of everything that matched, which is
 *   what a paginated table needs and what `jobs.length` cannot tell you.
 * - No index serves a substring, so a filtered read looks at the jobs in the
 *   states asked for. On a large backlog, pair a search with a small state or
 *   a name.
 */
import { BunQueue, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

/** One queued piece of work for a customer's order. */
interface Task {
  /** The order the task belongs to. */
  order: string;
}

title("Searching and paging a queue");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("support");
const tasks = new BunQueue<Task, void>("tasks", { namespace, driver });

/* ------------------------------------------------------------------ */
step("Seed: twelve waiting jobs under three names");

/** The name each job is added under, cycled through the seed. */
const names = ["sendEmail", "resizeImage", "buildReport"];

await tasks.addBulk(
  Array.from({ length: 12 }, (_, index) => ({
    name: names[index % 3]!,
    data: { order: `ord-${index + 1}` },
    // Ids an operator would recognise, so a search over ids has something to
    // find. `list` returns waiting jobs oldest first, so these stay in order.
    opts: { jobId: `INV-${String(index + 1).padStart(3, "0")}` },
  })),
);

show("counts", await tasks.count());

/* ------------------------------------------------------------------ */
step("list: a state, as it always was");

show(
  "first four waiting",
  (await tasks.list("waiting", { limit: 4 })).map((job) => job.id),
);

/* ------------------------------------------------------------------ */
step("list({ name }): one name, or several");

show(
  "name: sendEmail",
  (await tasks.list("waiting", { name: "sendEmail" })).map((job) => job.id),
);
show(
  "name: [sendEmail, buildReport]",
  (await tasks.list("waiting", { name: ["sendEmail", "buildReport"] })).map(
    (job) => job.id,
  ),
);

/* ------------------------------------------------------------------ */
step("list({ search }): a substring of the id or the name, ignoring case");

// The id an operator pasted out of a support ticket, in the wrong case.
show(
  'search: "inv-01" (matches ids)',
  (await tasks.list("waiting", { search: "inv-01" })).map((job) => job.id),
);
// The same search reads names too, so a job name is a search term for free.
show(
  'search: "EMAIL" (matches names)',
  (await tasks.list("waiting", { search: "EMAIL" })).map((job) => job.id),
);
// Never the payload: every job's data holds an order id, and none is found.
show(
  'search: "ord-3" (a payload field — never searched)',
  (await tasks.list("waiting", { search: "ord-3" })).length,
);

// Filters compose, and `order` still applies.
show(
  "name + search, newest first",
  (
    await tasks.list("waiting", {
      name: "resizeImage",
      search: "inv-0",
      order: "desc",
      limit: 3,
    })
  ).map((job) => job.id),
);

/* ------------------------------------------------------------------ */
step("page: a slice, and how many matched in all");

const second = await tasks.page("waiting", {
  name: ["sendEmail", "resizeImage"],
  offset: 4,
  limit: 4,
});

show(
  "page jobs",
  second.jobs.map((job) => job.id),
);
// `total` counts every match, not the page: this is "showing 5-8 of 8".
show("total matching", second.total);
show("showing", `${second.jobs.length} of ${second.total} (offset 4)`);

// Without a filter the total is the states' counts, which every backend
// already keeps — so an unfiltered page costs a count, not a scan.
const unfiltered = await tasks.page(["waiting", "completed"], { limit: 3 });
show("unfiltered page", {
  returned: unfiltered.jobs.length,
  total: unfiltered.total,
});

/* ------------------------------------------------------------------ */
step("getJobs: several ids in one round trip");

// One entry per id, in the order asked, `null` where there is no such job —
// so a list of ids from elsewhere can be lined up with what came back.
const picked = await tasks.getJobs(["INV-005", "no-such-job", "INV-001"]);

show(
  "asked for three ids",
  picked.map((job) => job?.id ?? null),
);
show("the missing one", picked[1]);
show("data of the first", picked[0]?.data);

/* ------------------------------------------------------------------ */
step("Cleanup");

await tasks.close();
await driver.purge(namespace);
await driver.close();
