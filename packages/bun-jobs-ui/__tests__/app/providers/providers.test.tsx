import type {
  ProviderDto,
  ProviderListDto,
  ProviderValidationDto,
} from "../../../app/api/types";
import type { MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { validationSummary } from "../../../app/screens/providers/providerText";
import { expectAbsent } from "../assert";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/**
 * The Providers screen (`/providers`): the compute providers configured in
 * the API's process, their readiness, "Test connection" (`POST
 * /providers/:id/validate`) and their config schema.
 *
 * The rules it keeps: the screen and its nav entry need the opt-in
 * `providers.read` and the routes served (`features.providers`); Test
 * connection needs the opt-in `providers.validate` (never read-only) and a
 * provider with a preflight; a failed preflight is an answer saying whose
 * problem it is, not an error.
 */

/** A provider as `GET /providers` lists it. */
function provider(overrides: Partial<ProviderDto> = {}): ProviderDto {
  return {
    id: "@acme/bun-jobs-ecs@1.2.0#1",
    provider: {
      name: "@acme/bun-jobs-ecs",
      version: "1.2.0",
      kind: "ecs",
      displayName: "Amazon ECS",
      apiVersion: { core: "0.1", summon: "0.1" },
    },
    readiness: "ready",
    facts: { cluster: "jobs-prod", region: "eu-west-1" },
    preflight: true,
    configSchema: true,
    ...overrides,
  };
}

/** `GET /providers` answering these providers. */
function list(providers: ProviderDto[]): ProviderListDto {
  return { api: { core: "0.1", summon: "0.1" }, providers };
}

/** The path of a provider's route, as the mock matches it. */
function path(id: string, tail: string): string {
  return `/providers/${encodeURIComponent(id)}${tail}`;
}

/** Every grant, the two opt-in provider actions included. */
const BOTH = permissionsFixture({
  "providers.read": true,
  "providers.validate": true,
});

/** Opens `/providers` with these handlers, and resolves the screen. */
async function openScreen(handlers: Record<string, MockReply> = {}) {
  visit("/jobs/providers");
  const rendered = renderApp({
    handlers: {
      "GET /meta/permissions": { body: BOTH },
      "GET /providers": { body: list([provider()]) },
      ...handlers,
    },
  });
  const screen = await page().findByTestId("providers-screen");
  return { ...rendered, screen };
}

/** The card of provider `id`, once it rendered. */
async function card(id = provider().id): Promise<HTMLElement> {
  return page().findByTestId(`provider-${id}`);
}

describe("the Providers screen", () => {
  it("lists each provider with its readiness, id, package and facts", async () => {
    await openScreen({
      "GET /providers": {
        body: list([
          provider(),
          provider({
            id: "@acme/bun-jobs-fly@0.3.0#1",
            provider: {
              ...provider().provider,
              name: "@acme/bun-jobs-fly",
              version: "0.3.0",
              kind: "fly",
              displayName: undefined,
            },
            readiness: "pending",
            facts: {},
          }),
        ]),
      },
    });
    const ecs = await card();
    expect(within(ecs).getByTestId("provider-readiness").textContent).toBe(
      "Ready",
    );
    expect(ecs.textContent).toContain("@acme/bun-jobs-ecs@1.2.0#1");
    expect(ecs.textContent).toContain("jobs-prod");
    const fly = await card("@acme/bun-jobs-fly@0.3.0#1");
    expect(within(fly).getByTestId("provider-readiness").textContent).toBe(
      "Pending",
    );
    // No display name: the kind names it.
    expect(page().getByText("fly", { selector: "h2, h3" })).not.toBeNull();
  });

  it("says when nothing is configured", async () => {
    await openScreen({ "GET /providers": { body: list([]) } });
    await waitFor(() =>
      expect(page().getByText("No providers configured")).not.toBeNull(),
    );
  });

  it("reads nothing without providers.read, and is not in the nav", async () => {
    visit("/jobs/providers");
    const { calls } = renderApp({
      handlers: { "GET /providers": { body: list([provider()]) } },
    });
    await page().findByRole("navigation", { name: "Sections" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(page().queryByRole("link", { name: "Providers" }));
    expect(calls.some((call) => call.path === "/providers")).toBe(false);
  });
});

describe("Test connection", () => {
  /** Runs Test connection on the ECS card, answered with `result`. */
  async function test(result: MockReply) {
    const { calls } = await openScreen({
      [`POST ${path(provider().id, "/validate")}`]: result,
    });
    const ecs = await card();
    fireEvent.click(
      within(ecs).getByRole("button", {
        name: "Test connection: Amazon ECS",
      }),
    );
    const found = await within(ecs).findByTestId("provider-test-result");
    return { found, calls };
  }

  it("runs the preflight and lists its checks", async () => {
    const answer: ProviderValidationDto = {
      id: provider().id,
      ok: true,
      checks: [
        { id: "credentials", status: "pass" },
        { id: "cluster", status: "warn", detail: "no spare capacity now" },
      ],
    };
    const { found, calls } = await test({ body: answer });
    expect(found.dataset.ok).toBe("true");
    expect(found.textContent).toContain("Connected, with 1 warning.");
    expect(
      within(found).getByTestId("provider-check-cluster").textContent,
    ).toContain("no spare capacity now");
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toContain(encodeURIComponent(provider().id));
  });

  it("says whose problem a failure is: credentials, not the platform", async () => {
    const { found } = await test({
      body: {
        id: provider().id,
        ok: false,
        checks: [],
        error: { kind: "auth", detail: "AccessDeniedException" },
      },
    });
    expect(found.dataset.ok).toBe("false");
    expect(found.textContent).toBe(
      "Credentials problem: the platform refused them. (AccessDeniedException)",
    );
  });

  it("names an invalid config's paths, and a timeout as no answer", async () => {
    expect(
      validationSummary({
        id: "x",
        ok: false,
        checks: [],
        error: { kind: "misconfigured", detail: "invalid config: region, dsn" },
      }),
    ).toBe("Configuration problem: invalid region, dsn.");
    expect(
      validationSummary({
        id: "x",
        ok: false,
        checks: [],
        error: { kind: "transient", detail: "timeout" },
      }),
    ).toBe("No answer: the preflight timed out.");
    expect(
      validationSummary({
        id: "x",
        ok: false,
        checks: [{ id: "credentials", status: "fail" }],
      }),
    ).toBe("Connection failed: 1 of 1 checks failed.");
  });

  it("is offered only for a provider with a preflight, and to a caller who may validate", async () => {
    // No preflight.
    const first = await openScreen({
      "GET /providers": { body: list([provider({ preflight: false })]) },
    });
    expectAbsent(
      within(await card()).queryByRole("button", { name: /Test connection/ }),
    );
    first.unmount();
    // No providers.validate.
    const second = await openScreen({
      "GET /meta/permissions": {
        body: permissionsFixture({ "providers.read": true }),
      },
    });
    expectAbsent(
      within(await card()).queryByRole("button", { name: /Test connection/ }),
    );
    second.unmount();
    // Read-only: a mutation, so never, even when named.
    await openScreen({
      "GET /meta": { body: metaFixture({ readOnly: true }) },
    });
    expectAbsent(
      within(await card()).queryByRole("button", { name: /Test connection/ }),
    );
  });
});

describe("the config schema", () => {
  it("is read only when asked for, and shown as it is", async () => {
    const { calls } = await openScreen({
      [`GET ${path(provider().id, "/schema")}`]: {
        body: {
          id: provider().id,
          target: "draft-2020-12",
          schema: { type: "object", required: ["region"] },
        },
      },
    });
    const ecs = await card();
    expect(calls.some((call) => call.path.endsWith("/schema"))).toBe(false);
    fireEvent.click(within(ecs).getByRole("button", { name: "Config schema" }));
    const schema = await within(ecs).findByTestId("provider-schema");
    expect(schema.textContent).toContain("region");
  });

  it("is not offered for a provider that publishes none", async () => {
    await openScreen({
      "GET /providers": { body: list([provider({ configSchema: false })]) },
    });
    expectAbsent(
      within(await card()).queryByRole("button", { name: "Config schema" }),
    );
  });
});
