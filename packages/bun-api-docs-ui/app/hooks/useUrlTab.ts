import { useRouter } from "../routing";

/**
 * The selected tab of a `UrlTabs`, read from the URL: the value of
 * `param` when it is one of `tabs`, else `defaultValue`. Use it in the
 * screen to pick the data for the panel.
 */
export function useUrlTab<V extends string>(
  param: string,
  tabs: readonly { value: V }[],
  defaultValue: V,
): V {
  const { location } = useRouter();
  const raw = new URLSearchParams(location.search).get(param);
  return tabs.find((tab) => tab.value === raw)?.value ?? defaultValue;
}
