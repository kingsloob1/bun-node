/**
 * The jobs UI's {@link HandleLedger}: the shared harness ledger
 * (`__tests__/harness/handleLedger.ts`, embedding.md §8) with the live
 * client's {@link FakeSocket} as the global `WebSocket`, so a test both plays
 * the server and sees which channels a screen still holds
 * ({@link TrackedSocket.held}, {@link assertReleased}).
 */
import type { Handle, LedgerSocketClass } from "../../harness/handleLedger";
import {
  HandleLedger as SharedHandleLedger,
  markClosed,
} from "../../harness/handleLedger";
import { FakeSocket } from "./live/fakes";

export type {
  FetchLike,
  Handle,
  HandleClosure,
  HandleKind,
  TrackFetchOptions,
} from "../../harness/handleLedger";
export { nativeSleep } from "../../harness/handleLedger";

/** A {@link FakeSocket} the ledger counts: open until either side closes it, recording which channels the client holds. */
export class TrackedSocket extends FakeSocket {
  /** `WebSocket.CONNECTING`. */
  static readonly CONNECTING = 0;
  /** `WebSocket.OPEN`. */
  static readonly OPEN = 1;
  /** `WebSocket.CLOSING`. */
  static readonly CLOSING = 2;
  /** `WebSocket.CLOSED`. */
  static readonly CLOSED = 3;

  /** Its ledger handle; set by the ledger after construction. */
  handle: Handle | undefined;

  /** Every channel the client holds now, from its subscribe and unsubscribe frames (acked or not). */
  readonly held = new Set<string>();

  constructor(url: string, protocols: string[] = []) {
    super(url, protocols);
  }

  override send(data: string): void {
    super.send(data);
    const frame = JSON.parse(data) as {
      /** The frame's op. */
      op: string;
      /** The channels it names. */
      channels?: string[];
    };
    for (const channel of frame.channels ?? []) {
      if (frame.op === "subscribe") {
        this.held.add(channel);
      }
      if (frame.op === "unsubscribe") {
        this.held.delete(channel);
      }
    }
  }

  override close(code?: number): void {
    super.close(code);
    markClosed(this.handle);
  }

  override drop(code?: number): void {
    super.drop(code);
    markClosed(this.handle);
  }
}

/** The shared ledger, its sockets the jobs live client's fakes. */
export class HandleLedger extends SharedHandleLedger {
  /** Every socket the code under test created, in order. */
  declare readonly sockets: TrackedSocket[];

  protected override socketClass(): LedgerSocketClass {
    return TrackedSocket;
  }

  override uninstall(): void {
    super.uninstall();
    // FakeSocket keeps every instance: drop ours, so a later file's
    // `FakeSocket.last` is never one of them.
    FakeSocket.instances = FakeSocket.instances.filter(
      (socket) => !(socket instanceof TrackedSocket),
    );
  }
}

/** Throws, naming them, when `socket` still holds any of `channels`: what a screen's hold left behind. */
export function assertReleased(
  socket: TrackedSocket,
  channels: readonly string[],
): void {
  const kept = channels.filter((channel) => socket.held.has(channel));
  if (kept.length > 0) {
    throw new Error(
      `live hold never released: ${kept.join(", ")} still subscribed after the screen unmounted`,
    );
  }
}
