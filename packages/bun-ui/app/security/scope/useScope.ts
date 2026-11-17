/** The scope on screen (`?scope=`), or the operator's default when the URL names none. */
import { useCallback, useMemo } from "react";
import { useGlobalCanFn } from "../meta/hooks";
import { useMe } from "../meta/me";
import { useRouter } from "../routing";
import { defaultScope, isScope, SCOPE_PARAM } from "./scope";

/** The scope on screen, and how to change it. */
export interface ScopeState {
  /** The scope; `null` when the URL names none and the operator can read none. */
  readonly scope: string | null;
  /** Whether it came from the URL (rather than the default). */
  readonly explicit: boolean;
  /** Moves to `scope`, on the same screen. */
  readonly setScope: (scope: string) => void;
}

/** See the module's description. */
export function useScope(): ScopeState {
  const { location, navigate } = useRouter();
  const me = useMe();
  // The default reads the global permissions, never a scoped set.
  const canReadGlobal = useGlobalCanFn()("policy:read");
  const named = new URLSearchParams(location.search).get(SCOPE_PARAM);
  const explicit = named !== null && isScope(named);
  const scope = explicit ? named : defaultScope(canReadGlobal, me.roles);
  const setScope = useCallback(
    (next: string) => {
      const params = new URLSearchParams(location.search);
      params.set(SCOPE_PARAM, next);
      // Another scope's cursor means nothing here: the list starts again.
      params.delete("page");
      navigate(`${location.path ?? "/"}?${params.toString()}`);
    },
    [location.path, location.search, navigate],
  );
  return useMemo(
    () => ({ scope, explicit, setScope }),
    [scope, explicit, setScope],
  );
}
