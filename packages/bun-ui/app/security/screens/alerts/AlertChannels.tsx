/**
 * The alert channels (README §9.3; `alerts:read` on `global`): webhooks,
 * Slack-compatible webhooks and email, each with where it posts (scheme
 * and host only: the URL is write-only) and which of the control plane's
 * own alerts it receives. With `alerts:write` on `global`, **New channel**.
 */
import { useQuery } from "@tanstack/react-query";
import { dataOf } from "../../api/client";
import { ErrorView } from "../../components/ErrorView";
import { UrlPager } from "../../components/UrlPager";
import { useUrlCursor } from "../../components/urlCursor";
import { useSecurityClient } from "../../context";
import { useGlobalCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { alertKeys, CHANNEL_TYPES } from "./alertQueries";

/** See the module's description. */
export function AlertChannels({ scope }: { scope: string }) {
  const { client } = useSecurityClient();
  const position = useUrlCursor(50);
  const can = useGlobalCanFn();
  const page = useQuery({
    queryKey: alertKeys.channels(position.cursor, position.limit),
    queryFn: ({ signal }) =>
      dataOf(
        client.get("/alerts/channels", {
          query: {
            limit: position.limit,
            ...(position.cursor === undefined
              ? {}
              : { cursor: position.cursor }),
          },
          signal,
        }),
      ),
  });
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  return (
    <section
      aria-label="Channels"
      data-testid="alerts-channels"
    >
      {can("alerts:write") ? (
        <p>
          <Link
            to={`/alerts/channels/new?${scopeQuery}`}
            data-testid="new-alert-channel"
          >
            New channel
          </Link>
        </p>
      ) : null}
      {page.isError ? (
        <ErrorView
          error={page.error}
          title="The channels could not be read"
          onRetry={() => void page.refetch()}
        />
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col">Type</th>
                <th scope="col">Sends to</th>
                <th scope="col">Also receives</th>
              </tr>
            </thead>
            <tbody>
              {(page.data?.items ?? []).map((channel) => (
                <tr
                  key={channel.id}
                  data-testid="alert-channel-row"
                >
                  <td>
                    <Link
                      to={`/alerts/channels/${encodeURIComponent(channel.id)}?${scopeQuery}`}
                    >
                      {channel.name}
                    </Link>
                  </td>
                  <td>{CHANNEL_TYPES[channel.type]}</td>
                  <td>{channel.url ?? channel.to?.join(", ") ?? "—"}</td>
                  <td>
                    {channel.receives === undefined
                      ? "—"
                      : `${channel.receives.kinds.join(", ")}${channel.receives.minSeverity === undefined ? "" : ` (${channel.receives.minSeverity} and up)`}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.data !== undefined && page.data.items.length === 0 ? (
            <p data-testid="alert-channels-empty">No channel.</p>
          ) : null}
          <UrlPager
            position={position}
            page={page.data}
            label="Channel pages"
          />
        </>
      )}
    </section>
  );
}
