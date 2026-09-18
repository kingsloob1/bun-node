import { useCallback, useMemo } from "react";
import { useRouter } from "../../routing";

/** A patch of query parameters: a string sets one, `null` removes it. */
export type ParamPatch = Readonly<Record<string, string | null>>;

/**
 * The query string as state, several keys at a time: `update()` applies a
 * patch in one navigation (replacing the history entry), so changing a
 * filter and resetting `offset` is one URL change, not two.
 */
export function useUrlParams(): [URLSearchParams, (patch: ParamPatch) => void] {
  const { location, navigate } = useRouter();
  const params = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  );
  const update = useCallback(
    (patch: ParamPatch) => {
      const next = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const query = next.toString();
      navigate(`${location.path ?? "/"}${query ? `?${query}` : ""}`, {
        replace: true,
      });
    },
    [location.path, navigate],
  );
  return [params, update];
}

/** A non-negative integer query parameter, or `fallback`. */
export function intParam(
  params: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const raw = params.get(key);
  if (raw === null || !/^\d+$/.test(raw)) {
    return fallback;
  }
  return Number(raw);
}

/** Splits a comma-separated list, trimming and dropping empties and duplicates. */
export function splitList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** Clamps a page size to `1..max`. */
export function clampLimit(value: number, max: number): number {
  return Math.min(Math.max(1, value), Math.max(1, max));
}
