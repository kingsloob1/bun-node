import { useCan, useMeta } from "../../meta/hooks";

/**
 * Whether an Overview analytics section may read at all: the caller may read
 * metrics, the backend serves analytics, and it records this kind.
 *
 * It lives apart from the sections themselves because the sections are loaded
 * on demand: the gate decides whether to render them, and so whether their
 * chunk is fetched at all. A deployment recording nothing therefore downloads
 * none of that code.
 *
 * Three things must hold, and each says something different:
 * `features.runnerMetrics` / `features.workerMetrics` — this API **serves**
 * that kind: the driver can store it **and** the API's mode mounts its
 * routes, so a flag and its route cannot disagree; `meta.analytics` — the
 * backend serves analytics (it is `null` when it cannot, and no route answers
 * 501); and `recording[kind]` — that kind is switched on, since recording is
 * what costs and a deployment may turn it off.
 *
 * Flags are not permissions: `readOnly` and the `actions` allow-list do not
 * turn them off, so `metrics.read` is still checked here. No new permission
 * action exists for analytics.
 */
export function useAnalyticsGate(kind: "runners" | "workers"): boolean {
  const meta = useMeta();
  const canMetrics = useCan("metrics.read");
  const analytics = meta.analytics ?? null;
  const supported =
    kind === "runners"
      ? meta.features.runnerMetrics
      : meta.features.workerMetrics;
  return (
    canMetrics && supported && analytics !== null && analytics.recording[kind]
  );
}
