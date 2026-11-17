/**
 * The live stream (ui.md §6): CP5's `GET /live` as server-sent events
 * through bun-client's `./sse` (reconnect with backoff, resume by
 * `Last-Event-ID`), subscribed to the scope's topics the operator may read
 * (`bans:<scope>`, `policy:<scope>`). Each event invalidates the screens'
 * queries, coalesced over 250 ms; a `gap` refetches them. Its state feeds
 * the header's badge and the screens' safety polling.
 */
import type { ClientMiddleware } from "@kingsleyweb/bun-client";
import type { ReactNode } from "react";
import type { LiveState, LiveStatus } from "./context";
import { sse } from "@kingsleyweb/bun-client/sse";
import { useQueryClient } from "@tanstack/react-query";
import { use, useEffect, useMemo, useState } from "react";
import { useSecurityClient } from "../context";
import { useCanFn } from "../meta/hooks";
import {
  LIVE_INVALIDATION_DELAY_MS,
  LiveOptionsContext,
  LiveStatusContext,
} from "./context";

/** The events that change what a screen shows. */
const CHANGES = [
  "ban",
  "ban.changed",
  "policy.published",
  "bundle.compiled",
  "approval.created",
  "approval.decided",
  // The server's `gap` (the resume point is gone): everything is refetched.
  "$gap",
] as const;

/** The query keys a live event never makes stale. */
const UNTOUCHED = new Set(["meta", "docs"]);

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
  const topics = useMemo(
    () =>
      scope === null
        ? []
        : [
            ...(can("bans:read") ? [`bans:${scope}`] : []),
            ...(can("policy:read") ? [`policy:${scope}`] : []),
          ],
    [scope, can],
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
    const offs = CHANGES.map((name) => stream.on(name, invalidate));
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
  return <LiveStatusContext value={shown}>{children}</LiveStatusContext>;
}
