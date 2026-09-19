/**
 * The WebSocket reference's panels read from the document's extensions and
 * header: the server and its security, `x-bun-jobs-limits`,
 * `x-bun-jobs-close-codes` and `x-bun-jobs-upgrade-refusals`.
 */
import type { WsDoc, WsLimits } from "./model";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { KeyValue } from "../../../components/KeyValue";
import { Table } from "../../../components/Table";
import { formatNumber } from "../../../format";
import { Prose } from "../schema";
import { formatLimit, formatMs, LIMIT_INFO } from "./format";
import { InlineText } from "./InlineText";
import { subprotocolSource } from "./model";

/** The server: its URL, host, path, protocol and subprotocol. */
export function ServerPanel({ doc }: { doc: WsDoc }) {
  const { server, subprotocol } = doc;
  return (
    <Card title="Server">
      {server === null ? (
        <p className="muted">The document names no server.</p>
      ) : (
        <KeyValue
          items={[
            {
              label: "URL",
              value: server.url && (
                <code data-testid="ws-server-url">{server.url}</code>
              ),
            },
            {
              label: "Host",
              value: <code>{server.host}</code>,
              hint: server.hostIsTemplate
                ? `A template: the document served over HTTP fills in the request's own host${server.hostDefault ? ` (default ${server.hostDefault})` : ""}.`
                : "Taken from the request that fetched this document: the host you reached the API on.",
            },
            {
              label: "Path",
              value: server.pathname && <code>{server.pathname}</code>,
            },
            {
              label: "Protocol",
              value: server.protocol && <code>{server.protocol}</code>,
              hint: "wss when the API was reached over HTTPS.",
            },
            {
              label: "Subprotocol",
              value: (
                <code data-testid="ws-subprotocol">{subprotocol.value}</code>
              ),
              hint: (
                <>
                  <span data-testid="ws-subprotocol-source">
                    {subprotocolSource(doc)}
                  </span>
                  {subprotocol.fromDocument
                    ? ". Optional: offer it in Sec-WebSocket-Protocol, or offer none. Offering others without it is refused 400."
                    : ": the document does not say, so this is the client contract's."}
                </>
              ),
            },
            server.description !== undefined && {
              label: "About",
              value: server.description,
            },
          ]}
        />
      )}
    </Card>
  );
}

/** Security: every requirement (any one suffices), and each scheme with what a browser cannot send. */
export function SecurityPanel({ doc }: { doc: WsDoc }) {
  const { requirements, securitySchemes, conjunctive } = doc;
  return (
    <Card title="Security">
      <div data-testid="ws-security">
        {requirements.length === 0 ? (
          <p className="muted">
            No security schemes are declared. The host application&apos;s{" "}
            <code>authorize</code> hook decides, on the upgrade (
            <code>events.connect</code>) and on each subscription (
            <code>events.subscribe</code>); a browser sends its cookies with the
            upgrade.
          </p>
        ) : (
          <>
            <p>
              {requirements.length === 1
                ? "The connection must satisfy:"
                : "The connection must satisfy any one of:"}
            </p>
            <ul
              className="ws-requirements"
              aria-label="Security requirements"
            >
              {requirements.map((requirement) => {
                const key = requirement
                  .map((part) => `${part.scheme}:${part.scopes.join(",")}`)
                  .join("+");
                return (
                  <li key={key}>
                    {requirement.map((part, index) => (
                      <span key={part.scheme}>
                        {index > 0 && <strong> and </strong>}
                        <code>{part.scheme}</code>
                        {part.scopes.length > 0 && (
                          <span className="muted">
                            {" "}
                            (scopes: {part.scopes.join(", ")})
                          </span>
                        )}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
            {conjunctive && (
              <p
                className="ws-note"
                data-testid="ws-security-conjunctive"
              >
                AsyncAPI 3 can list only one scheme per requirement, so a
                requirement naming several is only in{" "}
                <code>x-bun-jobs-security</code>, which is what this list shows:
                every scheme within one requirement is needed together.
              </p>
            )}
            <Table label="Security schemes">
              <thead>
                <tr>
                  <th scope="col">Scheme</th>
                  <th scope="col">Type</th>
                  <th scope="col">In a browser</th>
                </tr>
              </thead>
              <tbody>
                {securitySchemes.map((scheme) => (
                  <tr
                    key={scheme.name}
                    data-testid={`ws-scheme-${scheme.name}`}
                  >
                    <td>
                      <code>{scheme.name}</code>
                      {scheme.description && (
                        <div className="muted">{scheme.description}</div>
                      )}
                    </td>
                    <td>
                      {scheme.type}
                      {scheme.detail && (
                        <div className="muted">{scheme.detail}</div>
                      )}
                    </td>
                    <td>
                      {scheme.note ? (
                        <span className="ws-note">
                          <InlineText text={scheme.note} />
                        </span>
                      ) : (
                        <span className="muted">Can be sent.</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
      </div>
    </Card>
  );
}

/** The replay setting in words. */
function replayText(replay: WsLimits["replay"]): string {
  if (replay === false) {
    return "Off: a resume after a reconnect always reports a gap.";
  }
  if (replay === undefined) {
    return "Not stated.";
  }
  const parts = [
    replay.size !== undefined && `the last ${formatNumber(replay.size)} events`,
    replay.maxAgeMs !== undefined && `at most ${formatMs(replay.maxAgeMs)} old`,
  ].filter(Boolean);
  return parts.length > 0 ? `Keeps ${parts.join(", ")}.` : "On.";
}

/** `x-bun-jobs-limits`: what a connection is held to. */
export function LimitsPanel({ limits }: { limits: WsLimits }) {
  return (
    <Card title="Limits">
      <p className="muted">
        What one connection is held to (<code>x-bun-jobs-limits</code>).
      </p>
      <Table
        label="Limits"
        className="ws-table"
      >
        <thead>
          <tr>
            <th scope="col">Limit</th>
            <th scope="col">Value</th>
            <th scope="col">Meaning</th>
          </tr>
        </thead>
        <tbody>
          {limits.values.map(([name, value]) => (
            <tr
              key={name}
              data-testid={`ws-limit-${name}`}
            >
              <td>
                {LIMIT_INFO[name]?.label ?? name}
                <div className="muted">
                  <code>{name}</code>
                </div>
              </td>
              <td className="ws-value">{formatLimit(name, value)}</td>
              <td>{LIMIT_INFO[name]?.meaning ?? ""}</td>
            </tr>
          ))}
          <tr data-testid="ws-limit-replay">
            <td>
              Replay
              <div className="muted">
                <code>replay</code>
              </div>
            </td>
            <td className="ws-value">
              {limits.replay === false
                ? "off"
                : limits.replay === undefined
                  ? "—"
                  : [
                      limits.replay.size !== undefined &&
                        `size ${formatNumber(limits.replay.size)}`,
                      limits.replay.maxAgeMs !== undefined &&
                        `maxAgeMs ${formatMs(limits.replay.maxAgeMs)}`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
            </td>
            <td>The events kept for a resume. {replayText(limits.replay)}</td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}

/** `x-bun-jobs-close-codes`: why an open connection is closed. */
export function CloseCodesPanel({ doc }: { doc: WsDoc }) {
  return (
    <Card title="Close codes">
      <p className="muted">
        How an open connection is closed (<code>x-bun-jobs-close-codes</code>).
      </p>
      <Table
        label="Close codes"
        className="ws-table"
      >
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Name</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {doc.closeCodes.map((entry) => (
            <tr
              key={`${entry.code}-${entry.name}`}
              data-testid={`ws-close-${entry.code}`}
            >
              <td className="ws-value">{entry.code}</td>
              <td>
                <code>{entry.name}</code>
              </td>
              <td>
                <InlineText text={entry.description} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** `x-bun-jobs-upgrade-refusals`: how an upgrade is refused before a socket exists. */
export function RefusalsPanel({ doc }: { doc: WsDoc }) {
  return (
    <Card title="Upgrade refusals">
      <p className="muted">
        An upgrade can be refused before any socket exists, with an ordinary
        HTTP response whose body is a problem carrying <code>code</code> (
        <code>x-bun-jobs-upgrade-refusals</code>).
      </p>
      <p
        className="ws-note"
        data-testid="ws-refusal-1006"
      >
        A browser never sees these: its <code>WebSocket</code> exposes no status
        or body for a refused upgrade, only a close with code{" "}
        <strong>1006</strong> (abnormal closure). To tell them apart, make the
        same request over HTTP, or read the server&apos;s logs.
      </p>
      <Table
        label="Upgrade refusals"
        className="ws-table"
      >
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Code</th>
            <th scope="col">When</th>
            <th scope="col">Content type</th>
            <th scope="col">Headers</th>
          </tr>
        </thead>
        <tbody>
          {doc.refusals.map((entry) => (
            <tr
              key={`${entry.status}-${entry.code}`}
              data-testid={`ws-refusal-${entry.code}`}
            >
              <td className="ws-value">
                <Badge tone={entry.status >= 500 ? "danger" : "warning"}>
                  {entry.status}
                </Badge>
              </td>
              <td>
                <code>{entry.code}</code>
              </td>
              <td>
                <InlineText text={entry.description} />
              </td>
              <td>{entry.contentType && <code>{entry.contentType}</code>}</td>
              <td>
                {Object.keys(entry.headers).length === 0 ? (
                  <span className="muted">—</span>
                ) : (
                  Object.entries(entry.headers).map(([name, value]) => (
                    <div key={name}>
                      <code>
                        {name}: {value}
                      </code>
                    </div>
                  ))
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** The document's header: title, version and description. */
export function DocHeader({ doc }: { doc: WsDoc }) {
  return (
    <header className="ws-header">
      <h1 className="screen-title">
        {doc.title}{" "}
        {doc.version && (
          <Badge
            tone="neutral"
            title="info.version"
          >
            v{doc.version}
          </Badge>
        )}
      </h1>
      <p className="muted ws-kicker">WebSocket API (AsyncAPI 3.0)</p>
      {doc.description && (
        <details className="ws-description">
          <summary>About this socket</summary>
          <Prose text={doc.description} />
        </details>
      )}
    </header>
  );
}
