/**
 * Screens loaded on demand, shared by every UI's app (moved from the jobs
 * app for the security UI, PR-U1). Each screen's code (and its stylesheet)
 * is a chunk the bundler splits off, so the first load carries only the
 * shell and the landing screen.
 */
import type { ComponentType, LazyExoticComponent } from "react";
import { lazy, Suspense } from "react";
import { Spinner } from "./components/Spinner";

/**
 * Wraps a lazily imported screen in a Suspense boundary with a labelled
 * spinner. A chunk that fails to load (a network blip, a redeploy) throws to
 * the route's `ScreenErrorBoundary`; `React.lazy` would keep that rejection
 * for good, so a failed load swaps in a fresh `lazy()` and "Reload this
 * screen" really fetches the chunk again.
 */
export function onDemand<TProps extends object = Record<string, never>>(
  load: () => Promise<ComponentType<TProps>>,
  label: string,
): ComponentType<TProps> {
  let Screen: LazyExoticComponent<ComponentType<TProps>>;
  const create = () =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch (error) {
        Screen = create();
        throw error;
      }
    });
  Screen = create();
  function OnDemand(props: TProps) {
    return (
      <Suspense
        fallback={
          <Spinner
            label={label}
            showLabel
          />
        }
      >
        <Screen {...props} />
      </Suspense>
    );
  }
  return OnDemand;
}
