import type { ReactNode } from "react";
import { createContext, use } from "react";

/** How a toast reads: its colour, its live-region politeness and its default lifetime. */
export type ToastKind = "success" | "error" | "info";

/** A button on a toast, e.g. "Undo" or "View job". */
export interface ToastAction {
  /** The button's text. */
  label: string;
  /** What it does. The toast dismisses itself afterwards. */
  onClick: () => void;
}

/** Options of one toast. */
export interface ToastOptions {
  /** A second line under the message. */
  description?: ReactNode;
  /** One action button. */
  action?: ToastAction;
  /** Lifetime in ms; `0` keeps it until dismissed. Defaults to {@link TOAST_DURATION_MS} for the kind. */
  duration?: number;
}

/** Default lifetimes per kind, ms: errors stay twice as long, to be read. */
export const TOAST_DURATION_MS: Readonly<Record<ToastKind, number>> = {
  success: 5_000,
  info: 5_000,
  error: 10_000,
};

/** Most toasts on screen; a new one pushes out the oldest. */
export const MAX_TOASTS = 5;

/** One toast as the provider holds it. */
export interface ToastRecord extends ToastOptions {
  /** Unique id, for {@link ToastApi.dismiss}. */
  id: string;
  /** Its kind. */
  kind: ToastKind;
  /** The headline. */
  message: ReactNode;
}

/** Shows one toast of a fixed kind; returns its id. */
export type ShowToast = (message: ReactNode, options?: ToastOptions) => string;

/** What {@link useToast} returns. */
export interface ToastApi {
  /** A success toast: polite, auto-dismisses after 5 s. */
  success: ShowToast;
  /** An error toast: assertive, auto-dismisses after 10 s. */
  error: ShowToast;
  /** A neutral toast: polite, auto-dismisses after 5 s. */
  info: ShowToast;
  /** Removes a toast early. */
  dismiss: (id: string) => void;
}

/** Carries the toast API; `null` outside a `ToastProvider`. */
export const ToastContext = createContext<ToastApi | null>(null);

/** Shows toasts. Needs a `ToastProvider` above (the app has one in `AppProviders`). */
export function useToast(): ToastApi {
  const api = use(ToastContext);
  if (!api) {
    throw new Error("useToast must be used inside a <ToastProvider>");
  }
  return api;
}
