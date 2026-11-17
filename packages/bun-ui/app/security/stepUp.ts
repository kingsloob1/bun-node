/**
 * Step-up (the user's decision, PR-U1): an action the API answers
 * `401 step_up_required` opens the host's `stepUpUrl` in a popup and is
 * retried **once** when the host's page signals it is done:
 *
 * ```js
 * window.opener.postMessage({ type: "bun-security:step-up", ok: true }, "<the UI's origin>");
 * window.close();
 * ```
 *
 * The message is accepted only from the step-up page's origin. A popup
 * closed without it (cancelled, failed) retries nothing: the action's
 * `step_up_required` error stands.
 */
import { isApiError } from "./api/errors";

/** The message the host's step-up page posts to the opener. */
export const STEP_UP_MESSAGE_TYPE = "bun-security:step-up";

/** The window calls step-up needs (tests pass a fake). */
export interface StepUpWindow {
  /** Opens the popup. */
  readonly open: (
    url: string,
    target: string,
    features: string,
  ) => { readonly closed: boolean } | null;
  /** Listens for the page's message. */
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void,
  ) => void;
  /** Stops listening. */
  readonly removeEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void,
  ) => void;
  /** Where relative URLs resolve. */
  readonly location: { readonly href: string };
}

/** How often a popup is checked for having closed, ms. */
const CLOSED_POLL_MS = 250;

/**
 * Opens the step-up page and resolves `true` when it signals `ok`, `false`
 * when it closes (or fails to open) without doing so.
 */
export function awaitStepUp(
  stepUpUrl: string,
  win: StepUpWindow = window,
): Promise<boolean> {
  const url = new URL(stepUpUrl, win.location.href);
  const popup = win.open(
    url.href,
    "bun-security-step-up",
    "popup,width=480,height=640",
  );
  if (popup === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    let finish: (ok: boolean) => void = () => {};
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; ok?: unknown } | null;
      if (event.origin !== url.origin || data?.type !== STEP_UP_MESSAGE_TYPE)
        return;
      finish(data.ok === true);
    };
    const timer = setInterval(() => {
      if (popup.closed) finish(false);
    }, CLOSED_POLL_MS);
    finish = (ok: boolean) => {
      win.removeEventListener("message", onMessage);
      clearInterval(timer);
      resolve(ok);
    };
    win.addEventListener("message", onMessage);
  });
}

/** Runs `action`; on `step_up_required`, steps up and runs it once more. */
export async function withStepUp<T>(
  action: () => Promise<T>,
  win?: StepUpWindow,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const url = isApiError(error) ? error.stepUpUrl : undefined;
    if (url === undefined) throw error;
    if (!(await awaitStepUp(url, win))) throw error;
    return await action();
  }
}
