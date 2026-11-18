/**
 * `/lists` (ui.md §4.1): the scope's list entries — the draft's when there
 * is one (marked as such), else the published head's — with, on a service,
 * the entries it inherits from the scopes above, read-only and named by
 * where they come from. Filterable by kind, action, expiry and origin,
 * searchable by value (an address finds the ranges containing it), paged
 * through the URL. An operator with `policy:draft` removes entries and
 * imports a CSV into unsaved changes, saved as the draft; one with
 * `policy:publish` publishes the saved draft. An element the operator may
 * not use is absent.
 */
import type { ListEntryDto } from "./entries";
import type { ListFilters, ListRow } from "./filters";
import type { EnteredAccount } from "./policy";
import type { ApprovalDto, PublishOutcome } from "./PublishDialog";
import { useState } from "react";
import { Badge } from "../../../kit/components/Badge";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { EmptyState } from "../../../kit/components/EmptyState";
import { Field } from "../../../kit/components/Field";
import { Select, TextInput } from "../../../kit/components/inputs";
import { Pager } from "../../../kit/components/Pager";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { Table } from "../../../kit/components/Table";
import { useToast } from "../../../kit/components/toast";
import { clientWindow } from "../../../kit/components/useClientPage";
import { isApiError } from "../../api/errors";
import { download } from "../../components/download";
import { ErrorView } from "../../components/ErrorView";
import { useCan } from "../../meta/hooks";
import { Link } from "../../router";
import { useRouter } from "../../routing";
import { scopeLabel } from "../../scope/scope";
import { toCsv } from "./csv";
import {
  diffLists,
  entryKey,
  isExpired,
  KIND_LABELS,
  LIST_ACTIONS,
  otherFieldsDiffer,
} from "./entries";
import {
  applyFilters,
  DEFAULT_LIMIT,
  LIMIT_PARAM,
  PAGE_PARAM,
  PAGE_SIZES,
  readFilters,
  readPage,
} from "./filters";
import { ImportDialog } from "./ImportDialog";
import { EnteredEcho, EntrySubject } from "./parts";
import {
  enteredOf,
  isConflict,
  groupOf,
  serviceOf,
  usePolicyLists,
  useDiscardDraft,
  useSaveDraft,
} from "./policy";
import { PublishDialog } from "./PublishDialog";
import "./lists.css";

/** Props of {@link ListsScreen}. */
export interface ListsScreenProps {
  /** The scope on screen. */
  scope: string;
}

/** See the module's description. */
export function ListsScreen({ scope }: ListsScreenProps) {
  // Another scope starts afresh: no unsaved change crosses scopes.
  return (
    <ListsView
      key={scope}
      scope={scope}
    />
  );
}

/** The unsaved changes: own entries to remove (by index), entries to add. */
interface Staged {
  /** Indexes into the base list. */
  readonly removed: ReadonlySet<number>;
  /** New entries. */
  readonly added: readonly ListEntryDto[];
}

/** No unsaved change. */
const NOTHING_STAGED: Staged = { removed: new Set(), added: [] };

/** A row as shown: where it is in the base list or the staged additions. */
interface ShownRow extends ListRow {
  /** Its index in the base list (own saved entries). */
  readonly index?: number;
  /** Its index in the staged additions. */
  readonly addedIndex?: number;
  /** Saved, to be removed, or to be added. */
  readonly state: "saved" | "removing" | "adding";
}

/** The expiry choices. */
const EXPIRY_OPTIONS = [
  { value: "", label: "Any expiry" },
  { value: "expiring", label: "Expires" },
  { value: "permanent", label: "Never expires" },
  { value: "expired", label: "Expired" },
] as const;

/** The origin choices. */
const ORIGIN_OPTIONS = [
  { value: "", label: "Any scope" },
  { value: "own", label: "This scope" },
  { value: "inherited", label: "Inherited" },
] as const;

/** A count of things, in words. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
}

/** The screen for one scope. */
function ListsView({ scope }: ListsScreenProps) {
  const canDraft = useCan("policy:draft");
  const canPublish = useCan("policy:publish");
  const canEstimate = useCan("rules:test");
  const toast = useToast();
  const { location, navigate } = useRouter();
  const [staged, setStaged] = useState<Staged>(NOTHING_STAGED);
  const hasStaged = staged.removed.size > 0 || staged.added.length > 0;
  const data = usePolicyLists(scope, !hasStaged);
  const save = useSaveDraft(scope);
  const discard = useDiscardDraft(scope);
  const [echo, setEcho] = useState<EnteredAccount[]>([]);
  const [conflict, setConflict] = useState<"draft" | "head" | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [approval, setApproval] = useState<ApprovalDto | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Expiry is judged as of the screen's opening.
  const [now] = useState(() => Date.now());
  const filters = readFilters(location.search);
  const { page, limit } = readPage(location.search);

  /** Sets URL parameters (empty removes one); a filter starts the list again. */
  const setParams = (changes: Record<string, string>) => {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === "") params.delete(key);
      else params.set(key, value);
    }
    if (!(PAGE_PARAM in changes)) params.delete(PAGE_PARAM);
    const query = params.toString();
    navigate(`${location.path ?? "/lists"}${query === "" ? "" : `?${query}`}`, {
      replace: true,
    });
  };
  const setFilter = (name: keyof ListFilters, value: string) =>
    setParams({ [name]: value });

  if (data.pending) return <Spinner label="Loading the lists" />;
  if (data.error !== null && data.error !== undefined) {
    return (
      <div className="screen">
        <ErrorView
          error={data.error}
          title="Could not read the lists"
          onRetry={() => void data.reload()}
        />
      </div>
    );
  }
  const draft = data.policy?.draft ?? null;
  const head = data.policy?.head ?? null;
  const own: ShownRow[] = data.lists.map((entry, index) => ({
    entry,
    origin: scope,
    own: true,
    index,
    state: staged.removed.has(index) ? "removing" : "saved",
  }));
  const added: ShownRow[] = staged.added.map((entry, addedIndex) => ({
    entry,
    origin: scope,
    own: true,
    addedIndex,
    state: "adding",
  }));
  const inherited: ShownRow[] = data.inherited.map((row) => ({
    ...row,
    state: "saved",
  }));
  const everything = [...added, ...own, ...inherited];
  const rows = applyFilters(everything, filters, now) as ShownRow[];
  const slice = clientWindow(rows.length, {
    offset: (page - 1) * limit,
    limit,
  });
  const shown = rows.slice(slice.offset, slice.offset + slice.limit);
  const working = [
    ...data.lists.filter((_, index) => !staged.removed.has(index)),
    ...staged.added,
  ];
  const existingKeys = new Set(working.map(entryKey));
  const diff = draft === null ? null : diffLists(data.headLists, data.lists);
  const otherChanges =
    draft !== null && otherFieldsDiffer(data.head, data.base);
  const draftChanges =
    diff !== null &&
    (diff.added > 0 || diff.removed > 0 || diff.changed > 0 || otherChanges);
  const diffText =
    diff === null
      ? ""
      : draftChanges
        ? `Against the published version: ${count(diff.added, "entry", "entries")} added, ${diff.removed.toLocaleString("en")} removed, ${diff.changed.toLocaleString("en")} changed${otherChanges ? "; other policy settings changed too" : ""}.`
        : "The draft matches the published version.";

  const saveStaged = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await save(
        { ...data.base, lists: working },
        draft?.revision ?? null,
      );
      setStaged(NOTHING_STAGED);
      setEcho(enteredOf(answer));
      toast.success("Draft saved");
    } catch (error) {
      if (isConflict(error)) setConflict("draft");
      else setSaveError(error);
    } finally {
      setSaving(false);
    }
  };
  const reloadAfterConflict = () => {
    setStaged(NOTHING_STAGED);
    setConflict(null);
    setSaveError(null);
    void data.reload();
  };
  const onPublished = (outcome: PublishOutcome) => {
    setPublishOpen(false);
    if (outcome.kind === "approval") setApproval(outcome.approval);
    else toast.success(`Published version ${outcome.number}`);
    void data.reload();
  };
  const exportCsv = () => {
    const entries = rows
      .filter((row) => row.own && row.state !== "removing")
      .map((row) => row.entry);
    const { text, skipped } = toCsv(entries);
    download(`lists-${scope.replace(":", "-")}.csv`, text, "text/csv");
    if (skipped > 0) {
      toast.info(
        `${count(skipped, "entry", "entries")} not exported: an account id not yet keyed`,
      );
    }
  };
  const removeRow = (row: ShownRow) => {
    const { addedIndex, index } = row;
    if (addedIndex !== undefined) {
      setStaged((old) => ({
        ...old,
        added: old.added.filter((_, at) => at !== addedIndex),
      }));
      return;
    }
    if (index === undefined) return;
    setStaged((old) => {
      const removed = new Set(old.removed);
      if (removed.has(index)) removed.delete(index);
      else removed.add(index);
      return { ...old, removed };
    });
  };

  return (
    <div
      className="screen lists-screen"
      data-testid="lists"
    >
      <div className="lists-header">
        <h1>
          Lists: {scopeLabel(scope)}{" "}
          {draft === null ? null : (
            <Badge
              tone="warning"
              testId="lists-draft-badge"
            >
              Draft
            </Badge>
          )}
        </h1>
        <div className="lists-actions">
          {canDraft ? (
            <Link
              className="btn btn-primary"
              to={`/lists/new?scope=${encodeURIComponent(scope)}`}
              data-testid="lists-add"
            >
              Add entry
            </Link>
          ) : null}
          {canDraft ? (
            <Button
              onClick={() => setImportOpen(true)}
              data-testid="lists-import"
            >
              Import CSV
            </Button>
          ) : null}
          <Button
            onClick={exportCsv}
            data-testid="lists-export"
          >
            Export CSV
          </Button>
        </div>
      </div>

      <div
        className="lists-draft-bar notice"
        data-testid="lists-draft-bar"
      >
        {hasStaged ? (
          <>
            <p data-testid="lists-unsaved">
              <strong>Unsaved changes:</strong>{" "}
              {count(staged.added.length, "entry", "entries")} to add,{" "}
              {staged.removed.size.toLocaleString("en")} to remove.
            </p>
            <div className="lists-bar-actions">
              <Button
                variant="primary"
                disabled={saving}
                onClick={() => void saveStaged()}
                data-testid="lists-save"
              >
                {saving ? "Saving…" : "Save draft"}
              </Button>
              <Button
                disabled={saving}
                onClick={() => setStaged(NOTHING_STAGED)}
                data-testid="lists-discard-changes"
              >
                Discard changes
              </Button>
            </div>
          </>
        ) : draft === null ? (
          <p data-testid="lists-source">
            {head === null
              ? "Nothing published yet, and no draft."
              : `Showing published version ${head.number}. Changes are saved as a draft first.`}
          </p>
        ) : (
          <>
            <p data-testid="lists-source">
              <strong>Saved draft</strong> (revision {draft.revision}, by{" "}
              {draft.updatedBy}
              {head === null
                ? "; nothing published yet"
                : `, over version ${head.number}`}
              ). <span data-testid="lists-diff">{diffText}</span>
            </p>
            <div className="lists-bar-actions">
              {canPublish && draftChanges ? (
                <Button
                  variant="primary"
                  onClick={() => setPublishOpen(true)}
                  data-testid="lists-publish"
                >
                  Publish
                </Button>
              ) : null}
              {canDraft && draftChanges ? (
                <Button
                  onClick={() => setDiscardOpen(true)}
                  data-testid="lists-discard-draft"
                >
                  Discard draft
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>

      {conflict !== null ? (
        <div
          className="problem-banner"
          role="alert"
          data-testid="lists-conflict"
        >
          <div className="problem-banner-main">
            <p className="problem-banner-title">
              <strong>
                {conflict === "draft"
                  ? "The draft changed since you read it."
                  : "The published version changed since you read it."}
              </strong>
            </p>
            <p className="problem-banner-detail">
              {conflict === "draft"
                ? "Another change was saved first. Reload to see it; your unsaved changes are dropped."
                : "Another publish went first. Reload, check the draft against the new version, and publish again."}
            </p>
          </div>
          <div className="problem-banner-actions">
            <Button
              size="sm"
              onClick={reloadAfterConflict}
              data-testid="lists-reload"
            >
              Reload
            </Button>
          </div>
        </div>
      ) : null}
      {saveError === null ? null : (
        <ProblemBanner
          error={saveError}
          title="Could not save the draft"
          isApiError={isApiError}
          onDismiss={() => setSaveError(null)}
        />
      )}
      {echo.length === 0 ? null : (
        <EnteredEcho
          accounts={echo}
          onDismiss={() => setEcho([])}
        />
      )}
      {approval === null ? null : (
        <div
          className="notice"
          role="status"
          data-testid="lists-approval"
        >
          <p>
            <strong>Approval {approval.id} opened</strong> ({approval.status}):
            a second operator must approve this publish before it goes out. It
            expires {new Date(approval.expiresAt).toISOString()}.
          </p>
          {approval.dangerous.length > 0 ? (
            <p>Dangerous: {approval.dangerous.join("; ")}</p>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setApproval(null)}
          >
            Dismiss
          </Button>
        </div>
      )}
      {data.inheritedError === null ||
      data.inheritedError === undefined ? null : (
        <ProblemBanner
          error={data.inheritedError}
          title="Could not read the inherited entries"
          isApiError={isApiError}
        />
      )}

      <div
        className="lists-filters"
        role="search"
      >
        <Field label="Search by value">
          <TextInput
            type="search"
            value={filters.q}
            placeholder="203.0.113.7, a key, KP, 13335"
            onChange={(value) => setFilter("q", value)}
            data-testid="lists-search"
          />
        </Field>
        <Field label="Kind">
          <Select
            placeholder="Choose a kind"
            value={filters.kind}
            options={[
              { value: "", label: "Any kind" },
              ...Object.entries(KIND_LABELS).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
            onChange={(value) => setFilter("kind", value)}
            data-testid="lists-filter-kind"
          />
        </Field>
        <Field label="Action">
          <Select
            placeholder="Choose an action"
            value={filters.action}
            options={[
              { value: "", label: "Any action" },
              ...LIST_ACTIONS.map((value) => ({ value })),
            ]}
            onChange={(value) => setFilter("action", value)}
            data-testid="lists-filter-action"
          />
        </Field>
        <Field label="Expiry">
          <Select
            placeholder="Choose an expiry"
            value={filters.expiry}
            options={EXPIRY_OPTIONS}
            onChange={(value) => setFilter("expiry", value)}
            data-testid="lists-filter-expiry"
          />
        </Field>
        {serviceOf(scope) === null && groupOf(scope) === null ? null : (
          <Field label="Origin">
            <Select
              placeholder="Choose an origin"
              value={filters.origin}
              options={ORIGIN_OPTIONS}
              onChange={(value) => setFilter("origin", value)}
              data-testid="lists-filter-origin"
            />
          </Field>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={everything.length === 0 ? "No entries" : "No entries match"}
          description={
            everything.length === 0
              ? "This scope lists no address, account, country or ASN."
              : "Change the filters or the search."
          }
        />
      ) : (
        <>
          <Table label={`List entries of ${scopeLabel(scope)}`}>
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col">Action</th>
                <th scope="col">Override</th>
                <th scope="col">Locked</th>
                <th scope="col">Mode</th>
                <th scope="col">Paths</th>
                <th scope="col">Origin</th>
                <th scope="col">Expires</th>
                <th scope="col">Reason</th>
                {canDraft ? (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <EntryRow
                  key={
                    row.addedIndex !== undefined
                      ? `added:${row.addedIndex}`
                      : row.own
                        ? `own:${row.index}`
                        : `inherited:${row.origin}:${entryKey(row.entry)}`
                  }
                  row={row}
                  now={now}
                  canDraft={canDraft}
                  onRemove={() => removeRow(row)}
                />
              ))}
            </tbody>
          </Table>
          {slice.paged || page > 1 ? (
            <Pager
              offset={slice.offset}
              limit={slice.limit}
              total={rows.length}
              itemCount={shown.length}
              pageSizes={PAGE_SIZES}
              maxPageSize={PAGE_SIZES.at(-1)}
              label="List pages"
              onChange={(move) =>
                setParams({
                  [PAGE_PARAM]:
                    move.offset === 0
                      ? ""
                      : String(Math.floor(move.offset / move.limit) + 1),
                  [LIMIT_PARAM]:
                    move.limit === DEFAULT_LIMIT ? "" : String(move.limit),
                })
              }
            />
          ) : null}
        </>
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        existing={existingKeys}
        onImport={(entries) =>
          setStaged((old) => ({ ...old, added: [...old.added, ...entries] }))
        }
      />
      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        scope={scope}
        expectedHead={head?.id ?? null}
        summary={diffText}
        canEstimate={canEstimate}
        onPublished={onPublished}
        onConflict={() => {
          setPublishOpen(false);
          setConflict("head");
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        onClose={() => setDiscardOpen(false)}
        title="Discard the draft?"
        description={
          head === null
            ? "The draft is deleted: nothing has been published yet."
            : `The draft is deleted, and the scope shows published version ${head.number} again; its changes are lost.`
        }
        confirmLabel="Discard draft"
        variant="danger"
        isApiError={isApiError}
        onConfirm={async () => {
          if (draft !== null) await discard(draft.revision);
          toast.success("Draft discarded");
        }}
      />
    </div>
  );
}

/** Props of {@link EntryRow}. */
interface EntryRowProps {
  /** The row. */
  row: ShownRow;
  /** The time expiry is judged at, epoch ms. */
  now: number;
  /** Whether the operator may change the draft. */
  canDraft: boolean;
  /** Removes the entry (or undoes its removal, or drops an unsaved one). */
  onRemove: () => void;
}

/** One entry. */
function EntryRow({ row, now, canDraft, onRemove }: EntryRowProps) {
  const { entry } = row;
  const expired = isExpired(entry, now);
  return (
    <tr
      data-testid="lists-row"
      data-origin={row.own ? "own" : "inherited"}
      data-state={row.state}
      className={row.state === "removing" ? "lists-row-removing" : undefined}
    >
      <td>
        <EntrySubject entry={entry} />
      </td>
      <td>
        <Badge
          tone={
            entry.action === "allow"
              ? "success"
              : entry.action === "challenge"
                ? "warning"
                : "danger"
          }
        >
          {entry.action}
        </Badge>
      </td>
      <td>{entry.override === true ? "Yes" : ""}</td>
      <td>
        {entry.locked === true ? <Badge tone="accent">Locked</Badge> : ""}
      </td>
      <td>{entry.mode ?? "enforce"}</td>
      <td>{entry.paths === undefined ? "All" : entry.paths.join(", ")}</td>
      <td data-testid="lists-row-origin">
        {!row.own ? (
          <>
            {scopeLabel(row.origin)}{" "}
            <span className="muted">
              {entry.locked === true ? "(locked, read-only)" : "(read-only)"}
            </span>
          </>
        ) : row.state === "adding" ? (
          <Badge tone="info">Unsaved</Badge>
        ) : (
          "This scope"
        )}
      </td>
      <td>
        {entry.expiresAt ?? "Never"}
        {expired ? (
          <>
            {" "}
            <Badge tone="neutral">Expired</Badge>
          </>
        ) : null}
      </td>
      <td className="lists-reason">{entry.reason ?? ""}</td>
      {canDraft ? (
        <td>
          {row.own ? (
            <Button
              size="sm"
              variant={row.state === "removing" ? "secondary" : "ghost"}
              onClick={onRemove}
              data-testid="lists-remove"
            >
              {row.state === "removing" ? "Undo" : "Remove"}
            </Button>
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
