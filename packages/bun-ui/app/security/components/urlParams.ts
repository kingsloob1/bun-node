/**
 * A screen's filters kept in the URL (ui.md §2: a link shares exactly what
 * the sender saw): read them, and set one, which goes back to the first
 * page of the list's cursor walk.
 */
import { useRouter } from "../routing";
import { PAGE_PARAM } from "./urlCursor";

/** The URL's parameters, and how to change one. */
export interface UrlParams {
  /** The parameters now. */
  readonly params: URLSearchParams;
  /** Sets `name` (an empty value removes it), back to the first page. */
  readonly set: (name: string, value: string) => void;
}

/** See the module's description. */
export function useUrlParams(): UrlParams {
  const { location, navigate } = useRouter();
  const params = new URLSearchParams(location.search);
  return {
    params,
    set: (name, value) => {
      const next = new URLSearchParams(location.search);
      if (value === "") next.delete(name);
      else next.set(name, value);
      next.delete(PAGE_PARAM);
      const query = next.toString();
      navigate(`${location.path ?? "/"}${query === "" ? "" : `?${query}`}`);
    },
  };
}

/** A time as people read it; `never` for none. */
export function when(at: number | null | undefined): string {
  return at === null || at === undefined
    ? "never"
    : new Date(at).toLocaleString();
}

/** An epoch-ms time as a `datetime-local` value (local time), or empty. */
export function toLocalInput(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A `datetime-local` value as epoch ms, or `undefined` for empty or invalid. */
export function fromLocalInput(value: string): number | undefined {
  if (value === "") return undefined;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : undefined;
}

/** A number parameter, or `undefined` when absent or not a whole number. */
export function numberParam(
  params: URLSearchParams,
  name: string,
): number | undefined {
  const raw = params.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}
