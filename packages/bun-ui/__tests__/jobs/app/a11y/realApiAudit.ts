import type { FetchLike } from "../../../app/api/client";
import { visit, waitFor } from "../dom";
import { renderApp } from "../renderApp";
import { auditDocument, formatFindings } from "./audit";

/**
 * Renders one route of the app over `fetch` and audits it, for
 * `pkg/a11y.integration.test.ts`, which runs the screens against a REAL
 * `createJobsApi`. That test compiles without the DOM lib, so everything
 * touching the DOM lives here and the test loads it by a dynamic import.
 */

/** Renders `path` (under `/jobs`), waits for `ready` and for every spinner to go, audits, and unmounts. */
export async function auditRoute(
  path: string,
  fetch: FetchLike,
  ready: string,
): Promise<string[]> {
  visit(`/jobs${path}`);
  const rendered = renderApp({ fetch });
  await waitFor(
    () => {
      if (!document.querySelector(ready)) {
        throw new Error(`${path}: no ${ready} yet`);
      }
      if (document.querySelector(".spinner-wrap")) {
        throw new Error(`${path}: still loading`);
      }
    },
    { timeout: 5_000 },
  );
  const findings = formatFindings(auditDocument());
  rendered.unmount();
  return findings;
}
