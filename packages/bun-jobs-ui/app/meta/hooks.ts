import type { JobsApiAction } from "../api/contract";
import type { MetaDto, Permissions } from "../api/types";
import { createContext, use, useMemo } from "react";

/** A feature flag of `MetaDto.features`. */
export type FeatureName = keyof MetaDto["features"];

/** What the bootstrap provides once `/meta` and `/meta/permissions` loaded. */
export interface MetaContextValue {
  /** `GET /meta`. */
  meta: MetaDto;
  /** `GET /meta/permissions` (untargeted). */
  permissions: Permissions;
}

/** Carries the loaded meta and permissions. */
export const MetaContext = createContext<MetaContextValue | null>(null);

/**
 * Permissions targeted at what the current screen shows (`/meta/permissions?queue=`
 * or `?runner=`), set by `<PermissionScope>`. `null` outside one, or while it
 * loads: the untargeted map applies then.
 */
export const ScopedPermissionsContext = createContext<Permissions | null>(null);

/**
 * Where the nearest `<PermissionScope>` is: `"unscoped"` outside one,
 * `"pending"` while its targeted request is in flight, `"settled"` once it
 * answered or failed (a failure keeps the untargeted map).
 */
export type PermissionScopeStatus = "unscoped" | "pending" | "settled";

/** Carries the nearest `<PermissionScope>`'s {@link PermissionScopeStatus}. */
export const PermissionScopeStatusContext =
  createContext<PermissionScopeStatus>("unscoped");

/**
 * Whether the permissions that apply here are final: `false` only while a
 * `<PermissionScope>`'s targeted answer is still loading. A screen that must
 * not send a request the target's own map might refuse (a job's data, say)
 * waits for this before fetching.
 */
export function usePermissionsSettled(): boolean {
  return use(PermissionScopeStatusContext) !== "pending";
}

/**
 * Whether the caller may perform `action`: `true` only when the action is
 * present **and** `true`. An action whose routes are pruned (mode, `readOnly`,
 * `actions`, driver capability) is absent from the map, which is `false` too.
 */
export function canPerform(
  permissions: Permissions,
  action: JobsApiAction,
): boolean {
  return permissions.actions[action] === true;
}

/** The bootstrap's context, or a clear error outside a loaded `<MetaProvider>`. */
function useMetaContext(): MetaContextValue {
  const value = use(MetaContext);
  if (!value) {
    throw new Error("useMeta must be used inside a loaded <MetaProvider>");
  }
  return value;
}

/** `GET /meta`. */
export function useMeta(): MetaDto {
  return useMetaContext().meta;
}

/**
 * The permissions that apply here: the innermost `<PermissionScope>`'s
 * targeted map once it has loaded, else the untargeted one. Advisory either
 * way: `authorize` may decide per job and change its mind, so the API's 403
 * on the request itself stays authoritative.
 */
export function usePermissions(): Permissions {
  const scoped = use(ScopedPermissionsContext);
  const { permissions } = useMetaContext();
  return scoped ?? permissions;
}

/** Whether the caller may perform `action` here (see {@link canPerform}, {@link usePermissions}). */
export function useCan(action: JobsApiAction): boolean {
  return canPerform(usePermissions(), action);
}

/** A predicate over actions, for checking several at once. */
export function useCanFn(): (action: JobsApiAction) => boolean {
  const permissions = usePermissions();
  return useMemo(
    () => (action: JobsApiAction) => canPerform(permissions, action),
    [permissions],
  );
}

/** Whether the backend supports a feature (`MetaDto.features`). */
export function useFeature(name: FeatureName): boolean {
  return useMetaContext().meta.features[name];
}
