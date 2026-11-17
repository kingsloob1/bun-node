/**
 * The cursor trail of a list, kept in the URL (ui.md §5: unlike the jobs
 * table, so back/forward and a shared link land on the same page): `page`
 * is the cursors walked, in order (the list's own opaque cursors, JSON),
 * and `limit` the page size. The page shown starts at the trail's last
 * cursor; the first page has none.
 */
import { useCallback, useMemo } from "react";
import { useRouter } from "../routing";

/** The URL parameters. */
export const PAGE_PARAM = "page";
export const LIMIT_PARAM = "limit";

/** A list's position and how to move it. */
export interface UrlCursor {
  /** The cursor of the page shown; `undefined` for the first. */
  readonly cursor: string | undefined;
  /** The page size. */
  readonly limit: number;
  /** How many pages this walk is in (0 on the first). */
  readonly depth: number;
  /** Walks to the next page, through its cursor (`page.next`). */
  readonly next: (cursor: string) => void;
  /** Walks back one page. */
  readonly prev: () => void;
  /** Changes the page size, back to the first page. */
  readonly setLimit: (limit: number) => void;
}

/** The trail in `search`; a malformed one is the first page. */
export function trailOf(search: string): string[] {
  const raw = new URLSearchParams(search).get(PAGE_PARAM);
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? (value as string[])
      : [];
  } catch {
    return [];
  }
}

/** See the module's description. */
export function useUrlCursor(defaultLimit = 50, maxLimit = 200): UrlCursor {
  const { location, navigate } = useRouter();
  const trail = useMemo(() => trailOf(location.search), [location.search]);
  const asked = Number(new URLSearchParams(location.search).get(LIMIT_PARAM));
  const limit =
    Number.isInteger(asked) && asked > 0
      ? Math.min(asked, maxLimit)
      : defaultLimit;
  const go = useCallback(
    (nextTrail: readonly string[], nextLimit: number) => {
      const params = new URLSearchParams(location.search);
      if (nextTrail.length === 0) params.delete(PAGE_PARAM);
      else params.set(PAGE_PARAM, JSON.stringify(nextTrail));
      if (nextLimit === defaultLimit) params.delete(LIMIT_PARAM);
      else params.set(LIMIT_PARAM, String(nextLimit));
      const query = params.toString();
      navigate(`${location.path ?? "/"}${query === "" ? "" : `?${query}`}`);
    },
    [defaultLimit, location.path, location.search, navigate],
  );
  return useMemo(
    () => ({
      cursor: trail.at(-1),
      limit,
      depth: trail.length,
      next: (cursor: string) => go([...trail, cursor], limit),
      prev: () => go(trail.slice(0, -1), limit),
      setLimit: (next: number) => go([], next),
    }),
    [trail, limit, go],
  );
}
