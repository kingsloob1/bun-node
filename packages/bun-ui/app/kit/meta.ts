/**
 * The permission core every UI's app shares (moved from the jobs app for
 * the security UI, PR-U1): a UI's `/meta` and permissions, loaded once and
 * held in a context; a screen's narrower permissions (a queue, a service)
 * layered over them; `useCan` answering from the narrowest. An element the
 * operator may not use is absent, not disabled (ui.md §2), so screens ask
 * `useCan` and render nothing when it says no.
 *
 * {@link createMetaHooks} binds the core to a UI's own meta and permission
 * shapes and its question (`can(permissions, action)`); {@link MetaGate}
 * renders the loading and bootstrap-error states around it.
 */
import type { Context } from "react";
import { createContext, use, useMemo } from "react";

/** Whether a scoped permission set is in force, loading, or not asked for. */
export type PermissionScopeStatus = "unscoped" | "pending" | "settled";

/** What a UI's meta context holds. */
export interface MetaContextValue<TMeta, TPermissions> {
  /** `GET /meta`. */
  meta: TMeta;
  /** The permissions answered without a target (or for the default scope). */
  permissions: TPermissions;
}

/** The contexts and hooks of a UI's permission core. */
export interface MetaHooks<TMeta, TPermissions, TAction> {
  /** The loaded meta and untargeted permissions. */
  readonly MetaContext: Context<MetaContextValue<TMeta, TPermissions> | null>;
  /** A screen's narrower permissions, when one is in force. */
  readonly ScopedPermissionsContext: Context<TPermissions | null>;
  /** Whether the narrower permissions are still loading. */
  readonly PermissionScopeStatusContext: Context<PermissionScopeStatus>;
  /** `can`, as given. */
  readonly canPerform: (permissions: TPermissions, action: TAction) => boolean;
  /** The meta (inside a loaded provider). */
  readonly useMeta: () => TMeta;
  /** The narrowest permissions in force. */
  readonly usePermissions: () => TPermissions;
  /** Whether `action` is allowed by the narrowest permissions. */
  readonly useCan: (action: TAction) => boolean;
  /** `useCan` as a function, for lists. */
  readonly useCanFn: () => (action: TAction) => boolean;
  /** Whether `action` is allowed without a target. */
  readonly useUntargetedCanFn: () => (action: TAction) => boolean;
  /** `false` while a screen's narrower permissions are loading. */
  readonly usePermissionsSettled: () => boolean;
}

/** Binds the permission core to a UI; see the module's description. */
export function createMetaHooks<TMeta, TPermissions, TAction>(
  can: (permissions: TPermissions, action: TAction) => boolean,
): MetaHooks<TMeta, TPermissions, TAction> {
  const MetaContext = createContext<MetaContextValue<
    TMeta,
    TPermissions
  > | null>(null);
  const ScopedPermissionsContext = createContext<TPermissions | null>(null);
  const PermissionScopeStatusContext =
    createContext<PermissionScopeStatus>("unscoped");
  const useMetaContext = (): MetaContextValue<TMeta, TPermissions> => {
    const value = use(MetaContext);
    if (!value) {
      throw new Error("useMeta must be used inside a loaded <MetaProvider>");
    }
    return value;
  };
  const usePermissions = (): TPermissions => {
    const scoped = use(ScopedPermissionsContext);
    const { permissions } = useMetaContext();
    return scoped ?? permissions;
  };
  return Object.freeze({
    MetaContext,
    ScopedPermissionsContext,
    PermissionScopeStatusContext,
    canPerform: can,
    useMeta: () => useMetaContext().meta,
    usePermissions,
    useCan: (action: TAction) => can(usePermissions(), action),
    useCanFn: () => {
      const permissions = usePermissions();
      return useMemo(
        () => (action: TAction) => can(permissions, action),
        [permissions],
      );
    },
    useUntargetedCanFn: () => {
      const { permissions } = useMetaContext();
      return useMemo(
        () => (action: TAction) => can(permissions, action),
        [permissions],
      );
    },
    usePermissionsSettled: () =>
      use(PermissionScopeStatusContext) !== "pending",
  });
}
