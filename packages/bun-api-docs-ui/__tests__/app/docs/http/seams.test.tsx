import type { DocsClient } from "../../../../app/api/client";
import type { SpecDocument } from "../../../../app/api/docs";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, describe, expect, it, mock } from "bun:test";
import { DocsUiConfigContext } from "../../../../app/context";
import { createQueryClient } from "../../../../app/queryClient";
import { RouterProvider } from "../../../../app/router";
import { ParamsContext } from "../../../../app/routing";
import { HttpReference } from "../../../../app/screens/docs/http/index";
import { viewerConfig } from "../../renderViewer";
import { expectAbsent } from "../../assert";
import { fireEvent, page, render, setupDom, visit, within } from "../../dom";
import { openApiFixture } from "./openapiFixture";

setupDom();

let doc: SpecDocument;

beforeAll(async () => {
  doc = await openApiFixture({ csrfHeader: "x-bun-jobs-csrf" });
});

/**
 * The host seams on the HTTP reference: the permission probe, the read-only
 * gate, the onChanged hook, the injected try-it client, and the docs
 * section's base path. Rendered against a real generated document.
 */
async function renderHttp(
  operationId: string,
  options: {
    probe?: (action: string) => boolean | undefined;
    readOnly?: boolean;
    onChanged?: () => void;
    pathBase?: string;
    client?: DocsClient;
  } = {},
) {
  visit(`/jobs/docs/http/${operationId}`);
  const calls: string[] = [];
  render(
    <DocsUiConfigContext
      value={viewerConfig({ csrfHeader: "x-bun-jobs-csrf" })}
    >
      <QueryClientProvider client={createQueryClient({ retry: false })}>
        <RouterProvider basePath="/jobs">
          <ParamsContext value={{ operationId }}>
            <HttpReference
              doc={doc}
              probe={options.probe}
              readOnly={options.readOnly}
              onChanged={options.onChanged}
              pathBase={options.pathBase ?? ""}
              client={options.client}
            />
          </ParamsContext>
        </RouterProvider>
      </QueryClientProvider>
    </DocsUiConfigContext>,
  );
  await page().findByTestId("http-operation", {}, { timeout: 5_000 });
  return { calls };
}

/** The rendered operation view. */
function view() {
  return within(page().getByTestId("http-operation"));
}

describe("the HTTP reference's host seams", () => {
  it("the probe marks a permission held or lacked", async () => {
    await renderHttp("pauseQueue", { probe: () => true });
    expect(view().getByTestId("op-permission").textContent).toContain(
      "You have",
    );
    expect(view().getByTestId("op-permission").dataset.allowed).toBe("true");
  });

  it("the probe's false lacks the permission and turns the panel off with the reason", async () => {
    await renderHttp("pauseQueue", { probe: () => false });
    expect(view().getByTestId("op-permission").textContent).toContain(
      "You lack",
    );
    expect(view().getByTestId("tryit-disabled").textContent).toContain(
      "queues.pause",
    );
  });

  it("readOnly marks a mutation refused and turns the panel off", async () => {
    await renderHttp("pauseQueue", { readOnly: true });
    expect(view().getByText("Refused: the API is read-only")).toBeTruthy();
    expect(view().getByTestId("tryit-disabled").textContent).toContain(
      "read-only",
    );
  });

  it("no probe: the plain marker and an open panel (the standalone shape)", async () => {
    await renderHttp("pauseQueue");
    expect(view().getByTestId("op-permission").textContent).toContain(
      "queues.pause",
    );
    expect(view().getByTestId("op-permission").textContent).toContain("Needs");
    expectAbsent(document.body.querySelector('[data-testid="tryit-disabled"]'));
  });

  it("a mutation's send goes through the injected client and calls onChanged", async () => {
    const onChanged = mock(() => {});
    const sent: { method: string; path: string }[] = [];
    const client: DocsClient = {
      base: "/jobs-api",
      request: () => Promise.resolve(undefined as never),
      requestRaw: (method, path) => {
        sent.push({ method, path });
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {},
          body: { queue: "mail" },
          error: undefined,
          durationMs: 1,
        });
      },
    };
    await renderHttp("pauseQueue", { onChanged, client });
    const field = within(page().getByTestId("tryit"))
      .getAllByText("queue", { selector: "code" })
      .map((code) => code.closest(".field"))
      .find(Boolean) as HTMLElement;
    fireEvent.change(field.querySelector("input")!, {
      target: { value: "mail" },
    });
    fireEvent.click(
      within(page().getByTestId("tryit")).getByRole("button", {
        name: "Send POST",
      }),
    );
    // The mutation confirms first.
    let confirm: HTMLElement | null = null;
    await page().findByText(/Send POST \/queues/, {}, { timeout: 3_000 });
    confirm = document.querySelector<HTMLElement>("dialog[open]");
    fireEvent.click(
      within(confirm!).getByRole("button", { name: "Send POST" }),
    );
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    expect(sent).toEqual([{ method: "POST", path: "/queues/mail/pause" }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("links operations under the host's base path", async () => {
    visit("/jobs/docs/http");
    render(
      <DocsUiConfigContext value={viewerConfig()}>
        <QueryClientProvider client={createQueryClient({ retry: false })}>
          <RouterProvider basePath="/jobs">
            <ParamsContext value={{}}>
              <HttpReference
                doc={doc}
                pathBase="/docs"
              />
            </ParamsContext>
          </RouterProvider>
        </QueryClientProvider>
      </DocsUiConfigContext>,
    );
    const nav = await page().findByRole(
      "navigation",
      { name: "Operations" },
      { timeout: 5_000 },
    );
    const link = nav.querySelector('a[data-operation="pauseQueue"]')!;
    expect(link.getAttribute("href")).toBe("/jobs/docs/http/pauseQueue");
  });
});
