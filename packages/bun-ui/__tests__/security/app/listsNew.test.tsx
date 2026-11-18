/**
 * The new-entry form (`/lists/new`, PR-U3, ui.md §4.1): it adds one entry
 * to the scope's draft after a confirm (the PUT body exactly, the CSRF
 * header), a typed account id is echoed once with its key and never again,
 * it checks what the policy would refuse, and it is pre-filled from the
 * links other screens make (`ip`, `country`, `asn`, `userHash`,
 * `apiKeyHash`, `action`, `reason`), a bad value left empty and flagged.
 */
import { describe, expect, it } from "bun:test";
import {
  expectAbsent,
  expectNone,
  expectUndefined,
} from "../../harness/assert";
import {
  cleanup,
  fireEvent,
  LOADED,
  page,
  setupDom,
  waitFor,
  within,
} from "./dom";
import { draftPuts, keyOf, policyApi } from "./listsApi";
import { defaultRoutes } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The draft's entries (revision 2). */
const DRAFT = [{ ip: "203.0.113.0/24", action: "block" }];

/** Opens the form at `query` over a draft; waits for it. */
async function openForm(
  query: string,
  fake = policyApi({ head: [], draft: DRAFT }),
) {
  const rendered = renderApp({
    path: `/lists/new?scope=global${query}`,
    routes: fake.routes,
  });
  await page().findByTestId("lists-new", {}, LOADED);
  return { ...rendered, fake };
}

/** A control by its test id. */
function control(testId: string): HTMLInputElement {
  return page().getByTestId(testId) as HTMLInputElement;
}

/** The error under a control, or `undefined`. */
function errorOf(testId: string): string | undefined {
  return (
    control(testId).closest(".field")?.querySelector(".field-error")
      ?.textContent ?? undefined
  );
}

/** Types into a control. */
function type(testId: string, value: string): void {
  fireEvent.change(control(testId), { target: { value } });
}

/** Submits the form and waits for the confirm dialog. */
async function submit(): Promise<HTMLElement> {
  fireEvent.click(page().getByTestId("lists-new-submit"));
  return await page().findByRole("dialog", {}, LOADED);
}

describe("adding an entry", () => {
  it("adds it to the draft after a confirm: the whole policy at the revision read, with the CSRF header", async () => {
    const { api } = await openForm("");
    type("lists-new-value", "192.0.2.0/25");
    type("lists-new-action", "challenge");
    type("lists-new-paths", "/login, /api/auth");
    type("lists-new-reason", "credential stuffing");
    fireEvent.click(page().getByLabelText("Locked"));
    const dialog = await submit();
    expect(within(dialog).getByTestId("lists-new-summary").textContent).toBe(
      "Range 192.0.2.0/25: challenge on /login, /api/auth",
    );
    expectNone(draftPuts(api.calls), "draft writes before the confirm");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add to the draft" }),
    );
    await page().findByTestId("lists-new-saved", {}, LOADED);
    const [put] = draftPuts(api.calls);
    expect(put?.body).toEqual({
      policy: {
        mode: "enforce",
        lists: [
          ...DRAFT,
          {
            ip: "192.0.2.0/25",
            action: "challenge",
            locked: true,
            paths: ["/login", "/api/auth"],
            reason: "credential stuffing",
          },
        ],
      },
      revision: 2,
    });
    expect(put?.headers.get("x-bun-security-csrf")).toBe("1");
    expectAbsent(page().queryByTestId("lists-entered"), "an account echo");
  });

  it("starts a draft (revision null) from the head when there is none", async () => {
    const { api } = await openForm(
      "",
      policyApi({ head: [{ asn: 64500, action: "block" }] }),
    );
    fireEvent.change(control("lists-new-kind"), { target: { value: "asn" } });
    type("lists-new-value", "AS64501");
    fireEvent.click(
      within(await submit()).getByRole("button", { name: "Add to the draft" }),
    );
    await page().findByTestId("lists-new-saved", {}, LOADED);
    expect(draftPuts(api.calls)[0].body).toEqual({
      policy: {
        mode: "enforce",
        lists: [
          { asn: 64500, action: "block" },
          { asn: 64501, action: "block" },
        ],
      },
      revision: null,
    });
  });

  it("a typed user id is echoed once with its key, and never after a reload", async () => {
    const fake = policyApi({ head: [], draft: DRAFT });
    await openForm("", fake);
    fireEvent.change(control("lists-new-kind"), { target: { value: "user" } });
    type("lists-new-value", "alice");
    fireEvent.click(
      within(await submit()).getByRole("button", { name: "Add to the draft" }),
    );
    const echo = await page().findByTestId("lists-entered", {}, LOADED);
    expect(within(echo).getByTestId("lists-entered-item").textContent).toBe(
      `User id alice → key ${keyOf("alice")}`,
    );
    // A reload: the same API, read afresh.
    cleanup();
    renderApp({ path: "/lists?scope=global", routes: fake.routes });
    await page().findByTestId("lists", {}, LOADED);
    await waitFor(() =>
      expect(page().getAllByTestId("lists-row").length).toBe(2),
    );
    expectAbsent(page().queryByTestId("lists-entered"), "the echo");
    expect(page().getByTestId("lists").textContent).toContain(keyOf("alice"));
    expect(page().getByTestId("lists").textContent).not.toContain("alice");
  });

  it("a revision conflict is shown with a reload; adding again then succeeds", async () => {
    const fake = policyApi({ head: [], draft: DRAFT });
    const { api } = await openForm("", fake);
    fake.state.draft = { ...fake.state.draft!, revision: 5 };
    type("lists-new-value", "192.0.2.9");
    fireEvent.click(
      within(await submit()).getByRole("button", { name: "Add to the draft" }),
    );
    await page().findByTestId("lists-conflict", {}, LOADED);
    const reads = () =>
      api.calls.filter(
        (call) => call.method === "GET" && call.path === "/policies/global",
      ).length;
    const before = reads();
    fireEvent.click(page().getByTestId("lists-reload"));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expectAbsent(page().queryByTestId("lists-conflict"), "the conflict");
    // The form kept what was written.
    expect(control("lists-new-value").value).toBe("192.0.2.9");
    fireEvent.click(
      within(await submit()).getByRole("button", { name: "Add to the draft" }),
    );
    await page().findByTestId("lists-new-saved", {}, LOADED);
    expect(
      draftPuts(api.calls).map(
        (call) => (call.body as { revision: number }).revision,
      ),
    ).toEqual([2, 5]);
  });
});

describe("checks", () => {
  it("flags what the policy would refuse, and sends nothing", async () => {
    const { api } = await openForm("");
    fireEvent.click(page().getByTestId("lists-new-submit"));
    expect(errorOf("lists-new-value")).toBe("Required");
    type("lists-new-value", "999.1.1.1");
    fireEvent.click(page().getByTestId("lists-new-submit"));
    expect(errorOf("lists-new-value")).toBe("Not an IP address or CIDR range");
    type("lists-new-value", "10.0.0.0/7");
    type("lists-new-action", "allow");
    fireEvent.click(page().getByTestId("lists-new-submit"));
    expect(errorOf("lists-new-value")).toBe(
      "An allow entry wider than /8 is refused",
    );
    type("lists-new-value", "203.0.113.0/24");
    type("lists-new-action", "block");
    fireEvent.click(page().getByTestId("lists-new-submit"));
    expect(errorOf("lists-new-value")).toBe("Already listed in this scope");
    expectAbsent(page().queryByRole("dialog"), "the confirm dialog");
    expectNone(draftPuts(api.calls), "draft writes");
  });

  it("a country may not be allowed: the action is not offered, and the form says why", async () => {
    await openForm("");
    const options = () =>
      [
        ...(control("lists-new-action") as unknown as HTMLSelectElement)
          .options,
      ].map((option) => option.value);
    // The control: an address may be allowed.
    expect(options()).toContain("allow");
    type("lists-new-action", "allow");
    fireEvent.change(control("lists-new-kind"), {
      target: { value: "country" },
    });
    expect(options()).not.toContain("allow");
    expect(control("lists-new-action").value).toBe("");
    expect(page().getByTestId("lists-new").textContent).toContain(
      "A whole country cannot be allowed (the policy refuses it)",
    );
  });

  it("without policy:draft the form is not offered", async () => {
    const fake = policyApi({ head: [] });
    renderApp({
      path: "/lists/new?scope=global&ip=192.0.2.1",
      routes: {
        ...fake.routes,
        ...defaultRoutes({ permissions: { global: { "policy:read": true } } }),
        "GET /policies/:scope": fake.routes["GET /policies/:scope"],
      },
    });
    const denied = await page().findByTestId("no-access", {}, LOADED);
    expect(denied.textContent).toContain("policy:draft");
    expectAbsent(page().queryByTestId("lists-new"), "the form");
  });
});

describe("pre-fill", () => {
  /** Each subject parameter, its value, and the kind it fills. */
  const CASES = [
    ["ip", "198.51.100.0/24", "ip", "198.51.100.0/24"],
    ["ip", "2001:db8::1", "ip", "2001:db8::1"],
    ["country", "kp", "country", "KP"],
    ["asn", "13335", "asn", "13335"],
    ["userHash", keyOf("u"), "userHash", keyOf("u")],
    ["apiKeyHash", keyOf("k"), "apiKeyHash", keyOf("k")],
  ] as const;

  for (const [param, given, kind, value] of CASES) {
    it(`?${param}=${given} fills the kind and the value`, async () => {
      const { api } = await openForm(
        `&${param}=${encodeURIComponent(given)}&action=drop&reason=${encodeURIComponent("top offender")}`,
      );
      expect(control("lists-new-kind").value).toBe(kind);
      expect(control("lists-new-value").value).toBe(value);
      expect(control("lists-new-action").value).toBe("drop");
      expect(control("lists-new-reason").value).toBe("top offender");
      expectUndefined(errorOf("lists-new-value"), "the value's error");
      // Nothing is saved until the operator confirms.
      const dialog = await submit();
      expectNone(draftPuts(api.calls), "draft writes before the confirm");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expectNone(draftPuts(api.calls), "draft writes after Cancel");
    });
  }

  it("a bad value opens the form with the field empty and flagged, never echoed", async () => {
    await openForm("&userHash=alice-raw-id&action=block");
    expect(control("lists-new-kind").value).toBe("userHash");
    expect(control("lists-new-value").value).toBe("");
    expect(errorOf("lists-new-value")).toBe(
      "The link's user key was not valid: enter it again",
    );
    expect(page().getByTestId("lists-new").textContent).not.toContain(
      "alice-raw-id",
    );
    // Typing clears the flag.
    type("lists-new-value", keyOf("alice"));
    expectUndefined(errorOf("lists-new-value"), "the value's error");
  });

  it("a bad action, or allow for a country, leaves the action empty and flagged", async () => {
    await openForm("&ip=192.0.2.1&action=nuke");
    expect(control("lists-new-value").value).toBe("192.0.2.1");
    expect(control("lists-new-action").value).toBe("");
    expect(errorOf("lists-new-action")).toBe(
      "The link's action was not one of allow, block, challenge, drop",
    );
    cleanup();
    await openForm("&country=FR&action=allow");
    expect(control("lists-new-value").value).toBe("FR");
    expect(control("lists-new-action").value).toBe("");
    expect(errorOf("lists-new-action")).toBe(
      "A whole country cannot be allowed: choose another action",
    );
  });

  it("two subjects pre-fill neither", async () => {
    await openForm("&ip=192.0.2.1&asn=13335");
    expect(control("lists-new-kind").value).toBe("");
    expect(control("lists-new-value").value).toBe("");
    expect(errorOf("lists-new-kind")).toBe(
      "The link named more than one subject (ip, asn): choose one",
    );
  });

  it("a bad address and a bad ASN are flagged too", async () => {
    await openForm("&ip=not-an-ip");
    expect(control("lists-new-value").value).toBe("");
    expect(errorOf("lists-new-value")).toBe(
      "The link's ip address or cidr range was not valid: enter it again",
    );
    cleanup();
    await openForm("&asn=AS99999999999");
    expect(control("lists-new-kind").value).toBe("asn");
    expect(control("lists-new-value").value).toBe("");
  });
});
