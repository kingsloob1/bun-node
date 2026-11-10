import type { ErrorViewProps } from "../../kit/components/ErrorView";
import { ErrorView as KitErrorView } from "../../kit/components/ErrorView";
import { isApiError } from "../api/errors";

export type { ErrorViewProps };

/**
 * The kit's error view (`app/kit/components/ErrorView.tsx`), recognising
 * the jobs UI's own `ApiError` (`../api/errors`).
 */
export function ErrorView(props: ErrorViewProps) {
  return (
    <KitErrorView
      {...props}
      isApiError={isApiError}
    />
  );
}
