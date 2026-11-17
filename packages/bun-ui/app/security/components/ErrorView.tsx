/** The kit's error view, recognising this app's `ApiError`. */
import type { ErrorViewProps as KitErrorViewProps } from "../../kit/components/ErrorView";
import { ErrorView as KitErrorView } from "../../kit/components/ErrorView";
import { isApiError } from "../api/errors";

/** Props of {@link ErrorView}. */
export type ErrorViewProps = Omit<KitErrorViewProps, "isApiError">;

/** Shows a failure. */
export function ErrorView(props: ErrorViewProps) {
  return (
    <KitErrorView
      {...props}
      isApiError={isApiError}
    />
  );
}
