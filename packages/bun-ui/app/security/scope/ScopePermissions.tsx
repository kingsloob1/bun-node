/**
 * The permissions on the scope on screen (`/meta/permissions?scope=`),
 * layered over the global ones, so `useCan` answers for that scope (ui.md
 * §2's scoped refinement).
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../api/client";
import { queryKeys } from "../api/keys";
import { useSecurityClient } from "../context";
import {
  PermissionScopeStatusContext,
  ScopedPermissionsContext,
} from "../meta/hooks";

/** Props of {@link ScopePermissions}. */
export interface ScopePermissionsProps {
  /** The scope on screen. */
  scope: string;
  /** The screen. */
  children: ReactNode;
}

/** See the module's description. */
export function ScopePermissions({ scope, children }: ScopePermissionsProps) {
  const { client } = useSecurityClient();
  const scoped = useQuery({
    queryKey: queryKeys.permissions(scope),
    queryFn: ({ signal }) =>
      dataOf(client.get("/meta/permissions", { query: { scope }, signal })),
    enabled: scope !== "global",
    staleTime: 60_000,
  });
  if (scope === "global") return <>{children}</>;
  return (
    <PermissionScopeStatusContext
      value={scoped.isPending ? "pending" : "settled"}
    >
      <ScopedPermissionsContext value={scoped.data ?? null}>
        {children}
      </ScopedPermissionsContext>
    </PermissionScopeStatusContext>
  );
}
