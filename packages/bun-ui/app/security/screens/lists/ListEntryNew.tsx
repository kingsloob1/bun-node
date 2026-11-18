/**
 * `/lists/new` (ui.md §4.1): a form adding one entry to the scope's draft
 * (`PUT /policies/:scope/draft`, the whole policy at the revision read,
 * through step-up), after the operator confirms. It needs `policy:draft`.
 *
 * Other screens link here pre-filled (the top offenders, the events
 * drawer): `?scope=<scope>` and **one** subject parameter — `ip` (an
 * address or CIDR range), `country` (ISO 3166-1 alpha-2), `asn`,
 * `userHash` or `apiKeyHash` (an account's key) — with an optional
 * `action` (`allow`, `block`, `challenge`, `drop`) and `reason`. A value
 * that is not valid opens the form with that field empty and flagged (never
 * echoed: a malformed key may be an account id in the wrong parameter);
 * nothing is saved until the operator confirms.
 */
import type { ListAction, ListMode } from "./entries";
import type { Problems } from "./prefill";
import type { EntryField, EntryInput, InputKind } from "./validate";
import type { EnteredAccount } from "./policy";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Field } from "../../../kit/components/Field";
import {
  Checkbox,
  DateTimeInput,
  Select,
  TextInput,
} from "../../../kit/components/inputs";
import { Spinner } from "../../../kit/components/Spinner";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useLocation } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { NoAccess } from "../NoAccess";
import { entryKey, LIST_ACTIONS, LIST_MODES } from "./entries";
import { prefill } from "./prefill";
import { EnteredEcho, EntrySubject } from "./parts";
import { enteredOf, isConflict, usePolicyLists, useSaveDraft } from "./policy";
import {
  checkEntry,
  INPUT_KIND_LABELS,
  INPUT_KINDS,
  MAX_REASON,
} from "./validate";
import "./lists.css";

/** Props of {@link ListEntryNew}. */
export interface ListEntryNewProps {
  /** The scope on screen. */
  scope: string;
}

/** See the module's description. */
export function ListEntryNew({ scope }: ListEntryNewProps) {
  const canDraft = useCan("policy:draft");
  if (!canDraft) {
    return (
      <NoAccess
        section="adding a list entry"
        scope={scope}
        needs="policy:draft"
      />
    );
  }
  return (
    <EntryForm
      key={scope}
      scope={scope}
    />
  );
}

/** A form value's change, clearing that field's problem. */
type Setter = <K extends keyof EntryInput>(
  field: K,
  value: EntryInput[K],
) => void;

/** The form for one scope. */
function EntryForm({ scope }: ListEntryNewProps) {
  const { search } = useLocation();
  const [start] = useState(() => prefill(search));
  const [input, setInput] = useState<EntryInput>(start.input);
  const [problems, setProblems] = useState<Problems>(start.problems);
  const [expiresMs, setExpiresMs] = useState<number | undefined>(undefined);
  const [expiryProblem, setExpiryProblem] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState<EnteredAccount[] | null>(null);
  const data = usePolicyLists(scope);
  const save = useSaveDraft(scope);

  const set: Setter = (field, value) => {
    setInput((old) => {
      const next = { ...old, [field]: value };
      // A country is never allowed: its action must be chosen again.
      if (field === "kind" && value === "country" && old.action === "allow")
        next.action = "";
      return next;
    });
    setProblems((old) => {
      const { [field as EntryField]: _gone, ...rest } = old;
      return rest;
    });
  };

  if (data.pending) return <Spinner label="Loading the policy" />;
  if (data.error !== null && data.error !== undefined) {
    return (
      <div className="screen">
        <ErrorView
          error={data.error}
          title="Could not read the policy"
          onRetry={() => void data.reload()}
        />
      </div>
    );
  }
  const listsHref = `/lists?scope=${encodeURIComponent(scope)}`;
  const withExpiry: EntryInput = {
    ...input,
    expiresAt: expiresMs === undefined ? "" : new Date(expiresMs).toISOString(),
  };
  const checked = checkEntry(withExpiry);
  const entry = checked.ok ? checked.entry : null;

  const submit = () => {
    const found: Problems = checked.ok ? {} : { ...checked.errors };
    if (expiryProblem !== undefined) found.expiresAt = expiryProblem;
    else if (expiresMs !== undefined && expiresMs <= Date.now())
      found.expiresAt = "Already past";
    if (
      entry !== null &&
      data.lists.some((item) => entryKey(item) === entryKey(entry))
    )
      found.value = "Already listed in this scope";
    setProblems(found);
    if (Object.keys(found).length === 0) setConfirming(true);
  };

  if (saved !== null) {
    return (
      <div
        className="screen lists-new"
        data-testid="lists-new-saved"
      >
        <h1>Entry added to the draft</h1>
        <p>
          The entry is in the draft of {scopeLabel(scope)}. It applies once the
          draft is published.
        </p>
        {saved.length === 0 ? null : (
          <EnteredEcho
            accounts={saved}
            onDismiss={() => setSaved([])}
          />
        )}
        <div className="lists-actions">
          <Link
            className="btn btn-primary"
            to={listsHref}
          >
            Back to the lists
          </Link>
        </div>
      </div>
    );
  }

  const kind = input.kind;
  const actions = LIST_ACTIONS.filter(
    (action) => !(action === "allow" && kind === "country"),
  );
  return (
    <div
      className="screen lists-new"
      data-testid="lists-new"
    >
      <h1>Add a list entry: {scopeLabel(scope)}</h1>
      <p className="muted">
        The entry goes into the scope&apos;s draft; nothing applies until the
        draft is published.
      </p>
      {conflict ? (
        <div
          className="problem-banner"
          role="alert"
          data-testid="lists-conflict"
        >
          <div className="problem-banner-main">
            <p className="problem-banner-title">
              <strong>The draft changed since you read it.</strong>
            </p>
            <p className="problem-banner-detail">
              Reload it, then add the entry again: the form keeps what you
              wrote.
            </p>
          </div>
          <div className="problem-banner-actions">
            <Button
              size="sm"
              data-testid="lists-reload"
              onClick={() => {
                setConflict(false);
                void data.reload();
              }}
            >
              Reload
            </Button>
          </div>
        </div>
      ) : null}
      <form
        className="lists-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label="Kind"
          error={problems.kind}
          required
        >
          <Select<InputKind | "">
            value={kind}
            options={[
              ...(kind === ""
                ? [{ value: "" as const, label: "Choose…" }]
                : []),
              ...INPUT_KINDS.map((value) => ({
                value,
                label: INPUT_KIND_LABELS[value],
              })),
            ]}
            onChange={(value) => set("kind", value)}
            data-testid="lists-new-kind"
          />
        </Field>
        <Field
          label="Value"
          error={problems.value}
          hint={
            kind === "user" || kind === "apiKey"
              ? "The control plane stores only its key, and shows this id back once, when the draft is saved."
              : kind === "userHash" || kind === "apiKeyHash"
                ? "32 lower-case hex characters, as the events and bans show it."
                : kind === "country"
                  ? "ISO 3166-1 alpha-2, upper case (KP)."
                  : kind === "asn"
                    ? "An autonomous system number (13335)."
                    : "An IPv4 or IPv6 address, or a CIDR range."
          }
          required
        >
          <TextInput
            value={input.value}
            autoComplete="off"
            spellCheck={false}
            onChange={(value) =>
              set("value", kind === "country" ? value.toUpperCase() : value)
            }
            data-testid="lists-new-value"
          />
        </Field>
        <Field
          label="Action"
          error={problems.action}
          hint={
            kind === "country"
              ? "A whole country cannot be allowed (the policy refuses it): allow its addresses or ASNs instead."
              : "challenge falls back to block until a challenge provider is configured; drop closes the connection with no answer."
          }
          required
        >
          <Select<ListAction | "">
            value={input.action}
            options={[
              ...(input.action === ""
                ? [{ value: "" as const, label: "Choose…" }]
                : []),
              ...actions.map((value) => ({ value })),
            ]}
            onChange={(value) => set("action", value)}
            data-testid="lists-new-action"
          />
        </Field>
        {input.action === "allow" ? (
          <Checkbox
            checked={input.override}
            onChange={(value) => set("override", value)}
            label="Override"
            hint="Win over a block in the same scope."
            data-testid="lists-new-override"
          />
        ) : null}
        <Checkbox
          checked={input.locked}
          onChange={(value) => set("locked", value)}
          label="Locked"
          hint="Lower scopes cannot override it."
          data-testid="lists-new-locked"
        />
        <Field
          label="Paths"
          error={problems.paths}
          hint="Route prefixes it applies to, separated by commas; every path when empty."
        >
          <TextInput
            value={input.paths}
            placeholder="/login, /api/auth"
            onChange={(value) => set("paths", value)}
            data-testid="lists-new-paths"
          />
        </Field>
        <Field
          label="Expires"
          error={problems.expiresAt}
          hint="Never when empty."
        >
          <DateTimeInput
            value={expiresMs}
            onChange={(value) => {
              setExpiresMs(value);
              setProblems(({ expiresAt: _gone, ...rest }) => rest);
            }}
            onProblem={setExpiryProblem}
            data-testid="lists-new-expires"
          />
        </Field>
        <Field
          label="Reason"
          error={problems.reason}
          hint="For operators; never sent to the client."
        >
          <TextInput
            value={input.reason}
            maxLength={MAX_REASON}
            onChange={(value) => set("reason", value)}
            data-testid="lists-new-reason"
          />
        </Field>
        <Field
          label="Mode"
          error={problems.mode}
          hint="dryRun records what it would do; off disables it."
        >
          <Select<ListMode | "">
            value={input.mode}
            options={[
              { value: "", label: "enforce (default)" },
              ...LIST_MODES.filter((mode) => mode !== "enforce").map(
                (value) => ({ value }),
              ),
            ]}
            onChange={(value) => set("mode", value)}
            data-testid="lists-new-mode"
          />
        </Field>
        <div className="lists-actions">
          <Button
            type="submit"
            variant="primary"
            data-testid="lists-new-submit"
          >
            Add to the draft
          </Button>
          <Link
            className="btn btn-secondary"
            to={listsHref}
          >
            Cancel
          </Link>
        </div>
      </form>
      <ConfirmDialog
        open={confirming && entry !== null}
        onClose={() => setConfirming(false)}
        title={`Add this entry to the draft of ${scopeLabel(scope)}?`}
        confirmLabel="Add to the draft"
        pendingLabel="Saving…"
        isApiError={isApiError}
        onConfirm={async () => {
          try {
            const answer = await save(
              { ...data.base, lists: [...data.lists, entry!] },
              data.policy?.draft?.revision ?? null,
            );
            setSaved(enteredOf(answer));
          } catch (error) {
            if (!isConflict(error)) throw error;
            setConflict(true);
          }
        }}
      >
        {entry === null ? null : (
          <p data-testid="lists-new-summary">
            <EntrySubject entry={entry} />: <strong>{entry.action}</strong>
            {entry.paths === undefined ? "" : ` on ${entry.paths.join(", ")}`}
            {entry.expiresAt === undefined ? "" : `, until ${entry.expiresAt}`}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
