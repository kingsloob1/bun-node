import type { ComponentType } from "react";
import { lazy, Suspense } from "react";
import { Spinner } from "../components/Spinner";

/**
 * The screens loaded on demand. Each section's code (and its stylesheet) is a
 * separate chunk the bundler splits off, so the first page load carries only
 * the shell and the Overview; opening a queue, a job or a runner fetches its
 * chunk once. The chunks are served from `assetsPath` like the entry, which
 * the CSP's `script-src 'self'` allows.
 */

/** Wraps a lazily imported screen in a Suspense boundary with a labelled spinner. */
function onDemand(
  load: () => Promise<ComponentType>,
  label: string,
): ComponentType {
  const Screen = lazy(async () => ({ default: await load() }));
  function OnDemand() {
    return (
      <Suspense
        fallback={
          <Spinner
            label={label}
            showLabel
          />
        }
      >
        <Screen />
      </Suspense>
    );
  }
  return OnDemand;
}

/** `/queues`, on demand. */
export const QueuesListScreen = onDemand(
  async () => (await import("./queues")).QueuesListScreen,
  "Loading the queues",
);

/** `/queues/:queue`, on demand. */
export const QueueScreen = onDemand(
  async () => (await import("./queues")).QueueScreen,
  "Loading the queue",
);

/** `/queues/:queue/jobs/:id`, on demand. */
export const JobScreen = onDemand(
  async () => (await import("./job")).JobScreen,
  "Loading the job",
);

/** `/events`, on demand. */
export const EventsScreen = onDemand(
  async () => (await import("./events")).EventsScreen,
  "Loading the events",
);

/** `/runners`, on demand. */
export const RunnersListScreen = onDemand(
  async () => (await import("./runners")).RunnersListScreen,
  "Loading the runners",
);

/** `/runners/:runner`, on demand. */
export const RunnerScreen = onDemand(
  async () => (await import("./runners")).RunnerScreen,
  "Loading the runner",
);
