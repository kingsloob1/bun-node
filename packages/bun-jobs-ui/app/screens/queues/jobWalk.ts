import { useCallback, useState } from "react";

/**
 * Walking the jobs list by cursor.
 *
 * `GET /queues/:queue/jobs` offers two ways to page, and they answer
 * different questions. An **offset** counts matching jobs, which is how a
 * reader jumps to page N — and how a draining queue loses rows out of the
 * window without anyone noticing. A **cursor** names the job the last page
 * ended at, so nothing shifts under it; the API mints one on every page,
 * including an offset page, so the two mix: jump to where you want to be,
 * then walk on from there without losing a row.
 *
 * Three facts decide the shape of the state below.
 *
 * - **A cursor only goes forward.** The page after one is `page.next`;
 *   there is no `page.previous`. So walking back means remembering the cursor
 *   that produced each page — the trail here.
 * - **A cursor is opaque and up to 2 kB.** It cannot go in the URL (a trail
 *   of them certainly cannot), and nothing may build, parse or compare one.
 *   So the URL keeps saying where the walk *started*, as an offset, and a
 *   reload re-samples from there rather than resuming a walk it cannot carry.
 * - **A cursor is bound to its walk** — the queue, the states, the sort and
 *   the order. One belonging to another walk is a 400, not a silent restart.
 *   So the trail is stored with the key of the walk it belongs to, and a key
 *   that no longer matches makes it empty: a stale cursor cannot be sent,
 *   because it is not there to send.
 */

/** A walk: the cursors that produced each page past the one it started on. */
export interface WalkState {
  /** The walk this trail belongs to; a different one makes the trail empty. */
  key: string;
  /**
   * The cursor sent for each page walked past the first, oldest first. Empty
   * on the page the walk started from, which is an offset page.
   */
  trail: readonly string[];
}

/** A walk that has not left its first page. */
export function emptyWalk(key: string): WalkState {
  return { key, trail: [] };
}

/**
 * `state` if it still belongs to `key`, an empty walk otherwise. Derived, not
 * stored: the walk a changed filter invalidated must be gone on the render
 * that changes it, not one effect later — by then the request has gone out.
 */
export function walkFor(state: WalkState, key: string): WalkState {
  return state.key === key ? state : emptyWalk(key);
}

/** The walk one page on, with `cursor` (a page's `page.next`) as its new page. */
export function walkForward(state: WalkState, cursor: string): WalkState {
  return { key: state.key, trail: [...state.trail, cursor] };
}

/** The walk one page back; already at its first page, unchanged. */
export function walkBack(state: WalkState): WalkState {
  return state.trail.length === 0
    ? state
    : { key: state.key, trail: state.trail.slice(0, -1) };
}

/** The cursor of the page a walk is on, or `undefined` on the page it started from. */
export function walkCursor(state: WalkState): string | undefined {
  return state.trail.at(-1);
}

/** Walking the jobs list, as a screen uses it. */
export interface JobWalk {
  /**
   * The cursor that produced the page shown, or `undefined` on the page the
   * walk started from (an offset page). Pass it to `readJobFilters`.
   */
  cursor: string | undefined;
  /** Whether a page this walk has already shown can be returned to. */
  canPrev: boolean;
  /** Walks on, with the shown page's `page.next`. */
  forward: (cursor: string) => void;
  /** Walks back one page. */
  back: () => void;
  /** Abandons the walk, for a move that jumps (a page number, an offset). */
  reset: () => void;
}

/**
 * The walk of one jobs list, reset whenever `key` changes.
 *
 * `key` must name every parameter the cursor is bound to — queue, states,
 * sort, order — and, in practice, every filter whose change should restart
 * paging. It must *not* name the page size: the cursor that produced the page
 * shown is re-sent with the new size, so the page keeps its first row, which
 * is what the size control means everywhere else in the app.
 */
export function useJobWalk(key: string): JobWalk {
  const [stored, setStored] = useState<WalkState>(() => emptyWalk(key));
  const state = walkFor(stored, key);
  const forward = useCallback(
    (cursor: string) =>
      setStored((previous) => walkForward(walkFor(previous, key), cursor)),
    [key],
  );
  const back = useCallback(
    () => setStored((previous) => walkBack(walkFor(previous, key))),
    [key],
  );
  const reset = useCallback(
    () =>
      setStored((previous) =>
        walkFor(previous, key).trail.length === 0 ? previous : emptyWalk(key),
      ),
    [key],
  );
  return {
    cursor: walkCursor(state),
    canPrev: state.trail.length > 0,
    forward,
    back,
    reset,
  };
}
