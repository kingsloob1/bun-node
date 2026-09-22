import { useMemo } from "react";
import { useUiConfig } from "../../context";
import { buildNav } from "../../layout/nav";
import { useMeta, useUntargetedCanFn } from "../../meta/hooks";

/**
 * Whether the worker pages (`/workers/:queue/:key`) are routed for this
 * caller: exactly when the Workers nav entry exists, since the routes are
 * built from the nav. Read from the **untargeted** map, so a queue's own
 * answer (the queue panel sits inside one) cannot offer a link to a route the
 * app never registered.
 */
export function useWorkerPagesRouted(): boolean {
  const meta = useMeta();
  const { sections } = useUiConfig();
  const can = useUntargetedCanFn();
  return useMemo(
    () =>
      buildNav({ meta, sections, can }).some((item) => item.id === "workers"),
    [meta, sections, can],
  );
}
