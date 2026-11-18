/**
 * A new agent's key (ui.md §8, `POST /agents`, a step-up): for a service
 * (the scope's when the scope is one), with an optional id and name; the
 * answer's secret is shown once, with what to configure the agent with.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../../kit/components/Button";
import { dataOf } from "../../api/client";
import { isApiError } from "../../api/errors";
import { SecretOnce } from "../../components/SecretOnce";
import { useSecurityClient } from "../../context";
import { Link } from "../../router";
import { withStepUp } from "../../stepUp";

/** Props of {@link AgentNew}. */
export interface AgentNewProps {
  /** The scope on screen: a service's pre-fills the form. */
  scope: string;
}

/** An agent id: letters, digits, `_` and `-`, 1 to 64. */
const AGENT_ID = /^[\w-]{1,64}$/;

/** See the module's description. */
export function AgentNew({ scope }: AgentNewProps) {
  const { client } = useSecurityClient();
  const queryClient = useQueryClient();
  const [service, setService] = useState(
    scope.startsWith("service:") ? scope.slice("service:".length) : "",
  );
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; secret: string } | null>(null);
  const services = useQuery({
    queryKey: ["agents", "services"],
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      dataOf(client.get("/services", { query: { limit: 200 }, signal })),
  });
  const scopeQuery = `scope=${encodeURIComponent(scope)}`;
  const submit = async () => {
    setError(null);
    if (service.trim() === "") {
      setError("Choose the service the agent serves.");
      return;
    }
    if (id !== "" && !AGENT_ID.test(id)) {
      setError("An id is 1 to 64 letters, digits, _ and -.");
      return;
    }
    setBusy(true);
    try {
      const answer = await withStepUp(() =>
        dataOf(
          client.post("/agents", {
            body: {
              service: service.trim(),
              ...(id === "" ? {} : { id }),
              ...(name.trim() === "" ? {} : { name: name.trim() }),
            },
          }),
        ),
      );
      setMade({ id: answer.agent.id, secret: answer.secret });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (failure) {
      setError(
        isApiError(failure)
          ? (failure.detail ?? failure.title)
          : "The agent was not made.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="screen"
      data-testid="agent-new"
    >
      <p>
        <Link to={`/agents?${scopeQuery}`}>Agents</Link>
      </p>
      <h1>New agent</h1>
      {made !== null ? (
        <>
          <SecretOnce
            label="The agent's secret"
            secret={made.secret}
            use={`Configure agent "${made.id}" with it (connectAgent's secret)`}
            onDone={() => setMade(null)}
          />
          <p>
            <Link to={`/agents/${encodeURIComponent(made.id)}?${scopeQuery}`}>
              Open agent {made.id}
            </Link>
          </p>
        </>
      ) : (
        <form
          className="filters"
          aria-label="New agent"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Service{" "}
            <input
              placeholder="e.g. checkout"
              className="input"
              list="agent-services"
              value={service}
              required
              data-testid="agent-service"
              onChange={(e) => setService(e.target.value)}
            />
            <datalist id="agent-services">
              {(services.data?.items ?? []).map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                >
                  {item.name}
                </option>
              ))}
            </datalist>
          </label>
          <label>
            Id (optional){" "}
            <input
              placeholder="e.g. checkout-eu-1"
              className="input"
              value={id}
              data-testid="agent-id"
              onChange={(e) => setId(e.target.value)}
            />
          </label>
          <label>
            Name (optional){" "}
            <input
              placeholder="e.g. Checkout, eu-west-1"
              className="input"
              value={name}
              data-testid="agent-name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy}
            data-testid="agent-create"
          >
            {busy ? "Making…" : "Make the key"}
          </Button>
          {error === null ? null : <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
