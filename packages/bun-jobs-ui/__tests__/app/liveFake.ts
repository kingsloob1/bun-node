import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  EventName,
  EventWire,
  JobsApiAckRejection,
  JobsApiGapMessage,
  QueueEventName,
  RunnerEventName,
} from "../../app/api/types";
import type * as LiveModule from "../../app/live";
import type { LiveStatus, LiveSubscription } from "../../app/live";
import { useQueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, mock } from "bun:test";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cleanup } from "./dom";

/**
 * A test double for the live module (`app/live`), so screens can be driven
 * by events without a socket.
 *
 * `mock.module` is process-wide in `bun test`: once this file loads, every
 * later test file importing `app/live` gets this module too (and Bun patches
 * `live.ts`'s own exports as well). So the double **passes through** to the
 * real implementation, captured before mocking, unless a test has installed
 * it with {@link installLiveFake}: other files, the live client's own tests
 * included, see the real module unchanged.
 */

/** The real module, captured before it is mocked. */
const real = { ...(await import("../../app/live")) } as typeof LiveModule;

/** How much the fake's `usePollInterval` slows a base interval while live. */
export const LIVE_SLOWDOWN = 12;

/** One mounted `useLiveInvalidation`, as the fake holds it. */
export interface FakeInvalidation {
  /** The channels. */
  channels: readonly string[];
  /** The keys it invalidates. */
  keys: readonly QueryKey[];
  /** Its type filter; `undefined` for all. */
  events: readonly EventName[] | undefined;
  /** Whether it is enabled. */
  enabled: boolean;
  /** The screen's query client. */
  queryClient: QueryClient;
}

/** The fake's state and controls. */
class LiveFake {
  /** Whether a test installed the fake (else everything passes through). */
  installed = false;
  /** What `useLiveStatus` returns. */
  status: LiveStatus = offStatus();
  /** Rejections per channel, returned by `useLiveSubscription`. */
  rejections = new Map<string, JobsApiAckRejection>();
  /** Mounted invalidation hooks. */
  readonly invalidations = new Set<{ current: FakeInvalidation }>();
  /** Mounted subscriptions. */
  readonly subscriptions = new Set<{ current: LiveSubscription }>();
  /** Every `usePollInterval` base asked for while installed. */
  readonly pollBases: (number | false)[] = [];
  /** Store listeners (re-render on status or rejection changes). */
  private readonly listeners = new Set<() => void>();
  /** Store version. */
  private version = 0;

  /** Installs the fake with a status. */
  install(status: Partial<LiveStatus> = {}): void {
    this.installed = true;
    this.status = { ...offStatus(), ...status };
    this.rejections.clear();
    this.pollBases.length = 0;
  }

  /** Back to passing through. */
  uninstall(): void {
    this.installed = false;
    this.invalidations.clear();
    this.subscriptions.clear();
    this.rejections.clear();
  }

  /** Changes the status, re-rendering its readers. */
  setStatus(status: Partial<LiveStatus>): void {
    this.status = { ...this.status, ...status };
    this.notify();
  }

  /** Makes the server "refuse" a channel. */
  reject(rejection: JobsApiAckRejection): void {
    this.rejections.set(rejection.channel, rejection);
    this.notify();
  }

  /** The enabled invalidation hooks. */
  activeInvalidations(): FakeInvalidation[] {
    return [...this.invalidations]
      .map((ref) => ref.current)
      .filter((entry) => entry.enabled);
  }

  /** The enabled subscriptions. */
  activeSubscriptions(): LiveSubscription[] {
    return [...this.subscriptions]
      .map((ref) => ref.current)
      .filter((entry) => entry.enabled !== false);
  }

  /** Every channel something holds. */
  channels(): string[] {
    return [
      ...new Set([
        ...this.activeInvalidations().flatMap((entry) => entry.channels),
        ...this.activeSubscriptions().flatMap((entry) => entry.channels),
      ]),
    ].sort();
  }

  /**
   * Delivers an event as the server would: to every holder of a channel it
   * matches (see {@link eventChannels}) whose filter admits its type.
   * Invalidations run at once (no coalescing).
   */
  emit(event: EventWire): void {
    const matched = new Set(eventChannels(event));
    const admits = (
      channels: readonly string[],
      events: readonly EventName[] | undefined,
    ) =>
      channels.some((channel) => matched.has(channel)) &&
      (events === undefined || events.includes(event.type));
    for (const entry of this.activeInvalidations()) {
      if (admits(entry.channels, entry.events)) {
        for (const queryKey of entry.keys) {
          void entry.queryClient.invalidateQueries({ queryKey });
        }
      }
    }
    for (const entry of this.activeSubscriptions()) {
      if (admits(entry.channels, entry.events)) {
        entry.onEvent?.(event);
      }
    }
  }

  /** Delivers a gap to the holders of its channels (all of them without `channels`). */
  gap(gap: JobsApiGapMessage): void {
    const hit = (channels: readonly string[]) =>
      gap.channels === undefined ||
      channels.some((channel) => gap.channels!.includes(channel));
    for (const entry of this.activeInvalidations()) {
      if (hit(entry.channels)) {
        for (const queryKey of entry.keys) {
          void entry.queryClient.invalidateQueries({ queryKey });
        }
      }
    }
    for (const entry of this.activeSubscriptions()) {
      if (hit(entry.channels)) {
        entry.onGap?.(gap);
      }
    }
  }

  /** Subscribes a store listener. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The store's snapshot. */
  snapshot = (): number => this.version;

  /** Re-renders every reader. */
  private notify(): void {
    this.version++;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** The status of a client with no socket. */
function offStatus(): LiveStatus {
  return {
    state: "off",
    detail: "No socket in tests",
    events: "push",
    publishing: true,
    lastEventAt: null,
  };
}

/** The one fake. */
export const liveFake = new LiveFake();

/**
 * The channels an event reaches, as the server routes it: `all`, its
 * family, its target, and for a queue event the job channel of its `id` and
 * of each of `payload.ids` (stalled, cleaned, retried).
 */
export function eventChannels(event: EventWire): string[] {
  if (event.kind === "runner") {
    return ["all", "runners", real.liveChannels.runner(event.target)];
  }
  const ids = new Set<string>();
  if (event.id !== undefined) {
    ids.add(event.id);
  }
  const payload = event.payload as { ids?: unknown };
  if (Array.isArray(payload.ids)) {
    for (const id of payload.ids) {
      ids.add(String(id));
    }
  }
  return [
    "all",
    "queues",
    real.liveChannels.queue(event.target),
    ...[...ids].map((id) => real.liveChannels.job(event.target, id)),
  ];
}

/** Re-renders on status or rejection changes. */
function useFakeStore(): void {
  useSyncExternalStore(liveFake.subscribe, liveFake.snapshot);
}

/** The fake `useLiveStatus`. */
function useFakeLiveStatus(): LiveStatus {
  useFakeStore();
  return liveFake.status;
}

/** The fake `usePollInterval`: {@link LIVE_SLOWDOWN} times slower while live. */
function useFakePollInterval(base: number | false): number | false {
  useFakeStore();
  liveFake.pollBases.push(base);
  if (base === false) {
    return false;
  }
  return liveFake.status.state === "live" ? base * LIVE_SLOWDOWN : base;
}

/** The fake `useLiveSubscription`. */
function useFakeLiveSubscription(subscription: LiveSubscription) {
  useFakeStore();
  const ref = useRef(subscription);
  ref.current = subscription;
  useEffect(() => {
    liveFake.subscriptions.add(ref);
    return () => {
      liveFake.subscriptions.delete(ref);
    };
  }, []);
  const rejected =
    subscription.enabled === false
      ? []
      : subscription.channels.flatMap((channel) => {
          const rejection = liveFake.rejections.get(channel);
          return rejection ? [rejection] : [];
        });
  return { rejected };
}

/** The fake `useLiveInvalidation`. */
function useFakeLiveInvalidation(
  channels: readonly string[],
  keys: readonly QueryKey[],
  options: { events?: readonly EventName[]; enabled?: boolean } = {},
): void {
  const queryClient = useQueryClient();
  const entry: FakeInvalidation = {
    channels,
    keys,
    events: options.events,
    enabled: options.enabled ?? true,
    queryClient,
  };
  const ref = useRef(entry);
  ref.current = entry;
  useEffect(() => {
    liveFake.invalidations.add(ref);
    return () => {
      liveFake.invalidations.delete(ref);
    };
  }, []);
}

/**
 * The fake's hook while installed, else the real one. Which one a component
 * gets is fixed for its lifetime: tests install before rendering and
 * uninstall after unmounting.
 */
function pick<F>(fake: F, actual: F): F {
  return liveFake.installed ? fake : actual;
}

/* eslint-disable react/no-unnecessary-use-prefix -- the live module's export names; each dispatches to a hook */
void mock.module("../../app/live", () => ({
  ...real,
  useLiveStatus: () => pick(useFakeLiveStatus, real.useLiveStatus)(),
  usePollInterval: (base: number | false) =>
    pick(useFakePollInterval, real.usePollInterval)(base),
  useLiveSubscription: (subscription: LiveSubscription) =>
    pick(useFakeLiveSubscription, real.useLiveSubscription)(subscription),
  useLiveInvalidation: (
    channels: readonly string[],
    keys: readonly QueryKey[],
    options?: { events?: readonly EventName[]; enabled?: boolean },
  ) =>
    pick(useFakeLiveInvalidation, real.useLiveInvalidation)(
      channels,
      keys,
      options,
    ),
})); /* eslint-enable react/no-unnecessary-use-prefix */

/**
 * Installs the fake around each test of the calling file, with a status
 * (default: off, events pushed, producers publishing). Call at top level,
 * after `setupDom()`.
 */
export function installLiveFake(
  status: Partial<LiveStatus> = {},
): typeof liveFake {
  beforeEach(() => liveFake.install(status));
  afterEach(() => {
    // Unmount first: a component re-rendering after the uninstall would
    // switch from the fake hooks to the real ones mid-life.
    cleanup();
    liveFake.uninstall();
  });
  return liveFake;
}

/** The fields of a test event; `at` defaults to now, `payload` to `{}`. */
export interface TestEvent<Name extends string> {
  /** The event name. */
  type: Name;
  /** The queue or runner. */
  target: string;
  /** The job or run id. */
  id?: string;
  /** What it carries. */
  payload?: unknown;
  /** When, epoch ms. */
  at?: number;
}

/** A queue event. */
export function queueEvent(fields: TestEvent<QueueEventName>): EventWire {
  return {
    v: 1,
    kind: "queue",
    at: Date.now(),
    payload: {},
    ...fields,
  } as EventWire;
}

/** A runner event. */
export function runnerEvent(fields: TestEvent<RunnerEventName>): EventWire {
  return {
    v: 1,
    kind: "runner",
    at: Date.now(),
    payload: {},
    ...fields,
  } as EventWire;
}
