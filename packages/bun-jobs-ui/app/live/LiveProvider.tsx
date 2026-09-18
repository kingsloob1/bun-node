import type { ReactNode } from "react";
import type { LiveContextValue, LiveOptions } from "./context";
import { use, useEffect, useMemo } from "react";
import { useUiConfig } from "../context";
import { useCan, useMeta } from "../meta/hooks";
import { LiveClient, liveSocketUrl } from "./client";
import { LiveContext, LiveOptionsContext, LOCAL_EVENTS_NOTE } from "./context";

/** Props of {@link LiveProvider}. */
export interface LiveProviderProps {
  /** The app. */
  children: ReactNode;
  /** Client overrides (socket constructor, timers), or `disabled`. Defaults to {@link LiveOptionsContext}'s, else none. */
  options?: LiveOptions;
}

/**
 * Owns the one socket for the app (inside MetaProvider and the query client).
 *
 * A client is created when the API has a socket (`meta.websocket`) and the
 * caller may connect (`events.connect`), and nothing rules events out
 * (`events: "local"` with `publishing: false`); otherwise the status is `"off"`
 * with the reason. The client is built during render (it has no side
 * effects) and started and stopped in an effect, so StrictMode's
 * mount–unmount–mount stops it and starts it again.
 */
export function LiveProvider({ children, options }: LiveProviderProps) {
  const meta = useMeta();
  const config = useUiConfig();
  const canConnect = useCan("events.connect");
  const contextOptions = use(LiveOptionsContext);
  // Kept as one object: the client is rebuilt only when it changes.
  const source = options ?? contextOptions;
  const disabled = source?.disabled === true;

  const websocket = meta.websocket;
  const offDetail = disabled
    ? "Live updates are disabled"
    : !websocket
      ? "The API has no live-events socket"
      : !canConnect
        ? "You may not connect to live events (events.connect)"
        : meta.events === "local" && meta.publishing === false
          ? "Nothing publishes events to this API"
          : null;

  const url =
    websocket && offDetail === null
      ? liveSocketUrl(
          { path: websocket.path, port: websocket.port ?? null },
          config.apiBase,
          globalThis.location?.href ?? "http://localhost/",
        )
      : null;
  const heartbeatMs = websocket?.heartbeatMs;

  const client = useMemo(() => {
    if (url === null) {
      return null;
    }
    const { disabled: _disabled, ...overrides } = source ?? {};
    return new LiveClient({
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
      ...overrides,
      url,
    });
  }, [url, heartbeatMs, source]);

  useEffect(() => {
    if (!client) {
      return;
    }
    client.start();
    return () => client.stop();
  }, [client]);

  const value = useMemo(
    (): LiveContextValue => ({
      client,
      offDetail: client ? null : offDetail,
      liveNote: meta.events === "local" ? LOCAL_EVENTS_NOTE : null,
      events: meta.events,
      publishing: meta.publishing,
    }),
    [client, offDetail, meta.events, meta.publishing],
  );

  return <LiveContext value={value}>{children}</LiveContext>;
}
