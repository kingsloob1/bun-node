import type { JobsApiAction } from "../api/contract";
import type { MetaDto, Permissions } from "../api/types";
import type {
  MetaContextValue as KitMetaContextValue,
  PermissionScopeStatus,
} from "../../kit/meta";
import { createMetaHooks } from "../../kit/meta";

/** A feature flag of `MetaDto.features`. */
export type FeatureName = keyof MetaDto["features"];

/** What `<MetaProvider>` holds once loaded. */
export type MetaContextValue = KitMetaContextValue<MetaDto, Permissions>;

/** Whether `permissions` allow `action`. */
export function canPerform(
  permissions: Permissions,
  action: JobsApiAction,
): boolean {
  return permissions.actions[action] === true;
}

/** The jobs app's permission core, on the kit's (`app/kit/meta.tsx`). */
const hooks = createMetaHooks<MetaDto, Permissions, JobsApiAction>(canPerform);

/** The loaded meta and untargeted permissions. */
export const MetaContext = hooks.MetaContext;
/** A screen's narrower permissions (a queue, a runner). */
export const ScopedPermissionsContext = hooks.ScopedPermissionsContext;
/** Whether the narrower permissions are still loading. */
export const PermissionScopeStatusContext = hooks.PermissionScopeStatusContext;
export type { PermissionScopeStatus };
/** `false` while a screen's narrower permissions are loading. */
export const usePermissionsSettled = hooks.usePermissionsSettled;
/** `GET /meta`. */
export const useMeta = hooks.useMeta;
/** The narrowest permissions in force. */
export const usePermissions = hooks.usePermissions;
/** Whether `action` is allowed. */
export const useCan = hooks.useCan;
/** `useCan` as a function. */
export const useCanFn = hooks.useCanFn;
/** Whether `action` is allowed without a target. */
export const useUntargetedCanFn = hooks.useUntargetedCanFn;

/** Whether the API reports `name` on. */
export function useFeature(name: FeatureName): boolean {
  return useMeta().features[name];
}
