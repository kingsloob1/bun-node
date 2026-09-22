import type { ComponentType, LazyExoticComponent } from "react";
import type { AddedByStateGroupProps } from "./overview/added";
import type { SectionProps } from "./overview/sections";
import type { JobDefaultsPanelProps } from "./queues/panels/jobDefaults";
import { lazy, Suspense } from "react";
import { Spinner } from "../components/Spinner";

/**
 * The screens loaded on demand. Each section's code (and its stylesheet) is a
 * separate chunk the bundler splits off, so the first page load carries only
 * the shell and the Overview; opening a queue, a job or a runner fetches its
 * chunk once. The chunks are served from `assetsPath` like the entry, which
 * the CSP's `script-src 'self'` allows.
 */

/**
 * Wraps a lazily imported screen in a Suspense boundary with a labelled
 * spinner. A chunk that fails to load (a network blip, a redeploy) throws to
 * the route's `ScreenErrorBoundary`; `React.lazy` would keep that rejection
 * for good, so a failed load swaps in a fresh `lazy()` and "Reload this
 * screen" really fetches the chunk again.
 */
export function onDemand<TProps extends object = Record<string, never>>(
  load: () => Promise<ComponentType<TProps>>,
  label: string,
): ComponentType<TProps> {
  let Screen: LazyExoticComponent<ComponentType<TProps>>;
  const create = () =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch (error) {
        Screen = create();
        throw error;
      }
    });
  Screen = create();
  function OnDemand(props: TProps) {
    return (
      <Suspense
        fallback={
          <Spinner
            label={label}
            showLabel
          />
        }
      >
        <Screen {...props} />
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

/** `/docs`, on demand. */
export const DocsHomeScreen = onDemand(
  async () => (await import("./docs")).DocsHomeScreen,
  "Loading the API docs",
);

/** `/docs/http[/:operationId]`, on demand. */
export const HttpDocsScreen = onDemand(
  async () => (await import("./docs")).HttpDocsScreen,
  "Loading the HTTP reference",
);

/** `/docs/ws[/:item]`, on demand. */
export const WsDocsScreen = onDemand(
  async () => (await import("./docs")).WsDocsScreen,
  "Loading the WebSocket reference",
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

/** `/workers`, on demand. */
export const WorkersListScreen = onDemand(
  async () => (await import("./workers")).WorkersListScreen,
  "Loading the workers",
);

/** `/workers/:queue/:key`, on demand. */
export const WorkerScreen = onDemand(
  async () => (await import("./workers")).WorkerScreen,
  "Loading the worker",
);

/**
 * The Overview's Runners analytics section, on demand.
 *
 * It is split off the entry deliberately: the Overview is the landing screen,
 * so everything it imports is paid for on every first load, and a deployment
 * recording no analytics (`meta.analytics === null`, which is every one until
 * the recording lands) never renders this section and so never fetches it.
 * `useAnalyticsGate` in `./overview/gate` decides, and stays in the entry.
 */
export const RunnersSection = onDemand<SectionProps>(
  async () => (await import("./overview/sections")).RunnersSection,
  "Loading runner analytics",
);

/** The Overview's Workers analytics section, on demand; see {@link RunnersSection}. */
export const WorkersSection = onDemand<SectionProps>(
  async () => (await import("./overview/sections")).WorkersSection,
  "Loading worker analytics",
);

/**
 * The Overview's "added in range, by state" group, on demand. Split off the
 * entry, which is nearly at its budget, and fetched only where
 * `features.addedByState` is true — a deployment without it never loads it.
 */
export const AddedByStateGroup = onDemand<AddedByStateGroupProps>(
  async () => (await import("./overview/added")).AddedByStateGroup,
  "Loading jobs added in the range",
);

/**
 * The queue screen's Job defaults panel (with its editor and apply dialogs),
 * on demand: a chunk of its own, fetched only when the panel is opened on a
 * queue whose API serves job defaults, so the queue screen's chunk does not
 * grow by it.
 */
export const JobDefaultsPanel = onDemand<JobDefaultsPanelProps>(
  async () => (await import("./queues/panels/jobDefaults")).JobDefaultsPanel,
  "Loading the job defaults",
);
