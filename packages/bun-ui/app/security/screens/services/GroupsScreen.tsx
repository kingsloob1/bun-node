/**
 * `/groups` (ui.md §3): the groups as a tree (a group nests under its
 * parent, at most 4 deep), each with its member services and a link to its
 * policy. With `groups:write` on global: **New group**; with it on a
 * group's own scope (or a group above it): that group's **Edit** (its
 * name, parent and labels; a parent cannot be the group itself or one under
 * it) and **Delete**, each at the revision read (a `409` when someone
 * changed it since, shown with a reload; a `422` names what is wrong, such
 * as a nesting too deep or a group still holding services).
 */
import type { GroupDto, ServiceDto } from "./queries";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Dialog } from "../../../kit/components/Dialog";
import { Field } from "../../../kit/components/Field";
import { Select, TextInput } from "../../../kit/components/inputs";
import { JsonEditor } from "../../../kit/components/JsonEditor";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { useToast } from "../../../kit/components/toast";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { useGlobalCanFn } from "../../meta/hooks";
import { Link } from "../../router";
import { SCOPE_PARAM } from "../../scope/scope";
import { withStepUp } from "../../stepUp";
import { isConflict } from "../lists/policy";
import {
  descendantsOf,
  servicesKeys,
  useAllGroups,
  useAllServices,
  useCanOn,
} from "./queries";
import { ServicesNav } from "./ServicesNav";
import "./services.css";

/** The group dialog's subject: a new group, or one to edit. */
type Editing =
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly group: GroupDto };

/** Props of {@link GroupDialog}. */
interface GroupDialogProps {
  /** What is edited. */
  editing: Editing;
  /** Every group, for the parent picker. */
  groups: readonly GroupDto[];
  /** Closes it. */
  onClose: () => void;
}

/** A group's form, in a dialog. */
function GroupDialog({ editing, groups, onClose }: GroupDialogProps) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const group = editing.kind === "edit" ? editing.group : undefined;
  const [id, setId] = useState("");
  const [name, setName] = useState(group?.name ?? "");
  const [parent, setParent] = useState(group?.parent ?? "");
  const [labels, setLabels] = useState(
    JSON.stringify(group?.labels ?? {}, null, 2),
  );
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  let parsed: Record<string, string> | null = null;
  try {
    const value = JSON.parse(labels) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      parsed = value as Record<string, string>;
  } catch {
    parsed = null;
  }
  // A group cannot sit under itself or under one of its own.
  const excluded =
    group === undefined ? new Set<string>() : descendantsOf(group.id, groups);
  const save = async () => {
    if (parsed === null) return;
    setSaving(true);
    setError(null);
    const body = {
      name,
      parent: parent === "" ? null : parent,
      labels: parsed,
    };
    try {
      await withStepUp(() =>
        group === undefined
          ? dataOf(
              client.post("/groups", {
                body: { ...body, ...(id === "" ? {} : { id }) },
              }),
            )
          : dataOf(
              client.put("/groups/:id", {
                params: { id: group.id },
                body: { ...body, revision: group.revision },
              }),
            ),
      );
      await queryClient.invalidateQueries({ queryKey: servicesKeys.all() });
      toast.success(group === undefined ? "Group created" : "Group saved");
      onClose();
    } catch (caught) {
      if (isConflict(caught)) setConflict(true);
      else setError(caught);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={group === undefined ? "New group" : `Edit group ${group.name}`}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="group-save"
            disabled={
              saving || name.trim() === "" || parsed === null || conflict
            }
            onClick={() => void save()}
          >
            {saving ? "Saving…" : group === undefined ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      {conflict ? (
        <div
          className="notice"
          role="alert"
          data-testid="group-conflict"
        >
          <p>
            {group === undefined
              ? "A group with this id exists already."
              : "Someone changed this group since you read it: close and reload it."}
          </p>
          {group === undefined ? null : (
            <Button
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: servicesKeys.groups(),
                });
                onClose();
              }}
            >
              Reload
            </Button>
          )}
        </div>
      ) : null}
      {error === null ? null : (
        <ProblemBanner
          error={error}
          title="The group was not saved"
          isApiError={isApiError}
          onDismiss={() => setError(null)}
        />
      )}
      <div className="services-form">
        {group === undefined ? (
          <Field
            label="Id"
            hint="Letters, digits, _, . and -; made up from the name when empty."
          >
            <TextInput
              data-testid="group-id"
              value={id}
              onChange={setId}
            />
          </Field>
        ) : null}
        <Field
          label="Name"
          required
        >
          <TextInput
            data-testid="group-name"
            value={name}
            onChange={setName}
          />
        </Field>
        <Field
          label="Parent"
          hint="The group it nests under: its policy inherits that group's."
        >
          <Select
            data-testid="group-parent"
            options={[
              { value: "", label: "(none: under global)" },
              ...groups
                .filter((g) => !excluded.has(g.id))
                .map((g) => ({ value: g.id, label: `${g.name} (${g.id})` })),
            ]}
            value={parent}
            onChange={setParent}
          />
        </Field>
        <Field
          label="Labels"
          hint="A JSON object of strings."
          {...(parsed === null ? { error: "must be a JSON object" } : {})}
        >
          <JsonEditor
            value={labels}
            rows={4}
            onChange={(state) => setLabels(state.text)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Props of {@link Branch}. */
interface BranchProps {
  /** The groups at this level. */
  nodes: readonly GroupDto[];
  /** Every group. */
  groups: readonly GroupDto[];
  /** Every service. */
  services: readonly ServiceDto[];
  /** Opens a group's form. */
  onEdit: (group: GroupDto) => void;
  /** Asks to delete a group. */
  onDelete: (group: GroupDto) => void;
}

/** A group's Edit and Delete, with `groups:write` on its own scope (or one above it). */
function GroupActions({
  group,
  onEdit,
  onDelete,
}: {
  group: GroupDto;
  onEdit: (group: GroupDto) => void;
  onDelete: (group: GroupDto) => void;
}) {
  const canWrite = useCanOn(`group:${group.id}`, "groups:write");
  return canWrite ? (
    <>
      <Button
        size="sm"
        data-testid={`group-edit-${group.id}`}
        onClick={() => onEdit(group)}
      >
        Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid={`group-delete-${group.id}`}
        onClick={() => onDelete(group)}
      >
        Delete
      </Button>
    </>
  ) : null;
}

/** One level of the tree, and the levels under it. */
function Branch({ nodes, groups, services, onEdit, onDelete }: BranchProps) {
  return (
    <ul className="groups-tree">
      {nodes.map((group) => {
        const members = services.filter((s) => s.groups.includes(group.id));
        const children = groups.filter((g) => g.parent === group.id);
        return (
          <li
            key={group.id}
            data-testid={`group-${group.id}`}
          >
            <div className="groups-node">
              <strong>{group.name}</strong>
              <code>{group.id}</code>
              <span className="muted">
                {members.length === 0
                  ? "no service"
                  : members.map((s) => s.name).join(", ")}
              </span>
              <Link
                to={`/policies?${SCOPE_PARAM}=${encodeURIComponent(`group:${group.id}`)}`}
              >
                Policy
              </Link>
              <GroupActions
                group={group}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            </div>
            {children.length === 0 ? null : (
              <Branch
                nodes={children}
                groups={groups}
                services={services}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** See the module's description. */
export function GroupsScreen() {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const can = useGlobalCanFn();
  const canWrite = can("groups:write");
  const groups = useAllGroups();
  const services = useAllServices(can("services:read"));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<GroupDto | null>(null);
  const [conflict, setConflict] = useState(false);
  if (groups.isPending) return <Spinner label="Loading the groups" />;
  if (groups.isError)
    return (
      <div className="screen">
        <ErrorView
          error={groups.error}
          title="The groups could not be read"
          onRetry={() => void groups.refetch()}
        />
      </div>
    );
  const all = groups.data;
  const known = new Set(all.map((g) => g.id));
  // A group whose parent is not readable still shows, at the top.
  const roots = all.filter((g) => g.parent === null || !known.has(g.parent));
  return (
    <div
      className="screen"
      data-testid="groups"
    >
      <div className="screen-header">
        <h1>Groups</h1>
        <div className="screen-actions">
          {canWrite ? (
            <Button
              size="sm"
              data-testid="new-group"
              onClick={() => setEditing({ kind: "new" })}
            >
              New group
            </Button>
          ) : null}
        </div>
      </div>
      <ServicesNav current="groups" />
      {conflict ? (
        <div
          className="notice"
          role="alert"
          data-testid="groups-conflict"
        >
          <p>
            Someone changed that group since you read it: it was not deleted.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setConflict(false);
              void groups.refetch();
            }}
          >
            Reload
          </Button>
        </div>
      ) : null}
      {all.length === 0 ? (
        <p data-testid="groups-empty">No group yet.</p>
      ) : (
        <Branch
          nodes={roots}
          groups={all}
          services={services.data ?? []}
          onEdit={(group) => setEditing({ kind: "edit", group })}
          onDelete={setDeleting}
        />
      )}
      {editing === null ? null : (
        <GroupDialog
          editing={editing}
          groups={all}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete group ${deleting?.name ?? ""}?`}
        description="Its policy and versions go with it. A group that still holds services or groups is refused."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        variant="danger"
        isApiError={isApiError}
        onConfirm={async () => {
          const group = deleting!;
          try {
            await withStepUp(() =>
              dataOf(
                client.delete("/groups/:id", {
                  params: { id: group.id },
                  query: { revision: group.revision },
                }),
              ),
            );
          } catch (caught) {
            if (isConflict(caught)) {
              setDeleting(null);
              setConflict(true);
              return;
            }
            throw caught;
          }
          await queryClient.invalidateQueries({ queryKey: servicesKeys.all() });
          setDeleting(null);
          toast.success("Group deleted");
        }}
      />
    </div>
  );
}
