/**
 * A pretend sign-in for trying the `unauthorized` option by hand: bun-jobs-ui's
 * (`/jobs`) and bun-api-docs-ui's (the `docsUi()` viewers at
 * `/playground/api-docs` and `/playground/ws-docs`).
 *
 * The playground stays open by default: everyone is "signed in". Visiting
 * `/playground/sign-out` sets a cookie that makes the UI's and the API's
 * `authorize` answer 401, which is what an expired session looks like. Then:
 *
 * - open any `/jobs` page: the shell answers `303` to
 *   `/playground/sign-in?returnTo=<that page>`;
 * - or, with `/jobs` already open in another tab, sign out from this one
 *   (`/playground/sign-out?stay=1` keeps you here), go back and click
 *   anything: the app's first refused read sends the browser to sign in,
 *   carrying the page it was on.
 *
 * "Sign in" clears the cookie and goes back to `returnTo`, after checking it
 * is a path on this host, as a real sign-in page must.
 */
import type { BunHttpAdapter, BunRequest } from "@kingsleyweb/bun-common";
import type { DocsUiUnauthorizedOptions } from "@kingsleyweb/bun-api-docs-ui";

/** The cookie that marks this browser as signed out. */
const SIGNED_OUT_COOKIE = "playground-signed-out";

/** The sign-in page's path. */
export const SIGN_IN_PATH = "/playground/sign-in";

/** The sign-out link's path. */
export const SIGN_OUT_PATH = "/playground/sign-out";

/** The `unauthorized` option of `jobsUi()` and both `docsUi()` viewers: to the sign-in page, carrying `returnTo`. */
export const playgroundUnauthorized: DocsUiUnauthorizedOptions = {
  redirectTo: SIGN_IN_PATH,
};

/** Whether the request comes from a browser that signed out. */
export function signedOut(req: BunRequest): boolean {
  return new RegExp(`(?:^|;\\s*)${SIGNED_OUT_COOKIE}=1(?:;|$)`).test(
    req.get("cookie") ?? "",
  );
}

/**
 * The `authorize` the UI and the API share: yes, unless the browser signed
 * out, then 401 (the status `unauthorized` acts on by default).
 */
export function playgroundAuthorize(
  req: BunRequest,
): true | { allow: false; status: 401; reason: string } {
  return signedOut(req)
    ? {
        allow: false,
        status: 401,
        reason: `Signed out: sign in again at ${SIGN_IN_PATH}`,
      }
    : true;
}

/** A `returnTo` that is safe to send the browser to: a path on this host, else `fallback`. */
function localPath(value: string | null, fallback: string): string {
  return value !== null && value.startsWith("/") && !/^[/\\]{2}/.test(value)
    ? value
    : fallback;
}

/** Escapes text for HTML. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The `returnTo` of a request's query. */
function returnToOf(req: BunRequest): string | null {
  return new URL(req.originalUrl, "http://playground").searchParams.get(
    "returnTo",
  );
}

/** Mounts the sign-in page, its submit and the sign-out link on `app`. */
export function mountSignIn(app: BunHttpAdapter, uiBasePath: string): void {
  app
    .get(SIGN_IN_PATH, (req, res) => {
      const back = localPath(returnToOf(req), uiBasePath);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in · bun-node playground</title></head>
<body>
  <h1>Sign in</h1>
  <p>The jobs UI sent you here because your session ended (the playground's
  <code>authorize</code> answered 401). It will bring you back to
  <code>${escapeHtml(back)}</code>.</p>
  <p><a id="sign-in" href="${SIGN_IN_PATH}/submit?returnTo=${encodeURIComponent(back)}">Sign in</a></p>
</body>
</html>`);
    })
    .describe({ hidden: true });
  app
    .get(`${SIGN_IN_PATH}/submit`, (req, res) => {
      res.setHeader(
        "Set-Cookie",
        `${SIGNED_OUT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      );
      res.redirect(303, localPath(returnToOf(req), uiBasePath));
    })
    .describe({ hidden: true });
  app
    .get(SIGN_OUT_PATH, (req, res) => {
      res.setHeader(
        "Set-Cookie",
        `${SIGNED_OUT_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax`,
      );
      const stay = new URL(
        req.originalUrl,
        "http://playground",
      ).searchParams.has("stay");
      if (stay) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(
          `<!doctype html><title>Signed out</title><p>Signed out. Go back to the jobs UI's tab and click anything: it sends you to <a href="${SIGN_IN_PATH}">${SIGN_IN_PATH}</a>.</p>`,
        );
        return;
      }
      res.redirect(303, uiBasePath);
    })
    .describe({ hidden: true });
}
