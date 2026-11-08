import type { ProviderDto } from "../../api/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  getProviderSchema,
  listProviders,
  providerKeys,
} from "../../api/providers";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { ErrorView } from "../../components/ErrorView";
import { JsonView } from "../../components/JsonView";
import { KeyValue } from "../../components/KeyValue";
import { ProblemBanner } from "../../components/ProblemBanner";
import { Spinner } from "../../components/Spinner";
import { useApiClient } from "../../context";
import { displayText } from "../../format";
import { usePollInterval } from "../../live";
import { useCan } from "../../meta/hooks";
import { POLL_INTERVAL_MS } from "../../queryClient";
import { useCanMutate } from "../queues/gating";
import { providerReadiness } from "./providerText";
import { TestConnection } from "./TestConnection";
import "./providers.css";

/** How often the list is re-read: a provider's readiness changes as its config validates. */
const REFRESH_MS = POLL_INTERVAL_MS * 2;

/**
 * `/providers`: the compute providers configured in the API's process
 * (`GET /providers`), each with its readiness, its secret-free facts, "Test
 * connection" where it has a preflight, and its config schema where it
 * publishes one.
 *
 * Routed only where the caller may read providers (`providers.read`, opt-in)
 * and the API serves them (`features.providers`, off in `runner` mode); the
 * nav entry follows the same rule.
 */
export function ProvidersScreen() {
  const api = useApiClient();
  const canRead = useCan("providers.read");
  const canMutate = useCanMutate();
  const canValidate = canMutate("providers.validate");
  const refetchInterval = usePollInterval(REFRESH_MS);
  const list = useQuery({
    queryKey: providerKeys.list,
    queryFn: ({ signal }) => listProviders(api, signal),
    refetchInterval,
    enabled: canRead,
  });
  return (
    <div
      className="screen"
      data-testid="providers-screen"
    >
      <h1 className="screen-title">Providers</h1>
      {!canRead ? (
        <EmptyState
          title="Nothing to show"
          description="You may not read providers on this API."
        />
      ) : list.isPending ? (
        <Spinner
          label="Loading providers"
          showLabel
        />
      ) : list.isError ? (
        <ErrorView
          error={list.error}
          title="Could not load providers"
          onRetry={() => void list.refetch()}
        />
      ) : list.data.providers.length === 0 ? (
        <EmptyState
          title="No providers configured"
          description="Compute providers appear here once the API's process configures one, e.g. for a queue's summoning."
        />
      ) : (
        <>
          <p
            className="muted"
            data-testid="providers-api"
          >
            Provider API {displayText(list.data.api.core)}, summon facet{" "}
            {displayText(list.data.api.summon)}. Ids are stable for this
            process's life only.
          </p>
          <div className="providers-list">
            {list.data.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                canValidate={canValidate}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Props of {@link ProviderCard}. */
interface ProviderCardProps {
  /** The provider. */
  provider: ProviderDto;
  /** Whether the caller may run "Test connection" (`providers.validate`, not read-only). */
  canValidate: boolean;
}

/** One provider: who it is, its readiness and facts, and what can be done with it. */
function ProviderCard({ provider, canValidate }: ProviderCardProps) {
  const readiness = providerReadiness(provider.readiness);
  const name = displayText(
    provider.provider.displayName ?? provider.provider.kind,
  );
  const facts = Object.entries(provider.facts);
  return (
    <Card title={name}>
      <div data-testid={`provider-${provider.id}`}>
        <KeyValue
          items={[
            {
              key: "readiness",
              label: "Readiness",
              value: (
                <Badge
                  tone={readiness.tone}
                  title={readiness.hint}
                  testId="provider-readiness"
                >
                  {readiness.label}
                </Badge>
              ),
              hint: readiness.hint,
            },
            {
              key: "id",
              label: "Id",
              value: <code>{displayText(provider.id)}</code>,
            },
            {
              key: "package",
              label: "Package",
              value: (
                <span>
                  <code>{displayText(provider.provider.name)}</code>{" "}
                  {displayText(provider.provider.version)}
                </span>
              ),
            },
            ...facts.map(([key, value]) => ({
              key: `fact-${key}`,
              label: displayText(key),
              value: <code>{displayText(value)}</code>,
            })),
          ]}
        />
        {canValidate && provider.preflight && (
          <TestConnection
            providerId={provider.id}
            label={name}
          />
        )}
        {provider.configSchema && <ConfigSchema providerId={provider.id} />}
      </div>
    </Card>
  );
}

/**
 * A provider's config schema, read only when asked for: secret-free JSON
 * Schema, shown as it is (there is no route that sets a provider's config).
 */
function ConfigSchema({ providerId }: { providerId: string }) {
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const schema = useQuery({
    queryKey: providerKeys.schema(providerId),
    queryFn: ({ signal }) => getProviderSchema(api, providerId, signal),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <div className="provider-schema">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide config schema" : "Config schema"}
      </Button>
      {open &&
        (schema.isPending ? (
          <Spinner label="Loading the config schema" />
        ) : schema.isError ? (
          <ProblemBanner
            error={schema.error}
            title="Could not load the config schema"
          />
        ) : (
          <div data-testid="provider-schema">
            <JsonView
              value={schema.data.schema}
              label={`Config schema of ${providerId}`}
              // Opened to read it: show properties and their constraints.
              expandDepth={4}
            />
          </div>
        ))}
    </div>
  );
}
