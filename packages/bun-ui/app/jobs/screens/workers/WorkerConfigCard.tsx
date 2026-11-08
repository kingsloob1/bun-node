import type { WorkerConfigKey } from "../../api/contract";
import type { WorkerConfigOverrideDto, WorkerDto } from "../../api/types";
import { useState } from "react";
import { WORKER_CONFIG_KEYS } from "../../api/contract";
import { resetWorkerConfig, workerInvalidations } from "../../api/workers";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { KeyValue } from "../../components/KeyValue";
import { RelativeTime } from "../../components/RelativeTime";
import { Table } from "../../components/Table";
import { useApiClient } from "../../context";
import { formatNumber } from "../../format";
import { useApiMutation } from "../../hooks/useApiMutation";
import { useCanControlWorkers, workerActionGates } from "./actions/gating";
import { SETTING_HINT } from "./actions/settingHints";
import { WorkerConfigDialog } from "./actions/WorkerConfigDialog";

/**
 * The settings that are counts; every other worker setting is in
 * milliseconds (as `WORKER_CONFIG_BOUNDS` documents).
 */
const COUNT_SETTINGS: ReadonlySet<WorkerConfigKey> = new Set([
  "concurrency",
  "maxStalledCount",
]);

/** A setting's value with its unit. */
function formatSetting(setting: WorkerConfigKey, value: number): string {
  return COUNT_SETTINGS.has(setting)
    ? formatNumber(value)
    : `${formatNumber(value)} ms`;
}

/** Whether two instances run with the same effective values. */
function sameEffective(a: WorkerDto, b: WorkerDto): boolean {
  return WORKER_CONFIG_KEYS.every(
    (setting) => a.config?.effective[setting] === b.config?.effective[setting],
  );
}

/** Props of {@link WorkerConfigCard}. */
export interface WorkerConfigCardProps {
  /** The queue the key's workers consume: where the override is stored. */
  queue: string;
  /** The stable key the override is stored against. */
  workerKey: string;
  /** The key's live instances, oldest first (`GET /workers?key=&queue=`). */
  instances: readonly WorkerDto[];
  /**
   * The override stored for the key when no instance is live (the listing's
   * `offline`, read with `includeOffline`): `null` when the listing says none
   * is stored — no entry for the key, or one with no values, which is what a
   * reset leaves behind — and `undefined` when it cannot tell (an API that
   * sent no `offline`).
   */
  stored: WorkerConfigOverrideDto | null | undefined;
}

/**
 * A worker key's full configuration: every setting with the value it runs
 * with, the value its code asked for, and whether an override replaces it.
 *
 * The override is stored against the key, so every instance shares it; the
 * values are read from the first instance that reports a `config`, and a note
 * says when another instance runs with different ones (a change still being
 * taken up, or replicas whose code differs). Editing opens the same Settings
 * dialog a worker row's Settings… opens.
 *
 * With no live instance there are no effective or code values to show — only
 * a running worker reports them — but the override lives on, so a caller
 * holding `workers.configure` can still reset it.
 */
export function WorkerConfigCard({
  queue,
  workerKey,
  instances,
  stored,
}: WorkerConfigCardProps) {
  const canMutate = useCanControlWorkers();
  const [editing, setEditing] = useState(false);
  const source = instances.find((worker) => worker.config !== undefined);

  if (instances.length === 0) {
    return (
      <Card title="Configuration">
        <NoInstanceConfig
          queue={queue}
          workerKey={workerKey}
          stored={stored}
          canReset={canMutate("workers.configure")}
        />
      </Card>
    );
  }

  const config = source?.config;
  const pending = instances.some((worker) => worker.control?.pending === true);
  const canEdit =
    source !== undefined && workerActionGates(source, canMutate).configure;
  const differs =
    source !== undefined &&
    instances.some(
      (worker) => worker.config !== undefined && !sameEffective(worker, source),
    );

  return (
    <Card
      title="Configuration"
      actions={
        <>
          {pending && (
            <Badge
              tone="accent"
              title="A change was recorded and an instance has not taken it up yet. It applies within seconds."
            >
              Change pending
            </Badge>
          )}
          {canEdit && (
            <Button
              size="sm"
              onClick={() => setEditing(true)}
            >
              Edit settings…
            </Button>
          )}
        </>
      }
    >
      <div data-testid="worker-config">
        {config === undefined ? (
          <p className="muted">
            No instance of this key reports its settings (it predates remote
            configuration, or the backend keeps no config), so there is nothing
            to show.
          </p>
        ) : (
          <>
            <p
              className="muted worker-config-summary"
              data-testid="worker-config-summary"
            >
              {config.overridden.length === 0 ? (
                "No override is stored: every value is what the code asks for."
              ) : (
                <>
                  An override (version {config.seq}
                  {config.updatedAt !== undefined && (
                    <>
                      , written <RelativeTime value={config.updatedAt} />
                    </>
                  )}
                  ) replaces {config.overridden.length} of the{" "}
                  {WORKER_CONFIG_KEYS.length} settings, for every instance of
                  this key.
                </>
              )}
            </p>
            {differs && (
              <p
                className="notice"
                role="note"
                data-testid="worker-config-differs"
              >
                Not every instance runs with these values (they are{" "}
                <code>{source.id}</code>’s): a change is still being taken up,
                or the instances’ code differs. Each instance’s Settings… shows
                its own.
              </p>
            )}
            <Table label={`Settings of ${workerKey}`}>
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Running with
                  </th>
                  <th
                    scope="col"
                    className="num"
                  >
                    Code asks for
                  </th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {WORKER_CONFIG_KEYS.map((setting) => {
                  const overridden = config.overridden.includes(setting);
                  const derived = config.derived?.includes(setting) === true;
                  return (
                    <tr
                      key={setting}
                      data-testid={`worker-setting-${setting}`}
                    >
                      <th
                        scope="row"
                        title={SETTING_HINT[setting]}
                      >
                        <code>{setting}</code>
                      </th>
                      <td className="num">
                        {formatSetting(setting, config.effective[setting])}
                      </td>
                      <td className="num">
                        {formatSetting(setting, config.code[setting])}
                        {derived && (
                          <span
                            className="muted"
                            title="Derived rather than given: a third of lockDuration."
                          >
                            {" "}
                            (derived)
                          </span>
                        )}
                      </td>
                      <td>
                        {overridden ? (
                          <Badge
                            tone="accent"
                            title="Replaced by the override stored for this key."
                          >
                            Overridden
                          </Badge>
                        ) : (
                          <span className="muted">Code</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </>
        )}
      </div>
      {editing && source !== undefined && (
        <WorkerConfigDialog
          worker={source}
          onClose={() => setEditing(false)}
        />
      )}
    </Card>
  );
}

/** Props of {@link NoInstanceConfig}. */
interface NoInstanceConfigProps {
  /** The queue the override is stored on. */
  queue: string;
  /** The stable key it is stored against. */
  workerKey: string;
  /** The stored override, `null` when none is, `undefined` when unknown. */
  stored: WorkerConfigOverrideDto | null | undefined;
  /** Whether the caller may reset it (mutation `workers.configure`, with worker control supported). */
  canReset: boolean;
}

/** The configuration of a key no instance of which is live: what is stored, and Reset. */
function NoInstanceConfig({
  queue,
  workerKey,
  stored,
  canReset,
}: NoInstanceConfigProps) {
  const api = useApiClient();
  const [confirming, setConfirming] = useState(false);
  const reset = useApiMutation({
    mutationFn: () => resetWorkerConfig(api, queue, workerKey),
    invalidate: workerInvalidations(queue),
    successMessage: `Reset ${workerKey} to the values in its code`,
    toastErrors: false,
  });
  const values = stored
    ? WORKER_CONFIG_KEYS.flatMap((setting) => {
        const value = stored.values[setting];
        return value === undefined ? [] : [{ setting, value }];
      })
    : [];
  // Nothing to reset when the listing says nothing is stored.
  const offerReset = canReset && stored !== null;

  return (
    <div data-testid="worker-config-offline">
      <p className="muted">
        No instance of this key is live, so its configuration cannot be shown
        until one reports: the values a worker runs with and the ones its code
        asks for come from the running worker.
      </p>
      {stored === null ? (
        <p data-testid="worker-config-none-stored">
          No override is stored for this key.
        </p>
      ) : stored !== undefined ? (
        <>
          <p data-testid="worker-config-stored">
            An override is stored for this key (version {stored.seq}, written{" "}
            <RelativeTime value={stored.updatedAt} />
            ). The next instance to start takes it up.
          </p>
          {values.length > 0 && (
            <KeyValue
              items={values.map(({ setting, value }) => ({
                key: setting,
                label: <code>{setting}</code>,
                value: formatSetting(setting, value),
              }))}
            />
          )}
        </>
      ) : null}
      {offerReset && (
        <Button
          size="sm"
          variant="danger"
          onClick={() => setConfirming(true)}
        >
          Reset to code values…
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Reset ${workerKey}?`}
        description="Drops the override stored for this key, so every instance started from now on runs with what its code asks for."
        confirmLabel="Reset"
        pendingLabel="Resetting…"
        variant="danger"
        onConfirm={() => reset.mutateAsync()}
      />
    </div>
  );
}
