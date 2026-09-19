import type { RecordedCall } from "./mockFetch";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { fireEvent, page, setupDom } from "./dom";
import { allPermissions, jobApiPath, jobFixture } from "./job/fixtures";
import { renderJobScreen } from "./job/render";

setupDom();

// React reports every caught render error on console.error; the crashes
// here are deliberate.
let quiet: ReturnType<typeof spyOn>;
beforeEach(() => {
  quiet = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => quiet.mockRestore());

/** `"METHOD /path"` of each call. */
function routes(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.path}`);
}

/** Permissions without `jobs.logs`, so the job screen reads only the job. */
const NO_LOGS = allPermissions({ "jobs.logs": false });

describe("Reload this screen, after a crash caused by the data", () => {
  it("re-reads the screen's data (once), and not /meta or the permissions", async () => {
    // The first answer passes the shape guard but crashes the render: a
    // worker id React cannot draw. The host is then fixed.
    let reads = 0;
    const { calls } = await renderJobScreen(
      () => {
        reads += 1;
        return {
          body:
            reads === 1
              ? jobFixture("active", { workerId: { host: "a" } as never })
              : jobFixture("active", { workerId: "worker-1" }),
        };
      },
      { permissions: NO_LOGS, wait: false },
    );
    const panel = await page().findByTestId("screen-error");
    expect(panel.textContent).toContain(
      "Objects are not valid as a React child",
    );
    expect(reads).toBe(1);

    const before = calls.length;
    fireEvent.click(page().getByRole("button", { name: "Reload this screen" }));
    expect(await page().findByTestId("job-screen")).toBeTruthy();
    expect(await page().findByText("worker-1")).toBeTruthy();
    expect(page().queryByTestId("screen-error")).toBeNull();

    // Exactly one new request, the job; the bootstrap reads were kept.
    expect(routes(calls.slice(before))).toEqual([`GET ${jobApiPath()}`]);
    expect(reads).toBe(2);
    // Neither `/meta` nor any permissions map was asked again.
    const bootstrap = (list: readonly RecordedCall[]) =>
      list.filter((call) => call.path.startsWith("/meta")).length;
    expect(bootstrap(calls.slice(0, before))).toBeGreaterThanOrEqual(2);
    expect(bootstrap(calls.slice(before))).toBe(0);
  });
});

describe("a job read that answers the wrong shape", () => {
  for (const [label, body] of [
    ["{}", {}],
    ["[]", []],
    ["a string", "text"],
  ] as const) {
    it(`shows the error state with a Retry for ${label}, and Retry loads the job`, async () => {
      let reads = 0;
      await renderJobScreen(
        () => {
          reads += 1;
          return { body: reads === 1 ? body : jobFixture("waiting") };
        },
        { permissions: NO_LOGS, wait: false },
      );
      const title = await page().findByRole("heading", {
        level: 1,
        name: "Could not load the job",
      });
      expect(title).toBeTruthy();
      expect(page().getByRole("alert").textContent).toContain(
        "UNEXPECTED_RESPONSE",
      );
      fireEvent.click(page().getByRole("button", { name: "Retry" }));
      const loaded = await page().findByRole("heading", {
        level: 1,
        name: /send-welcome/,
      });
      expect(loaded).toBeTruthy();
      expect(reads).toBe(2);
    });
  }
});
