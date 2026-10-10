// happy-dom is registered here only, and react-dom is imported *after* it:
// react-dom decides at evaluation time whether a DOM exists.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createEventSource, createQueryClient } from "./core";
import type { FetchResult, QueryClient } from "./core";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act, Suspense } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider, useMutation, useQuery } = await import("./react");
afterAll(() => GlobalRegistrator.unregister());

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function newClient(): QueryClient {
  return createQueryClient({ focusSource: createEventSource(), onlineSource: createEventSource() });
}

async function render(client: QueryClient, ui: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>); });
  return {
    text: () => container.textContent ?? "",
    container,
    async unmount() { await act(async () => root.unmount()); container.remove(); client.destroy(); },
  };
}

/** Run `fn` inside act and let the resulting promise chains settle. */
async function settle(fn: () => void = () => {}) {
  await act(async () => { fn(); await tick(); await tick(); });
}

describe("useQuery", () => {
  test("renders pending, then success, with a bounded render count", async () => {
    const client = newClient();
    const d = deferred<FetchResult<string>>();
    let renders = 0;
    function Greeting() {
      renders++;
      const q = useQuery(["greeting"], () => d.promise);
      return <p>{q.status}:{q.data ?? "-"}</p>;
    }
    const view = await render(client, <Greeting />);
    expect(view.text()).toBe("pending:-");
    await settle(() => d.resolve({ data: "hello" }));
    expect(view.text()).toBe("success:hello");
    await settle();
    // initial + fetching + success, nothing after: no useSyncExternalStore loop
    expect(renders).toBeLessThanOrEqual(3);
    const settled = renders;
    await settle();
    expect(renders).toBe(settled);
    await view.unmount();
  });

  test("two components with the same key cause one fetch", async () => {
    const client = newClient();
    let calls = 0;
    const fetcher = async (): Promise<FetchResult<number>> => { calls++; await tick(); return { data: 7 }; };
    function A() { return <span>a{useQuery(["shared", { id: 1 }], fetcher).data}</span>; }
    function B() { return <span>b{useQuery(["shared", { id: 1 }], fetcher).data}</span>; }
    const view = await render(client, <><A /><B /></>);
    await settle();
    expect(view.text()).toBe("a7b7");
    expect(calls).toBe(1);
    await view.unmount();
  });

  test("suspense: the boundary shows its fallback, then the data", async () => {
    const client = newClient();
    const d = deferred<FetchResult<string>>();
    let calls = 0;
    function Profile() {
      const q = useQuery(["profile"], () => { calls++; return d.promise; }, { suspense: true });
      return <p>name:{q.data}</p>;
    }
    const view = await render(client, <Suspense fallback={<p>loading</p>}><Profile /></Suspense>);
    expect(view.text()).toBe("loading");
    await settle(() => d.resolve({ data: "Ada" }));
    expect(view.text()).toBe("name:Ada");
    expect(calls).toBe(1);
    await view.unmount();
  });
});

describe("useMutation", () => {
  test("an optimistic mutation shows the new value, then rolls back on error", async () => {
    const client = newClient();
    const save = deferred<string>();
    let fire!: () => void;
    function Title() {
      const q = useQuery(["title"], async () => ({ data: "old" }), { staleTime: Infinity });
      const m = useMutation(
        (_next: string) => save.promise,
        next => ({
          optimistic: (c) => { const rollback = c.snapshot(["title"]); c.setQueryData(["title"], next); return rollback; },
        }),
      );
      fire = () => m.mutate("new");
      return <p>{q.data}|{m.status}</p>;
    }
    const view = await render(client, <Title />);
    await settle();
    expect(view.text()).toBe("old|idle");
    await settle(() => fire());
    expect(view.text()).toBe("new|pending");
    await settle(() => save.reject(new Error("conflict")));
    expect(view.text()).toBe("old|error");
    await view.unmount();
  });
});
