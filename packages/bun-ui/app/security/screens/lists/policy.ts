/**
 * The scope's policy for the lists screens (ui.md §3, draft and publish):
 * `GET /policies/:scope` (the draft and the head's id), the head's content
 * (`GET /policies/:scope/versions/:id`), and on a service the entries it
 * inherits (`GET /services/:id/effective`, each entry with the scope it
 * came from). Changes go through the draft: {@link useSaveDraft} writes
 * the whole policy at the revision read (`PUT /policies/:scope/draft`, a
 * stale revision is a `409`), through step-up (a service flagged
 * `requireStepUp` asks for one).
 */
import type { Routes } from "../../api/routes.gen";
import type { ListEntryDto } from "./entries";
import type { ListRow } from "./filters";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { useSecurityClient } from "../../context";
import { useRefetchInterval } from "../../live/context";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { withStepUp } from "../../stepUp";
import { entryKey, isRecord, listsOf } from "./entries";

/** `GET /policies/:scope`. */
export type PolicyDto = Routes["GET /policies/:scope"]["responses"][200];

/** `PUT /policies/:scope/draft`'s answer. */
export type DraftDto = Routes["PUT /policies/:scope/draft"]["responses"][200];

/** The lists screens' query keys. */
export const listsKeys = {
  /** Everything of a scope. */
  all: (scope: string) => ["lists", scope] as const,
  /** `GET /policies/:scope`. */
  policy: (scope: string) => ["lists", scope, "policy"] as const,
  /** A version's content. */
  version: (scope: string, id: string) =>
    ["lists", scope, "version", id] as const,
  /** A service's or a group's effective policy. */
  effective: (scope: string) => ["lists", scope, "effective"] as const,
};

/** The service a scope names, or `null`. */
export function serviceOf(scope: string): string | null {
  return scope.startsWith("service:") ? scope.slice("service:".length) : null;
}

/** The group a scope names, or `null`. */
export function groupOf(scope: string): string | null {
  return scope.startsWith("group:") ? scope.slice("group:".length) : null;
}

/** The scope's policy, read for the lists. */
export interface PolicyLists {
  /** Still loading. */
  readonly pending: boolean;
  /** The read's failure, if any. */
  readonly error: unknown;
  /** `GET /policies/:scope`'s answer. */
  readonly policy: PolicyDto | undefined;
  /** The policy edited: the draft's, else the head's, else empty. */
  readonly base: Record<string, unknown>;
  /** The head's policy (empty before the first publish). */
  readonly head: Record<string, unknown>;
  /** The base's entries. */
  readonly lists: ListEntryDto[];
  /** The head's entries. */
  readonly headLists: ListEntryDto[];
  /** The entries inherited from the scopes above (a service's or a group's; none on global). */
  readonly inherited: ListRow[];
  /** Why the inherited entries could not be read, if they could not. */
  readonly inheritedError: unknown;
  /** Reads everything again. */
  readonly reload: () => Promise<void>;
}

/** See the module's description; `poll` off while the operator has unsaved changes. */
export function usePolicyLists(scope: string, poll = true): PolicyLists {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const interval = useRefetchInterval(POLL_INTERVAL_MS);
  const refetchInterval = poll ? interval : false;
  const policy = useQuery({
    queryKey: listsKeys.policy(scope),
    refetchInterval,
    queryFn: ({ signal }) =>
      dataOf(client.get("/policies/:scope", { params: { scope }, signal })),
  });
  const headId = policy.data?.head?.id;
  const head = useQuery({
    queryKey: listsKeys.version(scope, headId ?? ""),
    enabled: headId !== undefined,
    // A version never changes.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/policies/:scope/versions/:id", {
          params: { scope, id: headId! },
          signal,
        }),
      ),
  });
  const service = serviceOf(scope);
  const group = groupOf(scope);
  // What the scopes above give: a service's or a group's effective policy.
  const effective = useQuery({
    queryKey: listsKeys.effective(scope),
    enabled: service !== null || group !== null,
    refetchInterval,
    queryFn: async ({ signal }) =>
      service !== null
        ? await dataOf(
            client.get("/services/:id/effective", {
              params: { id: service },
              signal,
            }),
          )
        : await dataOf(
            client.get("/groups/:id/effective", {
              params: { id: group! },
              signal,
            }),
          ),
  });
  const headPolicy: Record<string, unknown> =
    headId === undefined ? {} : (head.data?.policy ?? {});
  const draft = policy.data?.draft ?? null;
  const base = draft === null ? headPolicy : draft.policy;
  const inherited: ListRow[] = [];
  if (effective.data !== undefined) {
    for (const entry of listsOf(effective.data.policy)) {
      const origin = effective.data.origins[`lists[id=${entryKey(entry)}]`];
      if (origin === undefined || origin === scope) continue;
      inherited.push({ entry, origin, own: false });
    }
  }
  const reload = useCallback(
    () => queryClient.invalidateQueries({ queryKey: listsKeys.all(scope) }),
    [queryClient, scope],
  );
  return {
    pending: policy.isPending || (headId !== undefined && head.isPending),
    error: policy.error ?? head.error,
    policy: policy.data,
    base: isRecord(base) ? base : {},
    head: headPolicy,
    lists: listsOf(base),
    headLists: listsOf(headPolicy),
    inherited,
    // A service whose effective policy does not compile still has its own lists.
    inheritedError: effective.error,
    reload,
  };
}

/** One account the operator typed, and the key the control plane stored for it (the save's answer only). */
export interface EnteredAccount {
  /** `user` or `apiKey`. */
  readonly kind: "user" | "apiKey";
  /** What was typed. */
  readonly typed: string;
  /** The key now in the entry. */
  readonly key: string;
}

/** The accounts a save's answer echoes (`entered`), with the keys they became. */
export function enteredOf(answer: DraftDto): EnteredAccount[] {
  const lists = listsOf(answer.policy);
  return (answer.entered ?? []).flatMap((item): EnteredAccount[] => {
    const entry = lists[item.index];
    if (item.user !== undefined)
      return [{ kind: "user", typed: item.user, key: entry?.userHash ?? "" }];
    if (item.apiKey !== undefined)
      return [
        { kind: "apiKey", typed: item.apiKey, key: entry?.apiKeyHash ?? "" },
      ];
    return [];
  });
}

/** Whether `error` is the draft's revision conflict. */
export function isConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

/**
 * Saves `policy` as the scope's draft at the revision read (`null` when
 * there was none), through step-up; the cached policy takes the answer,
 * without its `entered` echo (which is the caller's to show once).
 */
export function useSaveDraft(scope: string) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  return useCallback(
    async (
      policy: Record<string, unknown>,
      revision: number | null,
    ): Promise<DraftDto> => {
      const answer = await withStepUp(() =>
        dataOf(
          client.put("/policies/:scope/draft", {
            params: { scope },
            body: { policy, revision },
          }),
        ),
      );
      const { entered: _entered, ...draft } = answer;
      queryClient.setQueryData<PolicyDto>(listsKeys.policy(scope), (old) =>
        old === undefined ? old : { ...old, draft },
      );
      await queryClient.invalidateQueries({
        queryKey: listsKeys.policy(scope),
      });
      return answer;
    },
    [client, queryClient, scope],
  );
}

/**
 * Discards the scope's draft at the revision read (`DELETE
 * /policies/:scope/draft`): the head stays as it is. A changed draft is a
 * `409`.
 */
export function useDiscardDraft(scope: string) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  return useCallback(
    async (revision: number): Promise<void> => {
      await dataOf(
        client.delete("/policies/:scope/draft", {
          params: { scope },
          query: { revision },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: listsKeys.all(scope) });
    },
    [client, queryClient, scope],
  );
}
