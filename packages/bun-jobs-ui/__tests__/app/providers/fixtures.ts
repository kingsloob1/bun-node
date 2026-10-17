import type { ProviderDto, ProviderListDto } from "../../../app/api/types";

/** Fixtures of the Providers screen, typed against the contract. */

/** A provider as `GET /providers` lists it. */
export function providerFixture(
  overrides: Partial<ProviderDto> = {},
): ProviderDto {
  return {
    id: "@acme/bun-jobs-ecs@1.2.0~1",
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
export function providerList(providers: ProviderDto[]): ProviderListDto {
  return { api: { core: "0.1", summon: "0.1" }, providers };
}
