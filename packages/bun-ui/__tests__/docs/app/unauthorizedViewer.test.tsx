/**
 * `unauthorized` in the whole viewer: a document read refused with a listed
 * status sends the browser to the configured page, once, with the page it
 * was on. The try-it panel's calls never do (their 401 is the documented
 * API's answer to the request being tried), a status the option does not
 * list never does, and with the option off nothing navigates.
 *
 * `location.assign` is stubbed: happy-dom would otherwise try to load the
 * target.
 */
import type { Mock } from "bun:test";
import type { SpecDocument } from "../../../app/docs/api/docs";
import type { UiUnauthorized } from "../../../lib/kit/browser/unauthorized.ts";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { act, fireEvent, page, setupDom, waitFor, within } from "./dom";
import { openApiFixture } from "./docs/http/openapiFixture";
import { renderViewer } from "./renderViewer";

setupDom();

/** `unauthorized: { redirectTo: "/login" }`, resolved. */
const TO_LOGIN: UiUnauthorized = {
  redirectTo: "/login",
  returnParam: "returnTo",
  statuses: [401],
};

let doc: SpecDocument;
let assign: Mock<(url: string | URL) => void>;

beforeAll(async () => {
  doc = await openApiFixture({});
});

beforeEach(() => {
  assign = spyOn(window.location, "assign").mockImplementation(() => {});
});

afterEach(() => {
  assign.mockRestore();
});

/** Lets the in-flight reads land. */
async function settled(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await act(async () => {
      await Bun.sleep(5);
    });
  }
}

describe("unauthorized: the viewer", () => {
  it("sends the browser to the target once, with the page it was on, when the document read is refused", async () => {
    await renderViewer({
      document: doc,
      path: "/http?q=queue",
      config: { unauthorized: TO_LOGIN },
      documentError: { status: 401 },
    });
    await waitFor(() => expect(assign).toHaveBeenCalled());
    await settled();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      "/login?returnTo=%2Fdocs%2Fhttp%3Fq%3Dqueue",
    );
  });

  it("leaves a 403 alone by default, showing the error view", async () => {
    await renderViewer({
      document: doc,
      config: { unauthorized: TO_LOGIN },
      documentError: { status: 403 },
    });
    expect(
      await page().findByText("Could not load the API document"),
    ).toBeTruthy();
    await settled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects a 403 too when statuses lists it", async () => {
    await renderViewer({
      document: doc,
      config: { unauthorized: { ...TO_LOGIN, statuses: [401, 403] } },
      documentError: { status: 403 },
    });
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(assign).toHaveBeenCalledWith("/login?returnTo=%2Fdocs");
  });

  it("is off by default: a refused document read shows the error view and navigates nowhere", async () => {
    await renderViewer({ document: doc, documentError: { status: 401 } });
    expect(
      await page().findByText("Could not load the API document"),
    ).toBeTruthy();
    await settled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("never redirects on the try-it panel's 401: that is the documented API's answer", async () => {
    const { calls } = await renderViewer({
      document: doc,
      path: "/http/listQueues",
      config: { unauthorized: TO_LOGIN },
      canned: {
        status: 401,
        body: {
          type: "urn:test:error:UNAUTHORIZED",
          title: "Authentication required",
          status: 401,
          code: "UNAUTHORIZED",
        },
      },
    });
    await page().findByTestId("http-operation", {}, { timeout: 3_000 });
    fireEvent.click(
      within(page().getByTestId("tryit")).getByRole("button", {
        name: "Send GET",
      }),
    );
    await page().findByTestId("tryit-result", {}, { timeout: 3_000 });
    expect(page().getByTestId("tryit-status").textContent).toBe("401");
    // Negative control on the source: the try-it send did go out and was refused.
    expect(calls.some((call) => call.url.endsWith("/jobs-api/queues"))).toBe(
      true,
    );
    await settled();
    expect(assign).not.toHaveBeenCalled();
  });
});
