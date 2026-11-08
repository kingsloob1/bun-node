/**
 * The WebSocket API reference (AsyncAPI 3.0): `/docs/ws` and `/docs/ws/:item`.
 * The viewer is the package's (`@kingsleyweb/bun-api-docs-ui/embed`); this
 * wrapper fetches the document with the app's client and injects the app's
 * seams: the Events console for the try-it cards, the contract's address
 * rules, the permission probe, the limits vocabulary and the subprotocol the
 * client contract defaults to.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { WsReference } from "@kingsleyweb/bun-api-docs-ui/embed";
import { docsKeys, getAsyncApiDocument } from "../../../api/docs";
import { Card } from "../../../components/Card";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorView } from "../../../components/ErrorView";
import { Spinner } from "../../../components/Spinner";
import { useApiClient } from "../../../context";
import { useNav } from "../../../layout/useNav";
import { useCanFn, useMeta } from "../../../meta/hooks";
import { Link } from "../../../router";
import { JOBS_ADDRESS } from "./address";
import { eventsConsole } from "./console";
import { DEFAULT_SUBPROTOCOL, isKnownAction } from "./links";
import { LIMIT_INFO } from "./limits";

/** `/docs/ws[/:item]`: the channels, operations and messages of the live-events socket. */
export function WsDocsScreen() {
  const api = useApiClient();
  const meta = useMeta();
  const can = useCanFn();
  const consoleAvailable = useNav().some((entry) => entry.id === "events");
  const { docs } = meta;
  const path = docs?.asyncapi;
  const document = useQuery({
    queryKey: docsKeys.asyncapi(path ?? ""),
    queryFn: ({ signal }) => getAsyncApiDocument(api, path!, signal),
    enabled: path !== undefined,
    staleTime: Infinity,
  });
  const console = useMemo(
    () => eventsConsole(meta.mode, consoleAvailable),
    [meta.mode, consoleAvailable],
  );

  let body;
  if (path === undefined) {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <EmptyState
          title="This API has no live-events socket"
          description="There is no AsyncAPI document to show: the API was created without its WebSocket, so the screens refresh by polling over HTTP."
          action={<Link to="/docs">Back to the API docs</Link>}
        />
      </>
    );
  } else if (document.data) {
    body = (
      <WsReference
        document={document.data}
        defaultSubprotocol={DEFAULT_SUBPROTOCOL}
        limitsInfo={LIMIT_INFO}
        console={console}
        address={JOBS_ADDRESS}
        probe={(action) => (isKnownAction(action) ? can(action) : undefined)}
        pathBase="/docs"
      />
    );
  } else if (document.error) {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <ErrorView
          error={document.error}
          title="Could not load the AsyncAPI document"
          onRetry={() => void document.refetch()}
        />
      </>
    );
  } else {
    body = (
      <>
        <h1 className="screen-title">WebSocket API</h1>
        <Card>
          <Spinner
            label="Loading the AsyncAPI document"
            showLabel
          />
        </Card>
      </>
    );
  }
  return (
    <div
      className="screen ws-docs"
      data-testid="ws-docs"
    >
      {body}
    </div>
  );
}
