import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { MetaDto, Permissions } from "../../../app/api/types";
import type { LiveClientOverrides } from "../../../app/live";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { StrictMode, useState } from "react";
import { UiConfigContext } from "../../../app/context";
import {
  LiveOptionsContext,
  LiveProvider,
  LOCAL_EVENTS_NOTE,
  pollInterval,
  useLiveInvalidation,
  useLiveStatus,
  useLiveSubscription,
  usePollInterval,
} from "../../../app/live";
import { MetaContext } from "../../../app/meta/hooks";
import { createQueryClient } from "../../../app/queryClient";
import { act, render, setupDom, waitFor } from "../dom";
import { metaFixture, permissionsFixture, uiConfig } from "../fixtures";
import { FakeSocket, hello, queueEvent } from "./fakes";

setupDom();

beforeEach(() => {
  FakeSocket.instances = [];
});

/** Client overrides: the fake socket, no jitter. */
const OPTIONS: LiveClientOverrides = {
  WebSocket: FakeSocket,
  random: () => 0,
};

/** Renders `children` under the providers `LiveProvider` needs. */
function renderLive(
  children: ReactNode,
  options: {
    /** `/meta` overrides. */
    meta?: Partial<MetaDto>;
    /** Permission overrides. */
    actions?: Permissions["actions"];
    /** Wrap in StrictMode. */
    strict?: boolean;
    /** UI config overrides. */
    config?: Parameters<typeof uiConfig>[0];
  } = {},
) {
  const queryClient = createQueryClient({ retry: false });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <UiConfigContext value={uiConfig(options.config)}>
        <MetaContext
          value={{
            meta: metaFixture(options.meta),
            permissions: permissionsFixture(options.actions),
          }}
        >
          <LiveOptionsContext value={OPTIONS}>
            <LiveProvider>{children}</LiveProvider>
          </LiveOptionsContext>
        </MetaContext>
      </UiConfigContext>
    </QueryClientProvider>
  );
  const result = render(
    options.strict ? <StrictMode>{tree}</StrictMode> : tree,
  );
  return { ...result, queryClient };
}

/** Shows the status and the poll interval for a 5 s base. */
function StatusProbe() {
  const status = useLiveStatus();
  const interval = usePollInterval(5_000);
  const never = usePollInterval(false);
  return (
    <output data-testid="status">
      {JSON.stringify({ ...status, interval, never })}
    </output>
  );
}

/** The probe's status. */
function status(container: HTMLElement) {
  const text =
    container.querySelector("[data-testid=status]")?.textContent ?? "{}";
  return JSON.parse(text) as ReturnType<typeof useLiveStatus> & {
    interval: number | false;
    never: number | false;
  };
}

/** Sockets not closed by the client. */
function openSockets() {
  return FakeSocket.instances.filter(
    (socket) => socket.closedWith === undefined,
  );
}

describe("LiveProvider", () => {
  it("is off, with why, when the API has no socket", () => {
    const { container } = renderLive(<StatusProbe />, {
      meta: { websocket: null },
    });
    expect(status(container)).toMatchObject({
      state: "off",
      detail: "The API has no live-events socket",
      interval: 5_000,
    });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("is off, with why, when events.connect is denied", () => {
    const { container } = renderLive(<StatusProbe />, {
      actions: { "events.connect": false },
    });
    expect(status(container).state).toBe("off");
    expect(status(container).detail).toMatch(/events\.connect/);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("is off, with why, when the UI shows documentation only (sections.manage false)", () => {
    const { container } = renderLive(<StatusProbe />, {
      config: { sections: { manage: false, docs: true } },
    });
    expect(status(container)).toMatchObject({
      state: "off",
      detail: "Live updates are off: this UI shows documentation only",
      interval: 5_000,
    });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("is off when events are local and nothing publishes", () => {
    const { container } = renderLive(<StatusProbe />, {
      meta: { events: "local", publishing: false },
    });
    expect(status(container).state).toBe("off");
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("connects once, goes live on hello, notes local events, and relaxes polling", async () => {
    const { container } = renderLive(<StatusProbe />);
    expect(openSockets()).toHaveLength(1);
    const socket = FakeSocket.last;
    expect(socket.url).toBe("ws://localhost/jobs-api/ws");
    expect(status(container)).toMatchObject({
      state: "connecting",
      interval: 5_000,
    });
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(status(container).state).toBe("live"));
    expect(status(container)).toMatchObject({
      detail: LOCAL_EVENTS_NOTE,
      events: "local",
      interval: 60_000,
      never: false,
    });
  });

  it("has no local-events note for push", async () => {
    const { container } = renderLive(<StatusProbe />, {
      meta: { events: "push" },
    });
    act(() => {
      FakeSocket.last.open();
      FakeSocket.last.receive(hello({ events: "push" }));
    });
    await waitFor(() => expect(status(container).state).toBe("live"));
    expect(status(container).detail).toBeNull();
  });

  it("closes the socket on unmount", () => {
    const { unmount } = renderLive(<StatusProbe />);
    const socket = FakeSocket.last;
    unmount();
    expect(socket.closedWith).toBe(1000);
    expect(openSockets()).toHaveLength(0);
  });

  it("survives StrictMode's double mount with exactly one open socket", async () => {
    const { container, unmount } = renderLive(<StatusProbe />, {
      strict: true,
    });
    expect(openSockets()).toHaveLength(1);
    act(() => {
      openSockets()[0]!.open();
      openSockets()[0]!.receive(hello());
    });
    await waitFor(() => expect(status(container).state).toBe("live"));
    unmount();
    expect(openSockets()).toHaveLength(0);
  });
});

describe("useLiveSubscription", () => {
  /** Holds `queue/emails`, re-rendering with a fresh callback on demand. */
  function Holder({ onEvent }: { onEvent: () => void }) {
    const [tick, setTick] = useState(0);
    useLiveSubscription({
      channels: ["queue/emails"],
      onEvent: () => onEvent(),
    });
    return (
      <button
        type="button"
        data-tick={tick}
        onClick={() => setTick(tick + 1)}
      >
        rerender
      </button>
    );
  }

  /** Two holders of one channel. */
  function Pair({ onEvent }: { onEvent: () => void }) {
    return (
      <>
        <Holder onEvent={onEvent} />
        <Holder onEvent={onEvent} />
      </>
    );
  }

  it("shares one subscribe across components, delivers to each, and does not resubscribe on re-render", async () => {
    let events = 0;
    const onEvent = () => {
      events++;
    };
    const { unmount, getAllByText } = renderLive(<Pair onEvent={onEvent} />);
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(socket.ops("subscribe")).toHaveLength(1));
    act(() => getAllByText("rerender")[0]!.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(socket.sent).toHaveLength(1);

    act(() => socket.receive(queueEvent(1, ["queue/emails"])));
    expect(events).toBe(2);

    unmount();
    // The whole provider unmounted: the socket closed, no frame needed.
    expect(socket.closedWith).toBe(1000);
  });

  it("sends one unsubscribe only when the last of two holders leaves", async () => {
    /** Two holders of `queue/emails`, each shown or not. */
    function Toggle({ first, second }: { first: boolean; second: boolean }) {
      return (
        <>
          {first && <Holder onEvent={() => {}} />}
          {second && <Holder onEvent={() => {}} />}
        </>
      );
    }
    let show!: (value: { first: boolean; second: boolean }) => void;
    /** Owns the toggle state. */
    function Root() {
      const [shown, setShown] = useState({ first: true, second: true });
      show = setShown;
      return <Toggle {...shown} />;
    }
    renderLive(<Root />);
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(socket.ops("subscribe")).toHaveLength(1));
    act(() => show({ first: false, second: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(socket.ops("unsubscribe")).toHaveLength(0);
    act(() => show({ first: false, second: false }));
    await waitFor(() => expect(socket.ops("unsubscribe")).toHaveLength(1));
  });

  it("returns the channels the server rejected", async () => {
    /** Shows its rejections. */
    function Rejected() {
      const { rejected } = useLiveSubscription({ channels: ["queue/x y"] });
      return <p data-testid="rejected">{rejected.map((r) => r.code).join()}</p>;
    }
    const { findByText } = renderLive(<Rejected />);
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(socket.ops("subscribe")).toHaveLength(1));
    act(() =>
      socket.receive({
        type: "ack",
        id: socket.ops("subscribe")[0]!.id,
        op: "subscribe",
        channels: [],
        rejected: [
          { channel: "queue/x y", code: "INVALID_CHANNEL", status: 400 },
        ],
        seq: 0,
      }),
    );
    expect(await findByText("INVALID_CHANNEL")).toBeTruthy();
  });

  it("holds nothing while disabled", async () => {
    /** A disabled subscription. */
    function Disabled() {
      useLiveSubscription({ channels: ["queues"], enabled: false });
      return null;
    }
    renderLive(<Disabled />);
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(socket.sent).toHaveLength(0);
  });
});

describe("useLiveInvalidation", () => {
  it("coalesces events and gaps over ~250 ms into one invalidation per key", async () => {
    const keys: QueryKey[] = [["queue", "emails"], ["overview"]];
    /** Invalidates `keys` on queue/emails. */
    function Invalidator() {
      useLiveInvalidation(["queue/emails"], [...keys]);
      return null;
    }
    const { queryClient } = renderLive(<Invalidator />);
    const invalidate = spyOn(queryClient, "invalidateQueries");
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(socket.ops("subscribe")).toHaveLength(1));

    act(() => {
      socket.receive(queueEvent(1, ["queue/emails"]));
      socket.receive(queueEvent(2, ["queue/emails"]));
      socket.receive({
        type: "gap",
        epoch: "e1",
        fromSeq: 3,
        toSeq: 4,
        reason: "slow-consumer",
      });
    });
    expect(invalidate).not.toHaveBeenCalled();
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      keys,
    );

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(invalidate).toHaveBeenCalledTimes(2);
    act(() => socket.receive(queueEvent(5, ["queue/emails"])));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(4), {
      timeout: 1_000,
    });
  });

  it("ignores event types outside its filter", async () => {
    /** Invalidates only on `added`. */
    function Invalidator() {
      useLiveInvalidation(["queue/emails"], [["q"]], { events: ["added"] });
      return null;
    }
    const { queryClient } = renderLive(<Invalidator />);
    const invalidate = spyOn(queryClient, "invalidateQueries");
    const socket = FakeSocket.last;
    act(() => {
      socket.open();
      socket.receive(hello());
    });
    await waitFor(() => expect(socket.ops("subscribe")).toHaveLength(1));
    expect(socket.ops("subscribe")[0]!.events).toEqual(["added"]);
    act(() => socket.receive(queueEvent(1, ["queue/emails"], "completed")));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("usePollInterval", () => {
  it("is base when not live; while live false stays false, else max(base × 6, 60 s)", () => {
    expect(pollInterval(5_000, false)).toBe(5_000);
    expect(pollInterval(false, false)).toBe(false);
    expect(pollInterval(false, true)).toBe(false);
    expect(pollInterval(5_000, true)).toBe(60_000);
    expect(pollInterval(30_000, true)).toBe(180_000);
  });

  it("is base outside a LiveProvider", () => {
    /** Reads the interval with no provider. */
    function Bare() {
      return <p data-testid="bare">{String(usePollInterval(5_000))}</p>;
    }
    const { getByTestId } = render(<Bare />);
    expect(getByTestId("bare").textContent).toBe("5000");
  });
});
