/**
 * The queue screen's Job defaults panel, its Settings… editor and its Apply
 * to pending jobs… action: a chunk of its own, loaded on demand
 * (`JobDefaultsPanel` in `app/screens/lazy.tsx`) only on a queue whose API
 * serves job defaults (see `../jobDefaultsGate`).
 */
export type { JobDefaultsPanelProps } from "./JobDefaultsPanel";
export { JobDefaultsPanel } from "./JobDefaultsPanel";
