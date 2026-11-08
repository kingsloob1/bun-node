import { useQuery } from "@tanstack/react-query";
import { getRunner, runnerKeys } from "../../../../app/api/runners";
import { useApiClient } from "../../../../app/context";
import { RunnerActions } from "../../../../app/screens/runners/actions";

/** Props of {@link RunnerHarness}. */
export interface RunnerHarnessProps {
  /** The runner id to load. */
  runner: string;
}

/** Loads the runner (refetched after each write, as the runner screen does) and renders its actions. */
export function RunnerHarness({ runner }: RunnerHarnessProps) {
  const api = useApiClient();
  const query = useQuery({
    queryKey: runnerKeys.detail(runner),
    queryFn: ({ signal }) => getRunner(api, runner, signal),
  });
  return query.data ? (
    <div data-testid="runner-actions-host">
      <RunnerActions runner={query.data} />
    </div>
  ) : null;
}
