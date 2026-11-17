/**
 * The loading state, the bootstrap error, or the app with its loaded meta:
 * what each UI's `MetaProvider` renders around the kit's permission core
 * (`./meta.ts`).
 */
import type { ReactNode } from "react";
import { Spinner } from "./components/Spinner";

/** Props of {@link MetaGate}. */
export interface MetaGateProps<TValue> {
  /** The loaded value, or `null` while it is not. */
  value: TValue | null;
  /** Why loading failed, when it did. */
  error: unknown;
  /** The spinner's label while loading (`Loading the jobs API`). */
  loadingLabel: string;
  /** The bootstrap error, shown when loading failed and nothing is loaded. */
  renderError: (error: unknown) => ReactNode;
  /** The app, once loaded. */
  children: (value: TValue) => ReactNode;
}

/** Renders the loading state, the bootstrap error, or the app with its loaded value. */
export function MetaGate<TValue>({
  value,
  error,
  loadingLabel,
  renderError,
  children,
}: MetaGateProps<TValue>) {
  if (error && value === null) return <>{renderError(error)}</>;
  if (value === null) {
    return (
      <main
        className="bootstrap-screen"
        data-testid="bootstrap-loading"
      >
        <Spinner
          label={loadingLabel}
          showLabel
        />
      </main>
    );
  }
  return <>{children(value)}</>;
}
