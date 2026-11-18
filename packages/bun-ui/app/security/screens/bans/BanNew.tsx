/**
 * The manual ban form (ui.md §4.2): a subject (an address or range, an
 * account id the operator types — keyed by the control plane, shown back
 * once — or an account key the API reported), the scope, the action, how
 * long (24 h by default, or permanent) and why. It warns when the subject
 * holds the operator's own address.
 *
 * Pre-filled from a URL (the contract U2's top offenders and the events
 * drawer link to): `/bans/new?scope=…&ip=…` | `&userHash=…` |
 * `&apiKeyHash=…`, with optional `action`, `duration` and `reason`. One
 * subject parameter; a bad value opens the form with that field empty and
 * flagged; nothing is sent until the operator confirms.
 */
import type { BanDto } from "./banQueries";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { Field } from "../../../kit/components/Field";
import { TextInput } from "../../../kit/components/inputs";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { covers } from "../../components/addresses";
import { Subject } from "../../components/Subject";
import { useSecurityClient } from "../../context";
import { useCan } from "../../meta/hooks";
import { useMe } from "../../meta/me";
import { Link } from "../../router";
import { useLocation } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { NoAccess } from "../NoAccess";
import type { SubjectField } from "./banForm";
import { DURATIONS, FIELD_LABELS, prefillOf, validSubject } from "./banForm";

/** Props of {@link BanNew}. */
export interface BanNewProps {
  /** The scope on screen: where the ban applies. */
  scope: string;
}

/** See the module's description. */
export function BanNew({ scope }: BanNewProps) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const me = useMe();
  const canWrite = useCan("bans:write");
  const { search } = useLocation();
  const [initial] = useState(() => prefillOf(search));
  const [field, setField] = useState<SubjectField>(initial.field);
  const [value, setValue] = useState(initial.value);
  const [action, setAction] = useState<"ban" | "challenge">(initial.action);
  const [duration, setDuration] = useState(initial.duration);
  const [reason, setReason] = useState(initial.reason);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    initial.flagged
      ? "The linked subject was not valid: enter it again."
      : null,
  );
  const [created, setCreated] = useState<BanDto | null>(null);
  if (!canWrite)
    return (
      <NoAccess
        section="New ban"
        scope={scope}
        needs="bans:write"
      />
    );
  const myAddress = typeof me.address === "string" ? me.address : null;
  const ownAddress =
    field === "ip" &&
    myAddress !== null &&
    validSubject("ip", value) &&
    covers(value, myAddress);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const ban = await dataOf(
        client.post("/bans", {
          body: {
            scope,
            [field]: value.trim(),
            action,
            reason: reason.trim(),
            duration: duration === "permanent" ? null : duration,
          },
        }),
      );
      setCreated(ban);
      setValue("");
      await queryClient.invalidateQueries({ queryKey: ["bansList"] });
    } catch (failure) {
      setError(
        isApiError(failure)
          ? (failure.detail ?? failure.title)
          : "The ban was not written.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (created !== null) {
    const typed = created.entered?.user ?? created.entered?.apiKey;
    return (
      <div
        className="screen"
        data-testid="ban-created"
      >
        <h1>Ban written</h1>
        <p>
          <Subject
            kind={created.subject.type}
            value={created.subject.value}
          />{" "}
          is banned on {scopeLabel(created.scope)}.
        </p>
        {typed === undefined ? null : (
          <p
            role="note"
            data-testid="ban-entered"
          >
            You typed <code>{typed}</code>: it is shown here once. The control
            plane keeps only its key, <code>{created.subject.value}</code>.
          </p>
        )}
        <p>
          <Link
            to={`/bans/${encodeURIComponent(created.id)}?scope=${encodeURIComponent(scope)}`}
          >
            Open the ban
          </Link>
          {" · "}
          <Link to={`/bans?scope=${encodeURIComponent(scope)}`}>
            Back to the bans
          </Link>
        </p>
      </div>
    );
  }
  const valid = validSubject(field, value) && reason.trim() !== "";
  return (
    <form
      className="screen ban-form"
      data-testid="ban-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h1>New ban on {scopeLabel(scope)}</h1>
      <Field label="Subject">
        {(control) => (
          <select
            data-always-set
            {...control}
            className="input"
            value={field}
            data-testid="ban-field"
            onChange={(event) => {
              setField(event.target.value as SubjectField);
              setValue("");
            }}
          >
            {(Object.keys(FIELD_LABELS) as SubjectField[]).map((name) => (
              <option
                key={name}
                value={name}
              >
                {FIELD_LABELS[name]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label={FIELD_LABELS[field]}
        required
        error={
          value !== "" && !validSubject(field, value) ? "Not valid." : undefined
        }
      >
        <TextInput
          placeholder="e.g. 203.0.113.7 or 198.51.100.0/24"
          value={value}
          onChange={setValue}
          data-testid="ban-value"
        />
      </Field>
      {ownAddress ? (
        <p
          role="alert"
          className="warning"
          data-testid="ban-own-address"
        >
          This covers your own address ({myAddress}): banning it may lock you
          out of the services under {scopeLabel(scope)}.
        </p>
      ) : null}
      <Field label="Action">
        {(control) => (
          <select
            data-always-set
            {...control}
            className="input"
            value={action}
            data-testid="ban-action"
            onChange={(e) => setAction(e.target.value as "ban" | "challenge")}
          >
            <option value="ban">Ban</option>
            <option value="challenge">Challenge</option>
          </select>
        )}
      </Field>
      <Field label="How long">
        {(control) => (
          <select
            data-always-set
            {...control}
            className="input"
            value={duration}
            data-testid="ban-duration"
            onChange={(e) =>
              setDuration(e.target.value as (typeof DURATIONS)[number])
            }
          >
            {DURATIONS.map((option) => (
              <option
                key={option}
                value={option}
              >
                {option === "permanent" ? "Until lifted" : option}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="Reason (operators only)"
        required
      >
        <TextInput
          placeholder="e.g. Credential stuffing from this range"
          value={reason}
          onChange={setReason}
          data-testid="ban-reason"
          maxLength={500}
        />
      </Field>
      {error === null ? null : (
        <p
          role="alert"
          data-testid="ban-error"
        >
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={!valid || busy}
        data-testid="ban-submit"
      >
        Ban
      </Button>
    </form>
  );
}
