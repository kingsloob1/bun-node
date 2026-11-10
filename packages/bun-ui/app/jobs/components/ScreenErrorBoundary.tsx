import type { ScreenErrorBoundaryProps } from "../../kit/components/ScreenErrorBoundary";
import { ScreenErrorBoundary as KitScreenErrorBoundary } from "../../kit/components/ScreenErrorBoundary";
import { resetScreenQueries } from "../queryClient";

export type { ScreenErrorBoundaryProps };

/**
 * The kit's screen error boundary
 * (`app/kit/components/ScreenErrorBoundary.tsx`), resetting a crashed
 * screen's queries the way the jobs UI does (`resetScreenQueries`).
 */
export function ScreenErrorBoundary(props: ScreenErrorBoundaryProps) {
  return (
    <KitScreenErrorBoundary
      {...props}
      resetQueries={resetScreenQueries}
    />
  );
}
