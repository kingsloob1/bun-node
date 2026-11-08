import type { NavItem } from "./nav";
import { useMemo } from "react";
import { useUiConfig } from "../context";
import { useCanFn, useMeta } from "../meta/hooks";
import { buildNav } from "./nav";

/** The nav entries for this caller (see {@link buildNav}). */
export function useNav(): NavItem[] {
  const meta = useMeta();
  const can = useCanFn();
  const { sections } = useUiConfig();
  return useMemo(
    () => buildNav({ meta, sections, can }),
    [meta, sections, can],
  );
}
