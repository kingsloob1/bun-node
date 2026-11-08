/**
 * Unmounting releases what the hooks opened (plan §7.1; bun-ui's jobs
 * `unmountLeaks.test.tsx` in small): every query observer, every timer
 * TanStack Query started for a component (its `refetchInterval`), and with
 * them any refetch. A ledger of the global timers records what is opened
 * while a test runs: TanStack's `timeoutManager` looks `setTimeout` and
 * `setInterval` up at each call, so it sees them; React's scheduler captured
 * its timers at load and does not, which is the separation wanted.
 *
 * Each case asserts its start (what is open while mounted), then Phase A
 * (unmounted: the observers and intervals gone, nothing refetched), then
 * Phase B (`queryClient.clear()`: the gc timers gone too, nothing open).
 * The negative control plants a leaking interval, which the ledger must see.
 */
import type { BunRequest, BunResponse } from "@kingsleyweb/bun-common";
import type { ReactNode } from "react";
import { BunRouter } from "@kingsleyweb/bun-common";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Suspense, useEffect } from "react";
import { createClient } from "../../lib/index";
import { invalidateTags, queries } from "../../lib/query";
import { createApiHooks } from "../../lib/react";
import { act, render, settle, setupDom, waitFor } from "./dom";

setupDom();

interface Routes {
  "GET /users/:id": {
    params: { id: string };
    responses: { 200: { id: string; name: string } };
  };
  "GET /users": {
    query: { page?: number };
    responses: { 200: { items: string[]; next: number | null } };
  };
  "POST /users": {
    body: { name: string };
    responses: { 201: { id: string } };
  };
}

const manifest = {
  "GET /users/:id": { cache: { tags: ["user:{id}"] } },
  "GET /users": { cache: { tags: ["users"] } },
} as const;

const router = new BunRouter();
router.get("/users/:id", (req: BunRequest, res: BunResponse) => {
  res.json({ id: req.params.id, name: "Ada" });
});
router.get("/users", (req: BunRequest, res: BunResponse) => {
  const page = Number((req.query as { page?: string }).page ?? "1");
  res.json({ items: [`p${page}`], next: page < 2 ? page + 1 : null });
});
router.post("/users", (_req: BunRequest, res: BunResponse) => {
  res.status(201).json({ id: "4" });
});

/** Requests sent, in total. */
let sent = 0;

const api = createClient<Routes>({
  baseUrl: "http://localhost",
  fetch: (request) => {
    sent++;
    return router.fetch(request);
  },
  retry: false,
  manifest,
});
const q = queries(api, { manifest });
const { useApi, useApiSuspense, useApiInfinite, useApiMutation } =
  createApiHooks(q);

/* ------------------------------------------------------------------ */
/* The timer ledger                                                     */
/* ------------------------------------------------------------------ */

/** A timer opened while the ledger was installed. */
interface Timer {
  /** `"timeout"` or `"interval"`. */
  kind: "timeout" | "interval";
  /** Its delay, in ms. */
  delay: number;
  /** Whether it is still pending: a timeout not yet fired, an interval not cleared. */
  open: boolean;
}

/** Every timer opened since the ledger was installed, by handle. */
const timers = new Map<unknown, Timer>();

/** Bun's timer functions, put back after each test. */
const bun = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

/** Installs the ledger over the global timer functions. */
function installLedger(): void {
  timers.clear();
  const wrapped = {
    setTimeout: (callback: () => void, delay?: number) => {
      const timer: Timer = { kind: "timeout", delay: delay ?? 0, open: true };
      const handle = bun.setTimeout(() => {
        timer.open = false;
        callback();
      }, delay);
      timers.set(handle, timer);
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      const timer = timers.get(handle);
      if (timer) timer.open = false;
      bun.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setInterval: (callback: () => void, delay?: number) => {
      const handle = bun.setInterval(callback, delay);
      timers.set(handle, { kind: "interval", delay: delay ?? 0, open: true });
      return handle;
    },
    clearInterval: (handle: unknown) => {
      const timer = timers.get(handle);
      if (timer) timer.open = false;
      bun.clearInterval(handle as ReturnType<typeof setInterval>);
    },
  };
  for (const [name, value] of Object.entries(wrapped)) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

/** Puts Bun's timer functions back. */
function removeLedger(): void {
  for (const [name, value] of Object.entries(bun)) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

/** The timers still open, as `"<kind> <delay>ms"`. */
const open = (): string[] =>
  [...timers.values()]
    .filter((timer) => timer.open)
    .map((timer) => `${timer.kind} ${timer.delay}ms`);

/** The number of observers of `client`'s queries. */
const observers = (client: QueryClient): number =>
  client
    .getQueryCache()
    .getAll()
    .reduce((sum, query) => sum + query.getObserversCount(), 0);

/** `node` under a `QueryClientProvider` for `client`. */
function within(client: QueryClient, node: ReactNode): ReactNode {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  sent = 0;
  installLedger();
});

afterEach(() => {
  removeLedger();
  for (const handle of timers.keys()) {
    bun.clearTimeout(handle as ReturnType<typeof setTimeout>);
    bun.clearInterval(handle as ReturnType<typeof setInterval>);
  }
});

/** Phase B: the cache cleared, nothing left open, no observer. */
async function assertNoneOpen(client: QueryClient): Promise<void> {
  await settle();
  client.clear();
  await settle();
  expect(observers(client)).toBe(0);
  expect(open()).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* The cases                                                            */
/* ------------------------------------------------------------------ */

describe("unmounting the hooks", () => {
  it("useApi: its observer and its refetchInterval go, and an invalidation refetches nothing", async () => {
    const client = new QueryClient();
    function Polled() {
      const user = useApi(
        "/users/:id",
        { params: { id: "1" } },
        { refetchInterval: 60_000 },
      );
      return <p>{user.data?.name ?? "loading"}</p>;
    }
    const view = await render(within(client, <Polled />));
    await waitFor(() => expect(view.text()).toBe("Ada"));
    // Start: one observer, its interval open, and an invalidation refetches.
    expect(observers(client)).toBe(1);
    expect(open()).toContain("interval 60000ms");
    await act(() => invalidateTags(client, ["user:1"]));
    expect(sent).toBe(2);

    // Phase A.
    await view.unmount();
    expect(observers(client)).toBe(0);
    expect(open().filter((timer) => timer.startsWith("interval"))).toEqual([]);
    await act(() => invalidateTags(client, ["user:1"]));
    await settle();
    expect(sent).toBe(2);

    await assertNoneOpen(client);
  });

  it("useApiSuspense and useApiInfinite: their observers go", async () => {
    const client = new QueryClient();
    function Both() {
      const user = useApiSuspense("/users/:id", { params: { id: "1" } });
      const pages = useApiInfinite(
        "/users",
        {},
        { pageParam: "page", next: (last) => last.next },
      );
      return (
        <p>
          {user.data.name}
          {pages.data?.pages.length ?? 0}
        </p>
      );
    }
    const view = await render(
      within(
        client,
        <Suspense fallback={<p>suspended</p>}>
          <Both />
        </Suspense>,
      ),
    );
    await waitFor(() => expect(view.text()).toBe("Ada1"));
    expect(observers(client)).toBe(2);

    await view.unmount();
    expect(observers(client)).toBe(0);
    await assertNoneOpen(client);
  });

  it("useApiMutation: its observer goes, so the settled mutation is collected after its gcTime", async () => {
    // Not `client.clear()` here: query-core's `MutationCache.clear()` leaves
    // each mutation's gc timeout pending (it fires later and removes
    // nothing), so the release is shown by the collection instead.
    const client = new QueryClient();
    let mutate: (() => Promise<unknown>) | undefined;
    function Create() {
      const create = useApiMutation("POST /users", {}, { gcTime: 30 });
      mutate = () => create.mutateAsync({ body: { name: "Grace" } });
      return <p>{create.status}</p>;
    }
    const view = await render(within(client, <Create />));
    await act(async () => {
      await mutate!();
    });
    await waitFor(() => expect(view.text()).toBe("success"));
    // Start: mounted past its gcTime, its observer keeps it.
    await settle();
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(client.getMutationCache().getAll().length).toBe(1);

    // Phase A: unmounted, it is collected once its gcTime passes.
    await view.unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(client.getMutationCache().getAll()).toEqual([]);
    expect(open()).toEqual([]);
  });

  it("negative control: the ledger sees an interval a component leaves behind", async () => {
    function Leaky() {
      useEffect(() => {
        setInterval(() => undefined, 12_345);
      }, []);
      return null;
    }
    const view = await render(<Leaky />);
    await view.unmount();
    await settle();
    expect(open()).toEqual(["interval 12345ms"]);
  });
});
