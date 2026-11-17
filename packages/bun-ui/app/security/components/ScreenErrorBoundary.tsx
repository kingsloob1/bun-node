/** The kit's screen error boundary, resetting this app's screen queries. */
import type { ScreenErrorBoundaryProps as KitProps } from "../../kit/components/ScreenErrorBoundary";
import { ScreenErrorBoundary as KitScreenErrorBoundary } from "../../kit/components/ScreenErrorBoundary";
import { resetScreenQueries } from "../queryClient";

/** Props of {@link ScreenErrorBoundary}. */
export type ScreenErrorBoundaryProps = Omit<KitProps, "resetQueries">;

/** Catches a screen's render error. */
export function ScreenErrorBoundary(props: ScreenErrorBoundaryProps) {
  return (
    <KitScreenErrorBoundary
      {...props}
      resetQueries={resetScreenQueries}
    />
  );
}
