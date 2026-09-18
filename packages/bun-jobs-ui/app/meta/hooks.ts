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

/** `GET /meta/permissions`. */
export function usePermissions(): Permissions {
  return useMetaContext().permissions;
}

/** Whether the caller may perform `action` (see {@link canPerform}). */
export function useCan(action: JobsApiAction): boolean {
  return canPerform(useMetaContext().permissions, action);
}

/** A predicate over actions, for checking several at once. */
export function useCanFn(): (action: JobsApiAction) => boolean {
  const { permissions } = useMetaContext();
  return useMemo(
    () => (action: JobsApiAction) => canPerform(permissions, action),
    [permissions],
  );
}

/** Whether the backend supports a feature (`MetaDto.features`). */
export function useFeature(name: FeatureName): boolean {
  return useMetaContext().meta.features[name];
}
