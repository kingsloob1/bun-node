/**
 * The live stream (ui.md §6): CP5's `GET /live` as server-sent events
 * through bun-client's `./sse` (reconnect with backoff, resume by
 * `Last-Event-ID`), subscribed to the scope's topics the operator may read
 * (`bans:<scope>`, `policy:<scope>`). Each event invalidates the screens'
 * queries, coalesced over 250 ms; a `gap` refetches them. Its state feeds
 * the header's badge and the screens' safety polling.
 *
 * Screens listen for messages by name (`useLiveMessages`) and ask for the
 * scope's `events` (U3's events list, U2's activity feed) and `overview`
 * (U2's traffic chart) topics while they are mounted (`useLiveTopic`);
 * those messages never invalidate a query.
 */
import type { ClientMiddleware } from "@kingsleyweb/bun-client";
import type { ReactNode } from "react";
import { sse } from "@kingsleyweb/bun-client/sse";
import { useQueryClient } from "@tanstack/react-query";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useSecurityClient } from "../context";
import { useCanFn } from "../meta/hooks";
import type {
  LiveFeed,
  LiveListener,
  LiveMessageName,
  LiveState,
  LiveStatus,
  LiveTopicKind,
} from "./context";
import {
  LIVE_COUNTED_LISTS,
  LIVE_INVALIDATION_DELAY_MS,
  LIVE_TOPIC_KINDS,
  LiveFeedContext,
  LiveOptionsContext,
  LiveStatusContext,
} from "./context";

/** The events that change what a screen shows (invalidating its queries). */
const CHANGES = new Set<LiveMessageName>([
  "ban",
  "ban.changed",
  "policy.published",
  "bundle.compiled",
  "approval.created",
  "approval.decided",
  // The server's `gap` (the resume point is gone): everything is refetched.
  "$gap",
]);

/** Every message screens may listen for, once each. */
const MESSAGES: readonly LiveMessageName[] = [
  ...new Set<LiveMessageName>([...CHANGES, "ban", "event", "more", "overview"]),
];

/** The query keys a live event never makes stale: meta, documents, and the lists that count new rows instead. */
const UNTOUCHED = new Set(["meta", "docs", ...LIVE_COUNTED_LISTS]);

/** Props of {@link LiveProvider}. */
export interface LiveProviderProps {
  /** The scope on screen; `null` for none. */
  scope: string | null;
  /** The app. */
  children: ReactNode;
}

/** See the module's description. */
export function LiveProvider({ scope, children }: LiveProviderProps) {
  const api = useSecurityClient();
  const queryClient = useQueryClient();
  const options = use(LiveOptionsContext);
  const can = useCanFn();
  // Screens' listeners, and the extra topics they want while mounted.
  const listeners = useRef(new Map<LiveMessageName, Set<LiveListener>>());
  // How many mounted screens want each extra topic (PR-U2 adds `overview`).
  const [wanted, setWanted] = useState<ReadonlyMap<LiveTopicKind, number>>(
    () => new Map(),
  );
  const feed = useMemo<LiveFeed>(
    () => ({
      listen: (name, listener) => {
        let set = listeners.current.get(name);
        if (set === undefined) {
          set = new Set();
          listeners.current.set(name, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
      want: (kind) => {
        setWanted((current) =>
          new Map(current).set(kind, (current.get(kind) ?? 0) + 1),
        );
        return () =>
          setWanted((current) => {
            const next = new Map(current);
            const left = (next.get(kind) ?? 1) - 1;
            if (left <= 0) next.delete(kind);
            else next.set(kind, left);
            return next;
          });
      },
    }),
    [],
  );
  const topics = useMemo(
    () =>
      scope === null
        ? []
        : [
            ...(can("bans:read") ? [`bans:${scope}`] : []),
            ...(can("policy:read") ? [`policy:${scope}`] : []),
            ...(can("analytics:read")
              ? LIVE_TOPIC_KINDS.filter((kind) => wanted.has(kind)).map(
                  (kind) => `${kind}:${scope}`,
                )
              : []),
          ],
    [scope, can, wanted],
  );
  const disabled = options?.disabled === true || topics.length === 0;
  const key = topics.join(",");
  // The state of the stream for `key`: a new topic set reads "connecting" until its stream says otherwise.
  const [status, setStatus] = useState<LiveStatus & { key: string }>({
    key: "",
    state: "connecting",
    detail: null,
  });

  useEffect(() => {
    if (disabled) return;
    let connected = false;
    const set = (state: LiveState, detail: string | null = null) =>
      setStatus({ key, state, detail });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({
          predicate: (query) => !UNTOUCHED.has(String(query.queryKey[0])),
        });
      }, LIVE_INVALIDATION_DELAY_MS);
    };
    /** Follows each connection's outcome into the status. */
    const watch: ClientMiddleware = async (_ctx, next) => {
      if (connected) set("reconnecting");
      let response: Response;
      try {
        response = await next();
      } catch (error) {
        set(
          "reconnecting",
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      if (response.ok) {
        connected = true;
        set("live");
      } else if (response.status === 401 || response.status === 403) {
        set("refused", `the API answered ${response.status}`);
      }
      return response;
    };
    const stream = sse(api.client, "GET /live", {
      query: { topics: key.split(",") },
      reconnect: { initialMs: 1_000, maxMs: 30_000 },
      fatalStatuses: [401, 403],
      validate: false,
      middleware: [watch],
    });
    const offs = MESSAGES.map((name) =>
      stream.on(name, (data: unknown) => {
        if (CHANGES.has(name)) invalidate();
        for (const listener of listeners.current.get(name) ?? []) {
          try {
            listener(data);
          } catch {
            // A screen's listener never breaks the stream.
          }
        }
      }),
    );
    stream.closed.catch(() => set("refused"));
    return () => {
      for (const off of offs) off();
      stream.close();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, queryClient, key, disabled]);

  const shown = useMemo<LiveStatus>(
    () =>
      disabled
        ? { state: "off", detail: null }
        : status.key === key
          ? { state: status.state, detail: status.detail }
          : { state: "connecting", detail: null },
    [disabled, status, key],
  );
  return (
    <LiveFeedContext value={feed}>
      <LiveStatusContext value={shown}>{children}</LiveStatusContext>
    </LiveFeedContext>
  );
}
