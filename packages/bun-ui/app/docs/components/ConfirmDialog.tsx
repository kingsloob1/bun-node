import type { ConfirmDialogProps } from "../../kit/components/ConfirmDialog";
import { ConfirmDialog as KitConfirmDialog } from "../../kit/components/ConfirmDialog";
import { isApiError } from "../api/errors";

export type { ConfirmDialogProps };

/**
 * The kit's yes/no dialog (`app/kit/components/ConfirmDialog.tsx`), its
 * failure recognised as the docs viewer's own `ApiError` (`../api/errors`).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <KitConfirmDialog
      {...props}
      isApiError={isApiError}
    />
  );
}
