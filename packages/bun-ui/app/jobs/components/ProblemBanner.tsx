import type { ProblemBannerProps } from "../../kit/components/ProblemBanner";
import { ProblemBanner as KitProblemBanner } from "../../kit/components/ProblemBanner";
import { isApiError } from "../api/errors";

export type { ProblemBannerProps };

/**
 * The kit's inline error (`app/kit/components/ProblemBanner.tsx`),
 * recognising the jobs UI's own `ApiError` (`../api/errors`).
 */
export function ProblemBanner(props: ProblemBannerProps) {
  return (
    <KitProblemBanner
      {...props}
      isApiError={isApiError}
    />
  );
}
