/**
 * The services and groups screens' query keys, every group and service
 * read at once (the tree and the pickers need them all; at most 2,000),
 * and a permission on an item's own scope.
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import type { Routes } from "../../api/routes.gen";
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../../api/client";
import { queryKeys } from "../../api/keys";
import { useSecurityClient } from "../../context";
import { canPerform, useGlobalCanFn } from "../../meta/hooks";

/** A service. */
export type ServiceDto = Routes["GET /services/:id"]["responses"][200];

/** A group. */
export type GroupDto = Routes["GET /groups/:id"]["responses"][200];

/** The query keys. */
export const servicesKeys = {
  /** Everything of the services and groups screens. */
  all: () => ["services"] as const,
  /** A page of services. */
  page: (cursor: string | undefined, limit: number) =>
    ["services", "page", cursor ?? "", limit] as const,
  /** One service. */
  service: (id: string) => ["services", "one", id] as const,
  /** Every group. */
  groups: () => ["services", "groups"] as const,
  /** Every service, for the groups tree. */
  allServices: () => ["services", "every"] as const,
  /** The last hour's traffic by service. */
  traffic: () => ["services", "traffic"] as const,
  /** A service's effective policy. */
  effective: (id: string) => ["services", "effective", id] as const,
  /** A service's latest bundle version. */
  bundle: (id: string) => ["services", "bundle", id] as const,
};

/** The most items read across pages. */
const MAX_ITEMS = 2_000;

/** Every group (at most 2,000). */
export function useAllGroups(enabled = true) {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: servicesKeys.groups(),
    enabled,
    queryFn: async ({ signal }) => {
      const out: GroupDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await dataOf(
          client.get("/groups", {
            query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
            signal,
          }),
        );
        out.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined && out.length < MAX_ITEMS);
      return out;
    },
  });
}

/** Every service (at most 2,000). */
export function useAllServices(enabled = true) {
  const { client } = useSecurityClient();
  return useQuery({
    queryKey: servicesKeys.allServices(),
    enabled,
    queryFn: async ({ signal }) => {
      const out: ServiceDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await dataOf(
          client.get("/services", {
            query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
            signal,
          }),
        );
        out.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined && out.length < MAX_ITEMS);
      return out;
    },
  });
}

/** `id` and every group under it (its children, theirs, …). */
export function descendantsOf(
  id: string,
  groups: readonly { readonly id: string; readonly parent: string | null }[],
): Set<string> {
  const under = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const group of groups) {
      if (
        group.parent !== null &&
        under.has(group.parent) &&
        !under.has(group.id)
      ) {
        under.add(group.id);
        grew = true;
      }
    }
  }
  return under;
}

/**
 * Whether `permission` is allowed on `scope` (a service's or a group's own;
 * the API answers a group's binding for its groups and services under it,
 * so a binding there covers them). `false` while it is read.
 */
export function useCanOn(
  scope: string,
  permission: SecurityApiPermission,
): boolean {
  const { client } = useSecurityClient();
  const global = useGlobalCanFn()(permission);
  const answer = useQuery({
    queryKey: queryKeys.permissions(scope),
    enabled: scope !== "global" && !global,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(client.get("/meta/permissions", { query: { scope }, signal })),
  });
  if (global) return true;
  return answer.data !== undefined && canPerform(answer.data, permission);
}
