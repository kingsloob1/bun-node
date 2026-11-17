/**
 * Shows, while a break-glass session lasts, that every action is the
 * break-glass account's, and when the session ends (the user's decision).
 * The session is dropped when it expires (the page reloads its data then).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "../../kit/components/Badge";
import { useSecurityClient } from "../context";

/** See the module's description. */
export function BreakGlassBadge() {
  const api = useSecurityClient();
  const queryClient = useQueryClient();
  const [session, setSession] = useState(() => api.breakGlass.current());
  useEffect(() => api.onSessionEnded(() => setSession(null)), [api]);
  useEffect(() => {
    if (session === null) return;
    const timer = setTimeout(
      () => {
        api.breakGlass.clear();
        setSession(null);
        void queryClient.resetQueries();
      },
      Math.max(0, session.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [api, queryClient, session]);
  if (session === null) return null;
  const until = new Date(session.expiresAt).toLocaleTimeString();
  return (
    <span data-testid="break-glass-session">
      <Badge
        tone="danger"
        title="Every action is recorded as the break-glass account's and alerted."
      >
        Break-glass session until {until}
      </Badge>
    </span>
  );
}
