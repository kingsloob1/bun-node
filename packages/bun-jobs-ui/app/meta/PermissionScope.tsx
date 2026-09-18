import type { ReactNode } from "react";
import type { PermissionsTarget } from "../api/client";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../api/queryKeys";
import { useApiClient } from "../context";
import { useParams } from "../routing";
import { ScopedPermissionsContext } from "./hooks";

/** Props of {@link PermissionScope}. */
export interface PermissionScopeProps {
  /** The queue or runner the screen shows; its actions are asked about it. */
  target: PermissionsTarget;
  /** The screen. */
  children: ReactNode;
}

/**
 * Asks `/meta/permissions` about one queue or runner, so a host whose
 * `authorize` decides per target gets buttons that match. Until the answer
 * arrives (or if it fails), the untargeted map from the bootstrap applies, so
 * the screen never waits on it.
 */
export function PermissionScope({ target, children }: PermissionScopeProps) {
  const api = useApiClient();
  const scoped = useQuery({
    queryKey: queryKeys.permissions(target),
    queryFn: ({ signal }) => api.getPermissions(target, signal),
  });
  return (
    <ScopedPermissionsContext value={scoped.data ?? null}>
      {children}
    </ScopedPermissionsContext>
  );
}

/** Props of {@link QueuePermissionScope}. */
export interface QueuePermissionScopeProps {
  /** The screen, routed under `/queues/:queue`. */
  children: ReactNode;
}

/** A {@link PermissionScope} for the queue in the route's `:queue` param. */
export function QueuePermissionScope({ children }: QueuePermissionScopeProps) {
  const { queue = "" } = useParams<{ queue: string }>();
  return <PermissionScope target={{ queue }}>{children}</PermissionScope>;
}
