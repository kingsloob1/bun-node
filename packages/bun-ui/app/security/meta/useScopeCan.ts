/**
 * The permissions on a scope other than the one on screen (an agent's
 * service, an alert rule's or an approval's scope): `GET
 * /meta/permissions?scope=`, cached as the app's permission reads are.
 * Until they load, nothing is allowed (an element is absent, not
 * disabled).
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../api/client";
import { queryKeys } from "../api/keys";
import { useSecurityClient } from "../context";
import { canPerform } from "./hooks";

/** Whether each permission is allowed on `scope` (`undefined`: not known yet, so nothing). */
export function useScopeCan(
  scope: string | undefined,
): (permission: SecurityApiPermission) => boolean {
  const { client } = useSecurityClient();
  const permissions = useQuery({
    queryKey: queryKeys.permissions(scope ?? "global"),
    enabled: scope !== undefined,
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/meta/permissions", {
          query: { scope: scope ?? "global" },
          signal,
        }),
      ),
  });
  return (permission) =>
    permissions.data !== undefined && canPerform(permissions.data, permission);
}
