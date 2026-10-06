import type {
  AddFlowResultDto,
  JobDto,
  MetaDto,
  Permissions,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it, mock } from "bun:test";
import { queueKeys } from "../../../app/api/queues";
import { AddFlowDialog } from "../../../app/screens/job/AddFlowDialog";
import { expectAbsent, expectNone } from "../assert";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import {
  metaFixture,
  permissionsFixture,
  problem,
  queueListFixture,
} from "../fixtures";
import { renderQueue } from "../queues/fixtures";
import { allPermissions, jobFixture, jobMeta } from "./fixtures";
import { renderWithProviders } from "./render";

setupDom();

/** The one name every node gets preselected, unless a test lists more. */
const ONLY = ["only"];

/** Opens the dialog for queue `emails`. */
async function openFlow(
  options: {
    /** `/meta`. Defaults to {@link jobMeta} with only {@link ONLY} addable. */
    meta?: MetaDto;
    /** What `POST /queues/emails/flows` answers. */
    post?: MockHandler | MockReply;
    /** `GET /meta/permissions`, targeted or not. */
    permissions?: MockHandler | MockReply;
  } = {},
) {
  const onClose = mock(() => {});
  const result = await renderWithProviders(
    <AddFlowDialog
      queue="emails"
      open
      onClose={onClose}
    />,
    {
      meta: options.meta ?? jobMeta({ addableNames: ONLY }),
      handlers: {
        "GET /queues": { body: queueListFixture() },
        "POST /queues/emails/flows": options.post ?? {
          status: 201,
          body: added(jobFixture("waiting-children", { id: "p-1" })),
        },
        ...(options.permissions
          ? { "GET /meta/permissions": options.permissions }
          : {}),
      },
    },
  );
  const dialog = await page().findByRole("dialog", {
    name: "Add a flow to emails",
  });
  const posts = () => result.calls.filter((call) => call.method === "POST");
  return { ...result, dialog, onClose, posts };
}

/** A 201 result for `job` and its children's results. */
function added(
  job: JobDto,
  children: AddFlowResultDto[] = [],
): AddFlowResultDto {
  return { added: true, job, children };
}

/** Matches a field's label with or without its required marker ("Name *"). */
function labelled(label: string): RegExp {
  return new RegExp(
    `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\*)?$`,
  );
}

/** One node's fieldset, by its legend ("Top job", "Child 1.2"). */
function node(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByRole("group", { name: label });
}

/** Sets a labelled control's value. */
function type(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(labelled(label)), {
    target: { value },
  });
}

/** The error under a labelled field, `""` for none. */
function errorOf(scope: HTMLElement, label: string): string {
  const control = within(scope).getByLabelText(labelled(label));
  return (
    control.closest(".field")?.querySelector(".field-error")?.textContent ?? ""
  );
}

/** Clicks a button by its accessible name. */
async function press(scope: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(within(scope).getByRole("button", { name }));
  });
}

/** Waits until `GET /queues` has filled the queue selects. */
async function queuesListed(scope: HTMLElement) {
  await waitFor(() =>
    expect(
      Array.from(
        within(scope)
          .getByLabelText(labelled("Queue"))
          .querySelectorAll("option"),
      ).map((option) => option.textContent),
    ).toContain("reports"),
  );
}

/**
 * Builds the tree the error tests share:
 *
 *     Top job (emails)
 *     ├─ Child 1 (reports)
 *     │  └─ Child 1.1 (reports, its parent's)
 *     └─ Child 2 (emails, its parent's)
 */
async function buildTree(dialog: HTMLElement) {
  await press(dialog, "Add child to Top job");
  await queuesListed(node(dialog, "Child 1"));
  type(node(dialog, "Child 1"), "Queue", "reports");
  await press(dialog, "Add child to Child 1");
  await press(dialog, "Add child to Top job");
}

/** Submits the dialog. */
async function submit(dialog: HTMLElement) {
  await press(dialog, "Add flow");
}

describe("the Add flow button on the queue screen", () => {
  /** Renders the emails queue with `meta` and `actions`, once its header loaded. */
  async function queueWith(meta: MetaDto, actions: Permissions["actions"]) {
    const rendered = renderQueue({
      handlers: {
        "GET /meta": { body: meta },
        "GET /meta/permissions": { body: permissionsFixture(actions) },
      },
    });
    await page().findByTestId("queue-total");
    await page().findByRole("table", { name: "Jobs in emails" });
    return rendered;
  }

  it("is there with features.addFlow and jobs.add", async () => {
    await queueWith(metaFixture({ addableNames: null }), { "jobs.add": true });
    expect(page().getByRole("button", { name: "Add flow" })).toBeTruthy();
    expect(page().getByRole("button", { name: "Add job" })).toBeTruthy();
  });

  it("is absent without features.addFlow, while Add job stays", async () => {
    const meta = metaFixture({ addableNames: null });
    await queueWith(
      { ...meta, features: { ...meta.features, addFlow: false } },
      { "jobs.add": true },
    );
    expect(page().getByRole("button", { name: "Add job" })).toBeTruthy();
    expectAbsent(page().queryByRole("button", { name: "Add flow" }));
  });

  it("is absent without jobs.add (opt-in), whatever the capability says", async () => {
    await queueWith(metaFixture({ addableNames: null }), {});
    expectAbsent(page().queryByRole("button", { name: "Add flow" }));
  });

  it("is absent under readOnly, even with a map granting jobs.add", async () => {
    await queueWith(metaFixture({ addableNames: null, readOnly: true }), {
      "jobs.add": true,
    });
    expectAbsent(page().queryByRole("button", { name: "Add flow" }));
  });

  it("is absent when no name is addable", async () => {
    await queueWith(metaFixture({ addableNames: [] }), { "jobs.add": true });
    expectAbsent(page().queryByRole("button", { name: "Add flow" }));
  });

  it("opens with focus inside, and gives focus back to the button on Cancel and on Escape", async () => {
    await queueWith(metaFixture({ addableNames: ONLY }), { "jobs.add": true });
    const button = page().getByRole("button", { name: "Add flow" });
    for (const close of ["Cancel", "Escape"] as const) {
      button.focus();
      await act(async () => {
        fireEvent.click(button);
      });
      const dialog = await page().findByRole("dialog", {
        name: "Add a flow to emails",
      });
      expect(dialog.contains(document.activeElement)).toBe(true);
      if (close === "Cancel") {
        await press(dialog, "Cancel");
      } else {
        await act(async () => {
          fireEvent.keyDown(dialog, { key: "Escape" });
        });
      }
      await waitFor(() =>
        expectAbsent(
          page().queryByRole("dialog", { name: "Add a flow to emails" }),
        ),
      );
      expect(document.activeElement === button).toBe(true);
    }
  });
});

describe("the add-flow dialog: building the tree", () => {
  it("sends exactly the tree built across two queues", async () => {
    const { dialog, posts } = await openFlow({
      meta: jobMeta({ addableNames: ["parent", "child", "grand"] }),
    });
    const top = node(dialog, "Top job");
    expect(top.textContent).toContain("Queue: emails");
    type(top, "Name", "parent");
    type(top, "Data", '{"a":1}');

    await press(dialog, "Add child to Top job");
    const child = node(dialog, "Child 1");
    // A new node takes the focus.
    expect(child.contains(document.activeElement)).toBe(true);
    type(child, "Name", "child");
    await queuesListed(child);
    type(child, "Queue", "reports");
    fireEvent.click(
      within(child).getByLabelText("Parent carries on if this fails"),
    );

    await press(dialog, "Add child to Child 1");
    const grand = node(dialog, "Child 1.1");
    type(grand, "Name", "grand");
    // Its queue defaults to its parent's.
    const grandQueue = within(grand).getByLabelText(
      labelled("Queue"),
    ) as HTMLSelectElement;
    expect(grandQueue.selectedOptions[0]?.textContent).toBe(
      "Its parent's (reports)",
    );
    await press(grand, "Options of Child 1.1");
    type(grand, "Job id", "g-1");

    await press(dialog, "Add child to Top job");
    type(node(dialog, "Child 2"), "Name", "child");
    expect(page().getByTestId("flow-count").textContent).toContain(
      "4 of 100 jobs",
    );

    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const call = posts()[0]!;
    expect(call.path).toBe("/queues/emails/flows");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call.body!)).toEqual({
      name: "parent",
      data: { a: 1 },
      children: [
        {
          name: "child",
          data: {},
          opts: { ignoreFailure: true },
          queue: "reports",
          children: [{ name: "grand", data: {}, opts: { jobId: "g-1" } }],
        },
        { name: "child", data: {} },
      ],
    });
  });

  it("removes a node with everything below it, and checks every node before sending", async () => {
    const { dialog, posts } = await openFlow({
      meta: jobMeta({ addableNames: ["a", "b"] }),
    });
    type(node(dialog, "Top job"), "Name", "a");
    await press(dialog, "Add child to Top job");
    await press(dialog, "Add child to Child 1");
    await submit(dialog);
    expect(errorOf(node(dialog, "Child 1"), "Name")).toBe(
      "Pick or enter a job name.",
    );
    expect(errorOf(node(dialog, "Child 1.1"), "Name")).toBe(
      "Pick or enter a job name.",
    );
    expectNone(posts());

    await press(dialog, "Remove Child 1");
    expectAbsent(within(dialog).queryByRole("group", { name: "Child 1.1" }));
    // Focus goes back to the parent's Add child.
    expect(document.activeElement?.textContent).toBe("Add child to Top job");
    expect(page().getByTestId("flow-count").textContent).toContain(
      "1 of 100 jobs",
    );
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(posts()[0]!.body!)).toEqual({ name: "a", data: {} });
  });

  it("disables Add child at maxFlowNodes and at maxFlowDepth, saying why", async () => {
    const meta = jobMeta({ addableNames: ONLY });
    const { dialog } = await openFlow({
      meta: {
        ...meta,
        limits: { ...meta.limits, maxFlowNodes: 3, maxFlowDepth: 2 },
      },
    });
    const addTop = () =>
      within(dialog).getByRole("button", {
        name: "Add child to Top job",
      }) as HTMLButtonElement;
    expect(addTop().disabled).toBe(false);
    await press(dialog, "Add child to Top job");
    const addChild1 = within(dialog).getByRole("button", {
      name: "Add child to Child 1",
    }) as HTMLButtonElement;
    expect(addChild1.disabled).toBe(true);
    expect(
      document.getElementById(addChild1.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("This job is at level 2; a flow nests at most 2 levels.");
    // The node count has room still.
    expect(addTop().disabled).toBe(false);

    await press(dialog, "Add child to Top job");
    expect(addTop().disabled).toBe(true);
    expect(
      document.getElementById(addTop().getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("The flow holds 3 jobs, the most the API accepts.");
    expect(page().getByTestId("flow-count").textContent).toBe(
      "3 of 3 jobs: the most one flow may hold.",
    );
  });
});

describe("the add-flow dialog: permissions", () => {
  it("marks a child whose queue refuses jobs.add, and still lets the API decide", async () => {
    const { dialog, posts, calls } = await openFlow({
      permissions: (call) => ({
        body:
          call.query.get("queue") === "reports"
            ? allPermissions({ "jobs.add": false })
            : allPermissions(),
      }),
    });
    await buildTree(dialog);
    const refusal =
      "You may not add jobs to “reports”: the API will refuse this flow.";
    await waitFor(() =>
      expect(errorOf(node(dialog, "Child 1"), "Queue")).toBe(refusal),
    );
    expect(errorOf(node(dialog, "Child 1.1"), "Queue")).toBe(refusal);
    expect(node(dialog, "Child 1").dataset.refused).toBe("true");
    expect(errorOf(node(dialog, "Child 2"), "Queue")).toBe("");
    expect(
      calls.some(
        (call) =>
          call.path === "/meta/permissions" &&
          call.query.get("queue") === "reports",
      ),
    ).toBe(true);
    await submit(dialog);
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
});

describe("the add-flow dialog: results", () => {
  it("lists a 201's jobs, links the top job, and invalidates every queue written to", async () => {
    const { dialog, queryClient } = await openFlow({
      post: {
        status: 201,
        body: added(
          jobFixture("waiting-children", { id: "p-1", name: "only" }),
          [
            added(jobFixture("waiting", { id: "c-1", queue: "reports" }), [
              added(jobFixture("waiting", { id: "c-2", queue: "reports" })),
            ]),
            added(jobFixture("waiting", { id: "c-3" })),
          ],
        ),
      },
    });
    const seeded = {
      emailsJobs: queueKeys.jobsAll("emails"),
      emailsCounts: queueKeys.counts("emails"),
      reportsJobs: queueKeys.jobsAll("reports"),
      reportsCounts: queueKeys.counts("reports"),
      untouched: queueKeys.counts("audit"),
    };
    for (const key of Object.values(seeded)) {
      queryClient.setQueryData(key, { seeded: true });
    }
    await buildTree(dialog);
    await submit(dialog);
    const result = await within(dialog).findByTestId("flow-result");
    expect(result.textContent).toContain("Added 4 jobs.");
    expect(document.activeElement === result).toBe(true);
    const link = within(result).getByRole("link", { name: "only (p-1)" });
    expect(link.getAttribute("href")).toBe("/jobs/queues/emails/jobs/p-1");
    expect(
      within(result)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "only in emails, id p-1",
      "send-welcome in reports, id c-1",
      "send-welcome in reports, id c-2",
      "send-welcome in emails, id c-3",
    ]);
    const invalidated = (key: readonly unknown[]) =>
      queryClient.getQueryState(key)?.isInvalidated === true;
    await waitFor(() => expect(invalidated(seeded.reportsJobs)).toBe(true));
    expect(invalidated(seeded.reportsCounts)).toBe(true);
    expect(invalidated(seeded.emailsJobs)).toBe(true);
    expect(invalidated(seeded.emailsCounts)).toBe(true);
    // Negative control: a queue the flow did not touch is left alone.
    expect(invalidated(seeded.untouched)).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("says a 200 added nothing because the top job existed, with a link to it", async () => {
    const { dialog } = await openFlow({
      post: {
        status: 200,
        body: {
          added: false,
          job: jobFixture("completed", { id: "dup", name: "only" }),
          children: [],
        },
      },
    });
    await press(node(dialog, "Top job"), "Options of Top job");
    type(node(dialog, "Top job"), "Job id", "dup");
    await press(dialog, "Add child to Top job");
    await submit(dialog);
    const result = await within(dialog).findByTestId("flow-result");
    expect(result.textContent).toContain(
      "The top job already existed, so nothing was added",
    );
    expect(
      within(result)
        .getByRole("link", { name: "view only (dup)" })
        .getAttribute("href"),
    ).toBe("/jobs/queues/emails/jobs/dup");
  });
});

describe("the add-flow dialog: errors on their nodes", () => {
  /** Opens the dialog answering `status`/`body`, builds the tree and submits. */
  async function failWith(status: number, body: unknown) {
    const opened = await openFlow({ post: { status, body } });
    await buildTree(opened.dialog);
    await submit(opened.dialog);
    return opened;
  }

  it("places VALIDATION issues on their node and field, a bound one on the node", async () => {
    const { dialog } = await failWith(
      400,
      problem(400, "VALIDATION", "Validation failed", {
        issues: [
          {
            target: "body",
            path: "children.0.children.0.name",
            message: "Too long",
          },
          {
            target: "body",
            path: "children.0.opts.attempts",
            message: "Must be ≥ 1",
          },
          {
            target: "body",
            path: "children.1",
            message: "A flow may hold at most 100 jobs",
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(errorOf(node(dialog, "Child 1.1"), "Name")).toBe("Too long"),
    );
    // Child 1's options open on their own to show the error.
    expect(errorOf(node(dialog, "Child 1"), "Attempts")).toBe("Must be ≥ 1");
    expect(within(node(dialog, "Child 2")).getByRole("alert").textContent).toBe(
      "A flow may hold at most 100 jobs",
    );
    expect(errorOf(node(dialog, "Top job"), "Name")).toBe("");
    expect(errorOf(node(dialog, "Child 1"), "Name")).toBe("");
    expectAbsent(dialog.querySelector(".problem-banner"));
  });

  it("puts NAME_NOT_ADDABLE on the name at context.path", async () => {
    const { dialog } = await failWith(
      403,
      problem(403, "NAME_NOT_ADDABLE", "Name not addable", {
        context: { name: "only", queue: "emails", path: "children.1.name" },
      }),
    );
    await waitFor(() =>
      expect(errorOf(node(dialog, "Child 2"), "Name")).toContain(
        "Jobs named “only” may not be added",
      ),
    );
    expect(errorOf(node(dialog, "Top job"), "Name")).toBe("");
    expect(errorOf(node(dialog, "Child 1"), "Name")).toBe("");
    expectAbsent(dialog.querySelector(".problem-banner"));
  });

  it("puts a FORBIDDEN naming a queue on every node going there", async () => {
    const { dialog } = await failWith(
      403,
      problem(403, "FORBIDDEN", "Forbidden", {
        context: { queue: "reports" },
      }),
    );
    const message = "You may not add jobs to “reports”.";
    await waitFor(() =>
      expect(errorOf(node(dialog, "Child 1"), "Queue")).toBe(message),
    );
    expect(errorOf(node(dialog, "Child 1.1"), "Queue")).toBe(message);
    expect(errorOf(node(dialog, "Child 2"), "Queue")).toBe("");
    expect(node(dialog, "Top job").textContent).not.toContain(message);
  });

  it("puts a FORBIDDEN without context.queue on the path's queue", async () => {
    const { dialog } = await failWith(
      403,
      problem(403, "FORBIDDEN", "Forbidden"),
    );
    const message = "You may not add jobs to “emails”.";
    await waitFor(() =>
      expect(node(dialog, "Top job").textContent).toContain(message),
    );
    expect(errorOf(node(dialog, "Child 2"), "Queue")).toBe(message);
    expect(errorOf(node(dialog, "Child 1"), "Queue")).toBe("");
  });

  it("puts QUEUE_NOT_FOUND on the nodes in that queue", async () => {
    const { dialog } = await failWith(
      404,
      problem(404, "QUEUE_NOT_FOUND", "Queue not found", {
        context: { queue: "reports" },
      }),
    );
    await waitFor(() =>
      expect(errorOf(node(dialog, "Child 1"), "Queue")).toBe(
        "The API does not manage a queue named “reports”.",
      ),
    );
    expect(errorOf(node(dialog, "Child 2"), "Queue")).toBe("");
  });

  it("shows what cannot be placed in the banner", async () => {
    const { dialog, onClose } = await failWith(
      400,
      problem(400, "INVALID_ARGUMENT", "Invalid argument", {
        detail: "something else went wrong",
      }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("something else went wrong");
    expect(onClose).not.toHaveBeenCalled();
  });
});
