/**
 * Loads what every screen needs before the first one renders: `/meta`, the
 * global permissions and who the operator is (their role bindings, for the
 * scope picker). Shows the kit's loading state, and on a failure the
 * bootstrap error — "Sign in required" for a `401`, with the break-glass
 * link when the API has the account (the user's decision).
 */
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { MetaGate } from "../../kit/MetaGate";
import { dataOf } from "../api/client";
import { queryKeys } from "../api/keys";
import { useSecurityClient } from "../context";
import { SignInRequired } from "../screens/SignInRequired";
import { MeContext } from "./me";
import { MetaContext } from "./hooks";

/** Props of {@link MetaProvider}. */
export interface MetaProviderProps {
  /** Rendered once loaded. */
  children: ReactNode;
}

/** See the module's description. */
export function MetaProvider({ children }: MetaProviderProps) {
  const { client } = useSecurityClient();
  const meta = useQuery({
    queryKey: queryKeys.meta(),
    queryFn: ({ signal }) => dataOf(client.get("/meta", { signal })),
    staleTime: 60_000,
  });
  const permissions = useQuery({
    queryKey: queryKeys.permissions("global"),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/meta/permissions", { query: { scope: "global" }, signal }),
      ),
    staleTime: 60_000,
  });
  const me = useQuery({
    queryKey: queryKeys.me(),
    queryFn: ({ signal }) => dataOf(client.get("/operators/me", { signal })),
    staleTime: 60_000,
  });
  const value = useMemo(
    () =>
      meta.data && permissions.data && me.data
        ? { meta: meta.data, permissions: permissions.data, me: me.data }
        : null,
    [meta.data, permissions.data, me.data],
  );
  return (
    <MetaGate
      value={value}
      error={meta.error ?? permissions.error ?? me.error}
      loadingLabel="Loading the security API"
      renderError={(error) => (
        <SignInRequired
          error={error}
          onRetry={() => {
            void meta.refetch();
            void permissions.refetch();
            void me.refetch();
          }}
        />
      )}
    >
      {(loaded) => (
        <MetaContext
          value={{ meta: loaded.meta, permissions: loaded.permissions }}
        >
          <MeContext value={loaded.me}>{children}</MeContext>
        </MetaContext>
      )}
    </MetaGate>
  );
}
