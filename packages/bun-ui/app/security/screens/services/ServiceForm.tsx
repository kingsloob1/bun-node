/**
 * `/services/new` and `/services/:id` (ui.md §3): a service's record — its
 * name, groups (which scopes it inherits from, outermost first by the
 * groups' nesting), environment, hosts, topology, labels and whether
 * publishing it asks for a step-up. Saved at the revision read: someone
 * else's change since is a `409`, shown with a reload; a group that does
 * not exist, or a policy that no longer compiles under the new groups, is a
 * `422` with its issues. **Delete** behind a confirmation. Read-only
 * without `services:write` on the service's own scope (a binding on a
 * group above covers it); creating one needs it on global.
 */
import type { ServiceDto } from "./queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { ConfirmDialog } from "../../../kit/components/ConfirmDialog";
import { Field } from "../../../kit/components/Field";
import { Checkbox, Select, TextInput } from "../../../kit/components/inputs";
import { JsonEditor } from "../../../kit/components/JsonEditor";
import { ProblemBanner } from "../../../kit/components/ProblemBanner";
import { Spinner } from "../../../kit/components/Spinner";
import { useToast } from "../../../kit/components/toast";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { ErrorView } from "../../components/ErrorView";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { useNavigate, useParams } from "../../routing";
import { SCOPE_PARAM } from "../../scope/scope";
import { withStepUp } from "../../stepUp";
import { isConflict } from "../lists/policy";
import { servicesKeys, useAllGroups, useCanOn } from "./queries";
import { ServicesNav } from "./ServicesNav";
import "./services.css";

/** The form's fields. */
interface Draft {
  /** The id (a new service's only). */
  id: string;
  /** The name. */
  name: string;
  /** The groups. */
  groups: string[];
  /** The environment. */
  environment: string;
  /** The hosts, one per line. */
  hosts: string;
  /** The topology. */
  topology: "a" | "b" | "c";
  /** The labels, as JSON. */
  labels: string;
  /** Whether publishing asks for a step-up. */
  requireStepUp: boolean;
}

/** A form's fields from a service (or empty). */
function draftOf(service: ServiceDto | undefined): Draft {
  return {
    id: service?.id ?? "",
    name: service?.name ?? "",
    groups: [...(service?.groups ?? [])],
    environment: service?.environment ?? "",
    hosts: (service?.hosts ?? []).join("\n"),
    topology: service?.topology ?? "a",
    labels: JSON.stringify(service?.labels ?? {}, null, 2),
    requireStepUp: service?.requireStepUp ?? false,
  };
}

/** See the module's description. */
export function ServiceForm() {
  const { id } = useParams<{ id?: string }>();
  const creating = id === undefined || id === "new";
  const { client } = useSecurityClient();
  const service = useQuery({
    queryKey: servicesKeys.service(id ?? ""),
    enabled: !creating,
    queryFn: ({ signal }) =>
      dataOf(client.get("/services/:id", { params: { id: id! }, signal })),
  });
  if (!creating && service.isPending)
    return <Spinner label="Loading the service" />;
  if (!creating && service.isError)
    return (
      <div className="screen">
        <ErrorView
          error={service.error}
          title="The service could not be read"
          onRetry={() => void service.refetch()}
        />
      </div>
    );
  return (
    <ServiceFormView
      // A reload after a conflict starts the form again.
      key={`${id ?? "new"}:${service.data?.revision ?? 0}`}
      service={creating ? undefined : service.data}
      onReload={() => void service.refetch()}
    />
  );
}

/** The form over a read service (or a new one). */
function ServiceFormView({
  service,
  onReload,
}: {
  service: ServiceDto | undefined;
  onReload: () => void;
}) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const groups = useAllGroups();
  // A new service needs the right on global; an existing one, on its own scope.
  const canWrite = useCanOn(
    service === undefined ? "global" : `service:${service.id}`,
    "services:write",
  );
  const [draft, setDraft] = useState<Draft>(() => draftOf(service));
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  let labels: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(draft.labels) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      labels = parsed as Record<string, string>;
  } catch {
    labels = null;
  }
  const set = (patch: Partial<Draft>) =>
    setDraft((old) => ({ ...old, ...patch }));
  const save = async () => {
    if (labels === null) return;
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name,
      groups: draft.groups,
      environment: draft.environment,
      hosts: draft.hosts
        .split("\n")
        .map((host) => host.trim())
        .filter((host) => host !== ""),
      topology: draft.topology,
      labels,
      requireStepUp: draft.requireStepUp,
    };
    try {
      const saved = await withStepUp(() =>
        service === undefined
          ? dataOf(
              client.post("/services", {
                body: { ...body, ...(draft.id === "" ? {} : { id: draft.id }) },
              }),
            )
          : dataOf(
              client.put("/services/:id", {
                params: { id: service.id },
                body: { ...body, revision: service.revision },
              }),
            ),
      );
      await queryClient.invalidateQueries({ queryKey: servicesKeys.all() });
      toast.success(
        service === undefined ? "Service created" : "Service saved",
      );
      if (service === undefined)
        navigate(`/services/${encodeURIComponent(saved.id)}`);
    } catch (caught) {
      if (isConflict(caught)) setConflict(true);
      else setError(caught);
    } finally {
      setSaving(false);
    }
  };
  const allGroups = groups.data ?? [];
  return (
    <div
      className="screen"
      data-testid="service-form"
    >
      <div className="screen-header">
        <h1>
          {service === undefined ? "New service" : `Service ${service.name}`}
        </h1>
        {service === undefined ? null : (
          <div className="screen-actions">
            <Link
              to={`/policies?${SCOPE_PARAM}=${encodeURIComponent(`service:${service.id}`)}`}
            >
              Its policy
            </Link>
          </div>
        )}
      </div>
      <ServicesNav current="services" />
      {conflict ? (
        <div
          className="notice"
          role="alert"
          data-testid="service-conflict"
        >
          <p>
            {service === undefined
              ? "A service with this id exists already."
              : "Someone changed this service since you read it: your changes were not saved."}
          </p>
          {service === undefined ? null : (
            <Button
              size="sm"
              onClick={onReload}
            >
              Reload
            </Button>
          )}
        </div>
      ) : null}
      {error === null ? null : (
        <ProblemBanner
          error={error}
          title="The service was not saved"
          isApiError={isApiError}
          onDismiss={() => setError(null)}
        />
      )}
      <form
        className="services-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {service === undefined ? (
          <Field
            label="Id"
            hint="Letters, digits, _, . and -; made up from the name when empty."
          >
            <TextInput
              data-testid="service-id"
              disabled={!canWrite}
              value={draft.id}
              onChange={(value) => set({ id: value })}
            />
          </Field>
        ) : null}
        <Field
          label="Name"
          required
        >
          <TextInput
            data-testid="service-name"
            disabled={!canWrite}
            value={draft.name}
            onChange={(value) => set({ name: value })}
          />
        </Field>
        <fieldset data-testid="service-groups">
          <legend>Groups</legend>
          {allGroups.length === 0 ? (
            <p className="muted">No group yet.</p>
          ) : (
            allGroups.map((group) => (
              <Checkbox
                key={group.id}
                label={`${group.name} (${group.id})`}
                disabled={!canWrite}
                checked={draft.groups.includes(group.id)}
                onChange={(checked) =>
                  set({
                    groups: checked
                      ? [...draft.groups, group.id]
                      : draft.groups.filter((g) => g !== group.id),
                  })
                }
              />
            ))
          )}
        </fieldset>
        <Field label="Environment">
          <TextInput
            data-testid="service-environment"
            disabled={!canWrite}
            value={draft.environment}
            onChange={(value) => set({ environment: value })}
          />
        </Field>
        <Field
          label="Hosts"
          hint="One per line."
        >
          {(control) => (
            <textarea
              {...control}
              className="input"
              rows={3}
              data-testid="service-hosts"
              disabled={!canWrite}
              value={draft.hosts}
              onChange={(event) => set({ hosts: event.target.value })}
            />
          )}
        </Field>
        <Field
          label="Topology"
          hint="a: one process; b: several processes, one store; c: several hosts with agents (topologies.md)."
        >
          <Select
            data-testid="service-topology"
            disabled={!canWrite}
            options={[
              { value: "a", label: "a" },
              { value: "b", label: "b" },
              { value: "c", label: "c" },
            ]}
            value={draft.topology}
            onChange={(value) => set({ topology: value })}
          />
        </Field>
        <Field
          label="Labels"
          hint="A JSON object of strings."
          {...(labels === null ? { error: "must be a JSON object" } : {})}
        >
          <JsonEditor
            value={draft.labels}
            rows={4}
            readOnly={!canWrite}
            onChange={(state) => set({ labels: state.text })}
          />
        </Field>
        <Checkbox
          label="Publishing asks for a step-up"
          disabled={!canWrite}
          checked={draft.requireStepUp}
          onChange={(checked) => set({ requireStepUp: checked })}
        />
        {canWrite ? (
          <div className="screen-actions">
            <Button
              type="submit"
              variant="primary"
              data-testid="service-save"
              disabled={saving || draft.name.trim() === "" || labels === null}
            >
              {saving ? "Saving…" : service === undefined ? "Create" : "Save"}
            </Button>
            {service === undefined ? null : (
              <Button
                variant="danger"
                data-testid="service-delete"
                onClick={() => setDeleting(true)}
              >
                Delete…
              </Button>
            )}
          </div>
        ) : null}
      </form>
      {service === undefined ? null : (
        <ConfirmDialog
          open={deleting}
          onClose={() => setDeleting(false)}
          title={`Delete service ${service.name}?`}
          description="Its policy, versions and agents stop applying; its record is gone."
          confirmLabel="Delete"
          pendingLabel="Deleting…"
          variant="danger"
          confirmText={service.id}
          confirmTextLabel={
            <>
              Type <code>{service.id}</code> to delete it
            </>
          }
          isApiError={isApiError}
          onConfirm={async () => {
            try {
              await withStepUp(() =>
                dataOf(
                  client.delete("/services/:id", {
                    params: { id: service.id },
                    query: { revision: service.revision },
                  }),
                ),
              );
            } catch (caught) {
              if (isConflict(caught)) {
                setDeleting(false);
                setConflict(true);
                return;
              }
              throw caught;
            }
            await queryClient.invalidateQueries({
              queryKey: servicesKeys.all(),
            });
            toast.success("Service deleted");
            navigate("/services");
          }}
        />
      )}
    </div>
  );
}
