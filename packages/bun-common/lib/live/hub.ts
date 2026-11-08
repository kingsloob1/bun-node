/**
 * Live invalidation's process hub (typed-client plan `websocket.md` §9): the
 * epoch, the numbered invalidations and their ring, the refcounted tags, the
 * servers with live sockets and the SSE streams, shared by the server half
 * (`./server.ts`) and the bus (`./bus.ts`). Internal: nothing here is
 * exported from `./live`.
 *
 * - **Numbering**: every invalidation this process delivers, its own or one
 *   a bus brought from another process, takes the next `seq` of this epoch
 *   and a place in the ring, so a client's cursor is always this process's.
 * - **Gaps**: when invalidations may have been lost (the bus reconnected,
 *   or another process's message never arrived), {@link markGap} takes a
 *   `seq` of its own, sends `gap` to every socket and stream, and makes every
 *   cursor before it resume as a gap.
 */
import type { ServerWebSocket } from "bun";
import type { Channel } from "../channel";
import type { BunServer } from "../types/general";
import type { LiveCursor, LiveInvalidate, liveContract } from "./contract";
import { LIVE_MAX_TAG_LENGTH, LIVE_MAX_TAGS } from "./contract";

/** How many invalidations the ring keeps for resume. */
export const RING_SIZE = 1024;

/** The most tags one socket or stream may hold; the rest of a `subscribe` is ignored (and logged). */
export const MAX_SUBSCRIBED = 10_000;

/** The pub/sub topic of a tag. */
export const topicOf = (tag: string): string => `bun-common/live:${tag}`;

/**
 * The pub/sub topic every live socket joins on open, which {@link markGap}
 * publishes on. No colon after `live`, so no tag's topic is ever this one.
 */
export const GAP_TOPIC = "bun-common/live-gap";

/** One invalidation, as the ring keeps it. */
export interface Entry {
  /** Its number. */
  readonly seq: number;
  /** Its tags (de-duplicated); none for a gap. */
  readonly tags: readonly string[];
}

/** An SSE subscriber. */
export interface Stream {
  /** Its tags. */
  readonly tags: ReadonlySet<string>;
  /** Sends one invalidation (its id is `<epoch>:<seq>`). */
  readonly write: (data: LiveInvalidate) => void;
  /** Sends a `gap` (its id is `<epoch>:<seq>`). */
  readonly gap: (cursor: LiveCursor) => void;
}

/** The live channel's binding type. */
export type LiveChannel = Channel<typeof liveContract.spec>;

/** A socket's live state. */
export interface SocketState {
  /** The tags it holds. */
  readonly tags: Set<string>;
  /** The server it is on, counted in {@link Hub.servers}. */
  readonly server: BunServer | undefined;
}

/** The process's live state. */
export interface Hub {
  /** This process's epoch: random, so a restarted process never matches. */
  epoch: string;
  /** The last invalidation's number; `0` before any. */
  seq: number;
  /** The last {@link RING_SIZE} invalidations, oldest first. */
  ring: Entry[];
  /** The `seq` of the last gap ({@link markGap}); `0` before any. A cursor before it resumes as a gap. */
  lastGap: number;
  /** Every tag somebody holds, with how many sockets and streams hold it. */
  readonly refs: Map<string, number>;
  /** The servers with live sockets: the channel to publish through, and how many sockets. */
  readonly servers: Map<BunServer, { channel: LiveChannel; sockets: number }>;
  /** The SSE subscribers. */
  readonly streams: Set<Stream>;
  /** Every live socket's state. */
  readonly sockets: WeakMap<ServerWebSocket<unknown>, SocketState>;
}

/** The hub. */
export const hub: Hub = {
  epoch: crypto.randomUUID(),
  seq: 0,
  ring: [],
  lastGap: 0,
  refs: new Map(),
  servers: new Map(),
  streams: new Set(),
  sockets: new WeakMap(),
};

/**
 * Starts a new epoch, as a restarted process would: a new random epoch, the
 * count from `0` and an empty ring (the subscribers stay). A client
 * resuming from before it gets a `gap`.
 *
 * @internal For tests.
 */
export function restartLiveEpoch(): void {
  hub.epoch = crypto.randomUUID();
  hub.seq = 0;
  hub.ring = [];
  hub.lastGap = 0;
}

/** The hub's position now. */
export const cursorNow = (): LiveCursor => ({ epoch: hub.epoch, seq: hub.seq });

/** Adds a holder of `tag`. */
export function ref(tag: string): void {
  hub.refs.set(tag, (hub.refs.get(tag) ?? 0) + 1);
}

/** Removes a holder of `tag`. */
export function unref(tag: string): void {
  const count = (hub.refs.get(tag) ?? 0) - 1;
  if (count > 0) hub.refs.set(tag, count);
  else hub.refs.delete(tag);
}

/** `tags` split into frames of at most {@link LIVE_MAX_TAGS}. */
export function chunked(tags: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let at = 0; at < tags.length; at += LIVE_MAX_TAGS)
    out.push(tags.slice(at, at + LIVE_MAX_TAGS));
  return out;
}

/** Whether `tag` is one a frame can carry. */
export function isTag(tag: unknown): tag is string {
  return (
    typeof tag === "string" &&
    tag.length > 0 &&
    tag.length <= LIVE_MAX_TAG_LENGTH
  );
}

/**
 * Whether a client at `cursor` cannot be replayed what it missed: another
 * epoch, a cursor ahead of the server, one before the last gap, or one the
 * ring no longer reaches.
 */
export function isGap(cursor: LiveCursor): boolean {
  if (cursor.epoch !== hub.epoch || cursor.seq > hub.seq) return true;
  if (cursor.seq < hub.lastGap) return true;
  const oldest = hub.ring[0]?.seq ?? hub.seq + 1;
  return cursor.seq < oldest - 1;
}

/** The invalidations after `after` that hit `tags`, each with the tags it hit. */
export function missed(
  after: number,
  tags: ReadonlySet<string>,
): { seq: number; tags: string[] }[] {
  const out: { seq: number; tags: string[] }[] = [];
  for (const entry of hub.ring) {
    if (entry.seq <= after) continue;
    const hit = entry.tags.filter((tag) => tags.has(tag));
    if (hit.length > 0) out.push({ seq: entry.seq, tags: hit });
  }
  return out;
}

/** Numbers `entry`'s `seq` and keeps it in the ring. */
function remember(entry: Entry): void {
  hub.ring.push(entry);
  if (hub.ring.length > RING_SIZE) hub.ring.shift();
}

/**
 * Delivers an invalidation of `unique` (valid, de-duplicated, non-empty
 * tags) in this process: numbered, kept in the ring, and sent to every
 * socket and SSE stream holding one of them. Synchronous: the sends are
 * queued, and reach each socket in publication order.
 */
export function deliverLocally(unique: readonly string[]): void {
  const seq = ++hub.seq;
  remember({ seq, tags: unique });
  const { epoch } = hub;
  for (const tag of unique) {
    if (!hub.refs.has(tag)) continue;
    for (const [server, { channel }] of hub.servers) {
      // One frame per topic: Bun's pub/sub sends it once to every socket
      // holding the tag. The data is the contract's, so the check passes.
      void channel.publish(server, topicOf(tag), "invalidate", {
        tags: [tag],
        seq,
        epoch,
      });
    }
  }
  for (const stream of hub.streams) {
    const hit = unique.filter((tag) => stream.tags.has(tag));
    for (const part of chunked(hit)) stream.write({ tags: part, seq, epoch });
  }
}

/**
 * Records that invalidations may have been lost: a `seq` of its own, a
 * `gap` sent to every live socket and SSE stream (each invalidates
 * everything), and every cursor before it answered with a `gap` on resume.
 */
export function markGap(): void {
  const seq = ++hub.seq;
  remember({ seq, tags: [] });
  hub.lastGap = seq;
  const cursor = cursorNow();
  for (const [server, { channel }] of hub.servers)
    void channel.publish(server, GAP_TOPIC, "gap", cursor);
  for (const stream of hub.streams) stream.gap(cursor);
}
