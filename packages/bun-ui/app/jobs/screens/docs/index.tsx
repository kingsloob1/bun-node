/**
 * The API documentation: a landing page linking the HTTP reference (OpenAPI)
 * and the WebSocket reference (AsyncAPI), each shown only when the API serves
 * that document (`meta.docs`). Routed from `routes.tsx` under `/docs`.
 */
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { useMeta } from "../../meta/hooks";
import { Link } from "../../router";

export { HttpDocsScreen } from "./http";
export { WsDocsScreen } from "./ws";

/** `/docs`: what documentation this API serves. */
export function DocsHomeScreen() {
  const { docs } = useMeta();
  return (
    <div
      className="screen"
      data-testid="docs-home"
    >
      <h1 className="screen-title">API docs</h1>
      {docs === null ? (
        <EmptyState
          title="No documentation"
          description="This API does not serve its OpenAPI or AsyncAPI documents."
        />
      ) : (
        <div className="docs-home">
          <Card title="HTTP API">
            <p>
              Every route, its parameters, request and response schemas, the
              permission it needs, and a panel to try it.
            </p>
            <Link to="/docs/http">Open the HTTP reference</Link>
          </Card>
          {docs.asyncapi !== undefined && (
            <Card title="WebSocket API">
              <p>
                The live-events socket: its channels, the messages on each,
                limits and close codes.
              </p>
              <Link to="/docs/ws">Open the WebSocket reference</Link>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
