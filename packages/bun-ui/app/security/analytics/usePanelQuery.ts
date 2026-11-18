/**
 * A panel's read (PR-U2): keyed by the scope, the range and the panel, and
 * refetched while the range ends now (`liveMs`, default 10 s; a custom
 * range never refetches by itself).
 */
import type { ReadContext } from "./api";
import { useQuery } from "@tanstack/react-query";
import { useSecurityClient } from "../context";
import { ANALYTICS_RANGE, endsNow } from "./range";
import { useAnalyticsView } from "./context";

/** The query keys' root, for every analytics read. */
export const ANALYTICS_KEY = "analytics";

/** Options of {@link usePanelQuery}. */
export interface PanelQueryOptions {
  /** Whether to read at all (a permission). Default `true`. */
  readonly enabled?: boolean;
  /** How often to refetch while the range ends now, ms. Default 10,000. */
  readonly liveMs?: number;
  /** More of the key (a selector's value). */
  readonly key?: readonly unknown[];
}

/** See the module's description. */
export function usePanelQuery<T>(
  name: string,
  read: (context: ReadContext) => Promise<T>,
  options: PanelQueryOptions = {},
) {
  const { client } = useSecurityClient();
  const { scope, range } = useAnalyticsView();
  return useQuery({
    queryKey: [
      ANALYTICS_KEY,
      scope,
      ANALYTICS_RANGE.writeRange(range) ?? "default",
      name,
      ...(options.key ?? []),
    ],
    enabled: options.enabled ?? true,
    refetchInterval: endsNow(range) ? (options.liveMs ?? 10_000) : false,
    queryFn: ({ signal }) => read({ client, scope, range, signal }),
  });
}
