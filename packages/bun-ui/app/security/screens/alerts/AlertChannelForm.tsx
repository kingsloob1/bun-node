/**
 * A channel, made or changed. Its URL is write-only: the form shows where
 * it posts (scheme and host) and takes a new URL only when one is typed. A
 * webhook's signing secret is shown once, when the channel is made and
 * when it is rotated (a step-up). **Send a test** queues a test message;
 * **Delete** removes it (rules naming it keep raising, unsent to it).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Spinner } from "../../../kit/components/Spinner";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { SecretOnce } from "../../components/SecretOnce";
import { useSecurityClient } from "../../context";
import { useGlobalCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { useNavigate } from "../../routing";
import { withStepUp } from "../../stepUp";
import type { AlertChannelDto } from "./alertQueries";
import { alertKeys, CHANNEL_TYPES } from "./alertQueries";

/** A channel's id. */
const CHANNEL_ID = /^[a-z\d][\w.-]{0,63}$/i;

/** A list typed with commas, trimmed, empties dropped. */
function listOf(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Props of {@link AlertChannelForm}. */
export interface AlertChannelFormProps {
  /** The id in the path, or `new`. */
  id: string;
  /** The scope on screen (links keep it). */
  scope: string;
}

/** See the module's description. */
export function AlertChannelForm({ scope, id }: AlertChannelFormProps) {
  const fresh = id === "new";
  const { client } = useSecurityClient();
  const channel = useQuery({
    queryKey: alertKeys.channel(id),
    enabled: !fresh,
    queryFn: ({ signal }) =>
      dataOf(client.get("/alerts/channels/:id", { params: { id }, signal })),
  });
  const back = (
    <p>
      <Link to={`/alerts/channels?scope=${encodeURIComponent(scope)}`}>
        Channels
      </Link>
    </p>
  );
  if (!fresh && channel.isPending)
    return <Spinner label="Loading the channel" />;
  if (!fresh && channel.isError) {
    return (
      <div className="screen">
        {back}
        <ErrorView
          headingLevel={2}
          error={channel.error}
          title="The channel could not be read"
          onRetry={() => void channel.refetch()}
        />
      </div>
    );
  }
  return (
    <div
      className="screen"
      data-testid="alert-channel-form"
    >
      {back}
      <ChannelEditor
        key={channel.data?.revision ?? "new"}
        scope={scope}
        channel={fresh ? null : (channel.data ?? null)}
      />
    </div>
  );
}

/** The form, for a channel read (or `null` for a new one). */
function ChannelEditor({
  scope,
  channel,
}: {
  scope: string;
  channel: AlertChannelDto | null;
}) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canWrite = useGlobalCanFn()("alerts:write");
  const [id, setId] = useState("");
  const [name, setName] = useState(channel?.name ?? "");
  const [type, setType] = useState<AlertChannelDto["type"]>(
    channel?.type ?? "webhook",
  );
  const [url, setUrl] = useState("");
  const [to, setTo] = useState(channel?.to?.join(", ") ?? "");
  const [kinds, setKinds] = useState(channel?.receives?.kinds.join(", ") ?? "");
  const [minSeverity, setMinSeverity] = useState<
    "" | "info" | "warning" | "critical"
  >(channel?.receives?.minSeverity ?? "");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  const receives =
    listOf(kinds).length === 0
      ? null
      : {
          kinds: listOf(kinds),
          ...(minSeverity === "" ? {} : { minSeverity }),
        };
  /** Runs `action`, reporting its failure in the form. */
  const run = async (action: () => Promise<void>, failed: string) => {
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError(
        isApiError(failure)
          ? failure.status === 409
            ? "The channel changed meanwhile (or the id is taken): reload it."
            : `${failed}: ${failure.detail ?? failure.title}`
          : `${failed}.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (channel === null) {
        if (!CHANNEL_ID.test(id.trim())) {
          setError("An id is 1 to 64 letters, digits, _, . and -.");
          return;
        }
        const answer = await withStepUp(() =>
          dataOf(
            client.post("/alerts/channels", {
              body: {
                id: id.trim(),
                name: name.trim(),
                type,
                ...(type === "email"
                  ? { to: listOf(to) }
                  : { url: url.trim() }),
                ...(receives === null ? {} : { receives }),
              },
            }),
          ),
        );
        await queryClient.invalidateQueries({ queryKey: ["alerts"] });
        if (answer.secret === undefined) {
          navigate(
            `/alerts/channels/${encodeURIComponent(answer.channel.id)}?${scopeQuery}`,
          );
        } else setSecret(answer.secret);
        return;
      }
      await dataOf(
        client.put("/alerts/channels/:id", {
          params: { id: channel.id },
          body: {
            name: name.trim(),
            ...(channel.type === "email"
              ? { to: listOf(to) }
              : url.trim() === ""
                ? {}
                : { url: url.trim() }),
            receives,
            revision: channel.revision,
          },
        }),
      );
      setUrl("");
      setStatus("Saved.");
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
    }, "Not saved");
  const rotate = () =>
    run(async () => {
      if (channel === null) return;
      const answer = await withStepUp(() =>
        dataOf(
          client.post("/alerts/channels/:id/secret", {
            params: { id: channel.id },
            body: { revision: channel.revision },
          }),
        ),
      );
      if (answer.secret !== undefined) setSecret(answer.secret);
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
    }, "Not rotated");
  const test = () =>
    run(async () => {
      if (channel === null) return;
      await dataOf(
        client.post("/alerts/channels/:id/test", {
          params: { id: channel.id },
        }),
      );
      setStatus(
        "A test message is queued: the delivery log shows how it went.",
      );
    }, "The test was not sent");
  return (
    <>
      <h2>{channel === null ? "New channel" : channel.name}</h2>
      {secret === null ? null : (
        <SecretOnce
          label="The webhook's signing secret"
          secret={secret}
          use="Verify the webhook's signatures with it"
          onDone={() => {
            setSecret(null);
            if (channel === null) navigate(`/alerts/channels?${scopeQuery}`);
          }}
        />
      )}
      <form
        className="filters"
        aria-label="Channel"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setError("Give the channel a name.");
            return;
          }
          void save();
        }}
      >
        {channel === null ? (
          <>
            <label>
              Id{" "}
              <input
                className="input"
                value={id}
                required
                data-testid="channel-id"
                onChange={(e) => setId(e.target.value)}
              />
            </label>
            <label>
              Type{" "}
              <select
                className="input"
                value={type}
                data-testid="channel-type"
                onChange={(e) =>
                  setType(e.target.value as AlertChannelDto["type"])
                }
              >
                {(["webhook", "slack", "email"] as const).map((item) => (
                  <option
                    key={item}
                    value={item}
                  >
                    {CHANNEL_TYPES[item]}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <p>{CHANNEL_TYPES[channel.type]}</p>
        )}
        <label>
          Name{" "}
          <input
            className="input"
            value={name}
            disabled={!canWrite}
            data-testid="channel-name"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {type === "email" ? (
          <label>
            Addresses (commas){" "}
            <input
              className="input"
              value={to}
              disabled={!canWrite}
              data-testid="channel-to"
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        ) : (
          <label>
            {channel === null
              ? "URL"
              : `URL (now ${channel.url ?? "?"}; type a new one to change it)`}{" "}
            <input
              className="input"
              type="url"
              value={url}
              disabled={!canWrite}
              autoComplete="off"
              data-testid="channel-url"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
        )}
        <label>
          Also receives the control plane's alerts (kinds, commas; * for all){" "}
          <input
            className="input"
            value={kinds}
            disabled={!canWrite}
            data-testid="channel-kinds"
            onChange={(e) => setKinds(e.target.value)}
          />
        </label>
        <label>
          Least severity{" "}
          <select
            className="input"
            value={minSeverity}
            disabled={!canWrite}
            data-testid="channel-min-severity"
            onChange={(e) =>
              setMinSeverity(
                e.target.value as "" | "info" | "warning" | "critical",
              )
            }
          >
            <option value="">Any</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        {canWrite ? (
          <div className="filters-actions">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy}
              data-testid="channel-save"
            >
              {channel === null ? "Make the channel" : "Save"}
            </Button>
            {channel === null ? null : (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  data-testid="channel-test"
                  onClick={() => void test()}
                >
                  Send a test
                </Button>
                {channel.type === "webhook" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    data-testid="channel-rotate"
                    onClick={() => void rotate()}
                  >
                    Rotate the signing secret
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  data-testid="channel-delete"
                  onClick={() => setDeleting(true)}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        ) : null}
        {error === null ? null : <p role="alert">{error}</p>}
        {status === null ? null : (
          <p
            role="status"
            data-testid="channel-status"
          >
            {status}
          </p>
        )}
      </form>
      {channel !== null && canWrite ? (
        <ConfirmDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          isApiError={isApiError}
          variant="danger"
          title={`Delete the channel “${channel.name}”`}
          confirmLabel="Delete"
          pendingLabel="Deleting…"
          onConfirm={async () => {
            await dataOf(
              client.delete("/alerts/channels/:id", {
                params: { id: channel.id },
                query: { revision: channel.revision },
              }),
            );
            await queryClient.invalidateQueries({ queryKey: ["alerts"] });
            navigate(`/alerts/channels?${scopeQuery}`);
          }}
        >
          <p>
            Rules naming it keep raising alerts, sent to their other channels.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
