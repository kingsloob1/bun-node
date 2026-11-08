/**
 * The WebSocket reference's main pane for one item: a channel (with its
 * try-it when a console is given), an operation, or a message (with its
 * payload and, for an event, its try-it).
 *
 * The try-it deep-links a console the host app injects as {@link WsConsole}
 * (bun-jobs-ui passes its Events console); a standalone viewer passes none
 * and no try-it renders.
 */
import type { ReactNode } from "react";
import type { SpecDocument } from "../../../api/docs";
import type { PermissionProbe } from "../permissions";
import type { LimitInfo } from "./format";
import type {
  WsAddressOptions,
  WsChannel,
  WsDoc,
  WsMessage,
  WsOperation,
} from "./model";
import { useState } from "react";
import { Badge } from "../../../components/Badge";
import { Card } from "../../../components/Card";
import { CopyButton } from "../../../components/CopyButton";
import { Field } from "../../../components/Field";
import { TextInput } from "../../../components/inputs";
import { JsonView } from "../../../components/JsonView";
import { KeyValue } from "../../../components/KeyValue";
import { Table } from "../../../components/Table";
import { Link } from "../../../router";
import { Prose, SchemaTree } from "../schema";
import { InlineText } from "./InlineText";
import {
  channelEventTypes,
  channelPermissions,
  channelsCarrying,
  channelSubscribable,
  eventPayloadSchema,
  exampleEventPayload,
  fillAddress,
  itemPath,
  operationsOn,
  operationsUsing,
  parameterProblem,
  parameterSchemas,
  tryProblems,
} from "./model";
import { CloseCodesPanel, LimitsPanel, RefusalsPanel } from "./panels";
import { PayloadSchema } from "./PayloadSchema";

/**
 * A console the try-it cards deep-link (bun-jobs-ui's Events console). The
 * link builders answer `null` when the console cannot open what was asked.
 */
export interface WsConsole {
  /** Whether the console can be opened at all. */
  available: boolean;
  /** Its name in the UI copy ("Events console"). */
  label: string;
  /** Why it cannot be opened, shown when `available` is false. Defaults to a generic sentence. */
  unavailableReason?: ReactNode;
  /** Why a filled channel still cannot open, when the link builder said no. Defaults to a generic sentence. */
  noChannelReason?: (channel: string) => ReactNode;
  /** The link subscribing the console to `channel`, filtered to `types` (`[]` would be all of them). */
  channelLink: (channel: string, types: readonly string[]) => string | null;
  /** The link opening the console on an event message's channel, filtered to its type. */
  messageLink: (message: WsMessage, doc: WsDoc) => string | null;
}

/** Options of the panes, threaded from {@link WsReference}. */
export interface WsPaneOptions {
  /** The console the try-it cards open, when the host has one. */
  console?: WsConsole;
  /** Answers "does the caller hold this permission" (the have/lack markers). */
  probe?: PermissionProbe;
  /** The host's contract for the try-it's address fields. */
  address?: WsAddressOptions;
  /** The docs section's path within the host app ("" for a standalone viewer). */
  pathBase?: string;
}

/** A permission with a have/lack marker when a probe is given, plain otherwise. */
export function PermissionMarker({
  action,
  probe,
}: {
  action: string;
  probe?: PermissionProbe;
}) {
  if (probe === undefined) {
    return (
      <span
        className="ws-permission"
        data-testid={`ws-permission-${action}`}
      >
        <code>{action}</code> <Badge tone="neutral">permission</Badge>
      </span>
    );
  }
  const held = probe(action);
  return (
    <span
      className="ws-permission"
      data-testid={`ws-permission-${action}`}
      data-has={held === undefined ? "unknown" : String(held)}
    >
      <code>{action}</code>{" "}
      {held === undefined ? (
        <Badge tone="neutral">Not an action this UI knows</Badge>
      ) : (
        <Badge tone={held ? "success" : "danger"}>
          {held ? "You have this" : "You lack this"}
        </Badge>
      )}
    </span>
  );
}

/** Links to items by slug. */
function ItemLinks({
  items,
  pathBase = "",
  empty = "None.",
}: {
  items: readonly {
    /** The item's slug. */
    slug: string;
    /** Its label. */
    label: string;
  }[];
  /** The docs section's path within the host app. */
  pathBase?: string;
  empty?: string;
}) {
  if (items.length === 0) {
    return <span className="muted">{empty}</span>;
  }
  return (
    <ul className="ws-links">
      {items.map((item) => (
        <li key={item.slug}>
          <Link to={itemPath(item.slug, "", pathBase)}>
            <code>{item.label}</code>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Why "try it" is not offered, when the console is not available. */
function ConsoleUnavailable({ console: target }: { console: WsConsole }) {
  return (
    <p
      className="muted"
      data-testid="ws-try-unavailable"
    >
      {target.unavailableReason ?? (
        <>The {target.label} is not available here.</>
      )}
    </p>
  );
}

/** Props of {@link ChannelTryIt}. */
interface ChannelTryItProps {
  /** The document. */
  doc: WsDoc;
  /** The channel family. */
  channel: WsChannel;
  /** The console to open. */
  console: WsConsole;
  /** The host's contract for the address fields. */
  address?: WsAddressOptions;
}

/** Try a channel: fill its address, then open the console subscribed to it. */
function ChannelTryIt({
  doc,
  channel,
  console: target,
  address,
}: ChannelTryItProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  if (!target.available) {
    return (
      <Card title="Try it">
        <ConsoleUnavailable console={target} />
      </Card>
    );
  }
  const filled = fillAddress(
    channel.address,
    values,
    parameterSchemas(channel.parameters),
    address,
  );
  const types = channelEventTypes(doc, channel);
  const link = filled === null ? null : target.channelLink(filled, types);
  const problems = tryProblems(channel, values, address);
  return (
    <Card title="Try it">
      <div
        className="ws-try"
        data-testid="ws-try-channel"
      >
        <p className="muted">
          Opens the {target.label} subscribed to this channel
          {types.length > 0
            ? `, showing the ${types.length} event types it carries`
            : ""}
          .
        </p>
        {channel.parameters.length > 0 && (
          <div className="ws-try-fields">
            {channel.parameters.map((parameter) => {
              const value = values[parameter.name] ?? "";
              const problem = parameterProblem(
                parameter.name,
                value,
                parameter.schema,
                address,
              );
              return (
                <Field
                  key={parameter.name}
                  label={parameter.name}
                  hint={
                    parameter.description && (
                      <InlineText text={parameter.description} />
                    )
                  }
                  error={problem}
                >
                  <TextInput
                    value={value}
                    onChange={(next) =>
                      setValues((current) => ({
                        ...current,
                        [parameter.name]: next,
                      }))
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              );
            })}
          </div>
        )}
        <p className="ws-try-channel">
          Channel:{" "}
          {filled === null ? (
            <span className="muted">fill in every parameter</span>
          ) : (
            <code data-testid="ws-try-address">{filled}</code>
          )}
        </p>
        {link === null ? (
          <>
            <span
              className="btn btn-primary ws-disabled"
              aria-disabled="true"
              aria-describedby={`ws-try-reason-${channel.key}`}
              data-testid="ws-try-disabled"
            >
              Open in the {target.label}
            </span>
            <ul
              className="ws-try-reason muted"
              id={`ws-try-reason-${channel.key}`}
              data-testid="ws-try-reason"
            >
              {problems.length > 0 ? (
                problems.map((problem) => <li key={problem}>{problem}</li>)
              ) : (
                <li>
                  {target.noChannelReason?.(filled ?? channel.address) ?? (
                    <>
                      The {target.label} cannot open{" "}
                      <code>{filled ?? channel.address}</code>.
                    </>
                  )}
                </li>
              )}
            </ul>
          </>
        ) : (
          <Link
            to={link}
            className="btn btn-primary"
            data-testid="ws-try-link"
          >
            Open in the {target.label}
          </Link>
        )}
      </div>
    </Card>
  );
}

/** Props of {@link ChannelPane}. */
interface ChannelPaneProps extends WsPaneOptions {
  /** The document, read. */
  doc: WsDoc;
  /** The raw document, for `$ref`s in parameter schemas. */
  root: SpecDocument;
  /** The channel. */
  channel: WsChannel;
  /** Labels and meanings for the limits, when the embedding viewer knows them. */
  limitsInfo?: Readonly<Record<string, LimitInfo>>;
}

/** A channel: address, parameters, operations, messages, permission and try-it. */
export function ChannelPane({
  doc,
  root,
  channel,
  limitsInfo,
  console: target,
  probe,
  address,
  pathBase,
}: ChannelPaneProps) {
  const operations = operationsOn(doc, channel.key);
  const permissions = channelPermissions(doc, channel.key);
  const messages = channel.messages.map((key) => {
    const message = doc.messages.find((candidate) => candidate.key === key);
    return { slug: message?.slug ?? `message-${key}`, label: key };
  });
  return (
    <div
      className="ws-pane"
      data-testid={`ws-pane-${channel.slug}`}
    >
      <Card
        title={
          <>
            {channel.title} <Badge tone="info">channel</Badge>
          </>
        }
      >
        <KeyValue
          items={[
            {
              label: channel.isConnection ? "Path" : "Address",
              value: (
                <code data-testid="ws-channel-address">{channel.address}</code>
              ),
              hint: channel.isConnection
                ? "The socket itself: control messages travel here."
                : "A logical channel: subscribe with this name over the connection.",
            },
            channel.bindingMethod !== undefined && {
              label: "Upgrade",
              value: <code>{channel.bindingMethod}</code>,
            },
            permissions.length > 0 && {
              label: permissions.length === 1 ? "Permission" : "Permissions",
              value: (
                <span className="ws-permissions">
                  {permissions.map((action) => (
                    <PermissionMarker
                      key={action}
                      action={action}
                      probe={probe}
                    />
                  ))}
                </span>
              ),
            },
          ]}
        />
        {channel.description && <Prose text={channel.description} />}
      </Card>
      {channel.parameters.length > 0 && (
        <Card title="Parameters">
          <Table label="Parameters">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {channel.parameters.map((parameter) => (
                <tr key={parameter.name}>
                  <td>
                    <code>{`{${parameter.name}}`}</code>
                  </td>
                  <td>
                    {parameter.description && (
                      <InlineText text={parameter.description} />
                    )}
                  </td>
                  <td data-testid={`ws-parameter-schema-${parameter.name}`}>
                    {parameter.schema ? (
                      <SchemaTree
                        schema={parameter.schema}
                        root={root}
                        label={`Schema of {${parameter.name}}`}
                      />
                    ) : (
                      <span className="muted">Any string</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Card title="Operations">
        <ItemLinks
          items={operations.map((operation) => ({
            slug: operation.slug,
            label: `${operation.action ?? "?"} ${operation.key}`,
          }))}
          pathBase={pathBase}
        />
      </Card>
      <Card title={`Messages (${messages.length})`}>
        <ItemLinks
          items={messages}
          pathBase={pathBase}
        />
      </Card>
      {/* Only a channel there is something to subscribe to, and only with a console: the connection has no try-it. */}
      {target !== undefined && channelSubscribable(channel) && (
        <ChannelTryIt
          key={channel.key}
          doc={doc}
          channel={channel}
          console={target}
          address={address}
        />
      )}
      {channel.isConnection && doc.limits && (
        <LimitsPanel
          limits={doc.limits}
          extensionKey={doc.extensionKeys.limits}
          limitsInfo={limitsInfo}
        />
      )}
      {channel.isConnection && doc.closeCodes.length > 0 && (
        <CloseCodesPanel doc={doc} />
      )}
      {channel.isConnection && doc.refusals.length > 0 && (
        <RefusalsPanel doc={doc} />
      )}
    </div>
  );
}

/** Message links for ids, labelled by id. */
function messageLinks(doc: WsDoc, ids: readonly string[]) {
  return ids.map((key) => ({
    slug:
      doc.messages.find((message) => message.key === key)?.slug ??
      `message-${key}`,
    label: key,
  }));
}

/** An operation: direction, channel, messages, reply and permission. */
export function OperationPane({
  doc,
  operation,
  probe,
  pathBase,
}: WsPaneOptions & {
  doc: WsDoc;
  operation: WsOperation;
}) {
  const channel = doc.channels.find(
    (candidate) => candidate.key === operation.channel,
  );
  const replyChannel = doc.channels.find(
    (candidate) => candidate.key === operation.reply?.channel,
  );
  return (
    <div
      className="ws-pane"
      data-testid={`ws-pane-${operation.slug}`}
    >
      <Card
        title={
          <>
            {operation.title} <Badge tone="accent">operation</Badge>
          </>
        }
      >
        <KeyValue
          items={[
            {
              label: "Direction",
              value: operation.action && (
                <span data-testid="ws-operation-action">
                  <Badge
                    tone={operation.action === "send" ? "info" : "success"}
                  >
                    {operation.action}
                  </Badge>{" "}
                  {operation.action === "send"
                    ? "client → server"
                    : "server → client"}
                </span>
              ),
            },
            {
              label: "Channel",
              value: channel && (
                <Link to={itemPath(channel.slug, "", pathBase)}>
                  <code>{channel.address}</code>
                </Link>
              ),
            },
            operation.permission !== undefined && {
              label: "Permission",
              value: (
                <PermissionMarker
                  action={operation.permission}
                  probe={probe}
                />
              ),
            },
            operation.summary !== undefined && {
              label: "Summary",
              value: <InlineText text={operation.summary} />,
            },
          ]}
        />
      </Card>
      <Card title={operation.action === "send" ? "Sends" : "Receives"}>
        <ItemLinks
          items={messageLinks(doc, operation.messages)}
          pathBase={pathBase}
        />
      </Card>
      {operation.reply && (
        <Card title="Reply">
          <div data-testid="ws-operation-reply">
            <p className="muted">
              The server answers on{" "}
              {replyChannel ? (
                <Link to={itemPath(replyChannel.slug, "", pathBase)}>
                  <code>{replyChannel.address}</code>
                </Link>
              ) : (
                <code>{operation.reply.channel ?? "?"}</code>
              )}{" "}
              with one of:
            </p>
            <ItemLinks
              items={messageLinks(doc, operation.reply.messages)}
              pathBase={pathBase}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

/** Props of {@link MessagePane}. */
interface MessagePaneProps extends WsPaneOptions {
  /** The document, read. */
  doc: WsDoc;
  /** The raw document, for `$ref`s. */
  root: SpecDocument;
  /** The message. */
  message: WsMessage;
}

/** A message: name, summary, where it travels, its payload schema, examples and (for an event) try-it. */
export function MessagePane({
  doc,
  root,
  message,
  console: target,
  pathBase,
}: MessagePaneProps) {
  const channels = channelsCarrying(doc, message.key);
  const operations = operationsUsing(doc, message.key);
  const eventPayload = message.event
    ? eventPayloadSchema(message.payload, root)
    : undefined;
  const link =
    target !== undefined && message.event !== null
      ? target.messageLink(message, doc)
      : null;
  return (
    <div
      className="ws-pane"
      data-testid={`ws-pane-${message.slug}`}
    >
      <Card
        title={
          <>
            {message.title ?? message.name}{" "}
            <Badge tone={message.event ? "success" : "neutral"}>
              {message.event
                ? `${message.event.kind} event`
                : "control message"}
            </Badge>
          </>
        }
      >
        <KeyValue
          items={[
            {
              label: "Name",
              value: <code data-testid="ws-message-name">{message.name}</code>,
            },
            message.summary !== undefined && {
              label: "Summary",
              value: <InlineText text={message.summary} />,
            },
            message.contentType !== undefined && {
              label: "Content type",
              value: <code>{message.contentType}</code>,
            },
            {
              label: "Channels",
              value: (
                <ItemLinks
                  items={channels.map((channel) => ({
                    slug: channel.slug,
                    label: channel.address,
                  }))}
                  pathBase={pathBase}
                />
              ),
            },
            {
              label: "Operations",
              value: (
                <ItemLinks
                  items={operations.map((operation) => ({
                    slug: operation.slug,
                    label: operation.key,
                  }))}
                  pathBase={pathBase}
                />
              ),
            },
          ]}
        />
      </Card>
      {message.event && eventPayload !== undefined && (
        <Card
          title="Event payload"
          className="ws-highlight"
        >
          <p className="muted">
            <code>event.payload</code>: what this {message.event.kind} event
            says. It arrives inside the envelope below.
          </p>
          <div data-testid="ws-event-payload">
            <PayloadSchema
              schema={eventPayload}
              root={root}
              label={`Payload of ${message.name}`}
            />
          </div>
        </Card>
      )}
      <Card title={message.event ? "Full envelope" : "Payload"}>
        <div data-testid="ws-message-payload">
          <PayloadSchema
            schema={message.payload}
            root={root}
            label={`Schema of ${message.name}`}
            depth={message.event ? 1 : 2}
          />
        </div>
      </Card>
      {message.examples.length > 0 && (
        <Card title={message.examples.length === 1 ? "Example" : "Examples"}>
          {message.examples.map((example, index) => (
            <MessageExample
              // eslint-disable-next-line react/no-array-index-key -- the document's examples, in its order
              key={index}
              example={example}
              index={index}
              isEvent={message.event !== null}
            />
          ))}
        </Card>
      )}
      {message.event && target !== undefined && (
        <Card title="Try it">
          {!target.available ? (
            <ConsoleUnavailable console={target} />
          ) : link === null ? (
            <p className="muted">No channel in this document carries it.</p>
          ) : (
            <div className="ws-try">
              <p className="muted">
                Opens the {target.label} on every {message.event.kind}, showing
                only <code>{message.event.type}</code> events.
              </p>
              <Link
                to={link}
                className="btn btn-primary"
                data-testid="ws-try-link"
              >
                Watch {message.event.type} events
              </Link>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** Props of {@link MessageExample}. */
interface MessageExampleProps {
  /** The example, as the document gives it. */
  example: WsMessage["examples"][number];
  /** Its position, naming it when it has no name. */
  index: number;
  /** Whether the message is an event frame (so its `event.payload` is shown first). */
  isEvent: boolean;
}

/**
 * One message example: its name and summary, then the frame. For an event,
 * the frame's `event.payload` (what the event says) comes first, open and
 * highlighted, and the whole frame below it; the copy button copies the
 * whole frame, exactly as it travels.
 */
function MessageExample({ example, index, isEvent }: MessageExampleProps) {
  const name = example.name ?? `Example ${index + 1}`;
  const eventPayload = isEvent
    ? exampleEventPayload(example.payload)
    : undefined;
  return (
    <div
      className="ws-example"
      data-testid="ws-example"
    >
      <div className="ws-example-head">
        <strong data-testid="ws-example-name">{name}</strong>
        <CopyButton
          text={() => JSON.stringify(example.payload, null, 2)}
          label="Copy JSON"
          ariaLabel={`Copy example ${name} as JSON`}
        />
      </div>
      {example.summary && (
        <p
          className="muted"
          data-testid="ws-example-summary"
        >
          <InlineText text={example.summary} />
        </p>
      )}
      {eventPayload !== undefined && (
        <div
          className="ws-example-event ws-highlight"
          data-testid="ws-example-event-payload"
        >
          <p className="muted">
            <code>event.payload</code>
          </p>
          <JsonView
            value={eventPayload}
            label={`event.payload of ${name}`}
            expandDepth={4}
          />
        </div>
      )}
      <div data-testid="ws-example-frame">
        {eventPayload !== undefined && <p className="muted">The whole frame</p>}
        <JsonView
          value={example.payload}
          label={`Example ${name}`}
          expandDepth={eventPayload !== undefined ? 1 : 2}
        />
      </div>
    </div>
  );
}
