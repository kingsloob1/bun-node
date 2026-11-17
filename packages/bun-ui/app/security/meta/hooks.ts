/**
 * The security app's permissions (ui.md §2): `/meta`, and
 * `/meta/permissions` for the scope on screen, on the kit's permission
 * core. An element the operator may not use is absent, not disabled.
 */
import type { SecurityApiPermission } from "@kingsleyweb/bun-security/control/contract";
import type { Routes } from "../api/routes.gen";
import { createMetaHooks } from "../../kit/meta";

/** `GET /meta`. */
export type MetaDto = Routes["GET /meta"]["responses"][200];

/** `GET /meta/permissions?scope=`: each permission's answer on one scope. */
export type PermissionsDto = Routes["GET /meta/permissions"]["responses"][200];

/** Whether `permissions` allow `permission`. */
export function canPerform(
  permissions: PermissionsDto,
  permission: SecurityApiPermission,
): boolean {
  return (
    (permissions.permissions as Readonly<Record<string, boolean>>)[
      permission
    ] === true
  );
}

/** The security app's permission core. */
const hooks = createMetaHooks<MetaDto, PermissionsDto, SecurityApiPermission>(
  canPerform,
);

/** The loaded meta and global permissions. */
export const MetaContext = hooks.MetaContext;
/** The permissions on the scope on screen. */
export const ScopedPermissionsContext = hooks.ScopedPermissionsContext;
/** Whether they are still loading. */
export const PermissionScopeStatusContext = hooks.PermissionScopeStatusContext;
/** `GET /meta`. */
export const useMeta = hooks.useMeta;
/** The permissions on the scope on screen (or global). */
export const usePermissions = hooks.usePermissions;
/** Whether `permission` is allowed on the scope on screen. */
export const useCan = hooks.useCan;
/** `useCan` as a function. */
export const useCanFn = hooks.useCanFn;
/** Whether the scope's permissions have loaded. */
export const usePermissionsSettled = hooks.usePermissionsSettled;
/** Whether `permission` is allowed on `global` (whatever scope is on screen). */
export const useGlobalCanFn = hooks.useUntargetedCanFn;
