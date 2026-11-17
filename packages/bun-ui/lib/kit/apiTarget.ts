/**
 * Where a UI's API is, as the browser will reach it (moved from `jobsUi()`
 * for the security UI, PR-U1): `apiUrl` checked, a same-origin absolute
 * path or an `http(s)` URL, with each UI's own `ConfigError` (`fail`).
 */
import type { ConfigFail } from "./options";
import { normalizeMountPath } from "./options";

/** Whether `path` is `base` or lies under it, segment-wise. */
export function isWithinPath(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Where the API is, as the browser will reach it. */
export interface ResolvedApiTarget {
  /** The config's `apiBase`. */
  apiBase: string;
  /** The API's same-origin path, when known: requests under it are left to the API. */
  apiPath: string | undefined;
  /** The API's origin when it is a URL (`"https://api.example"`), else `undefined`. */
  apiOrigin: string | undefined;
}

/**
 * The raw parts of an `http(s)://` URL as written, before `new URL()`
 * normalises them: the authority and the path (up to any `?` or `#`).
 * `undefined` when the string does not start with an `http(s)://` authority.
 */
const RAW_HTTP_URL = /^https?:\/\/([^/?#]*)([^?#]*)/i;

/** Refuses a query or fragment in `apiUrl` with a message naming which. */
function refuseQueryOrFragment(apiUrl: string, fail: ConfigFail): void {
  const query = apiUrl.indexOf("?");
  const hash = apiUrl.indexOf("#");
  if (query !== -1 && (hash === -1 || query < hash)) {
    throw fail("apiUrl may not carry a query", { apiUrl });
  }
  if (hash !== -1) {
    throw fail("apiUrl may not carry a fragment", { apiUrl });
  }
}

/**
 * Resolves `apiUrl`: a same-origin absolute path or an `http(s)` URL.
 *
 * The URL form's path obeys the path form's segment rules. They are checked
 * on the **raw** string, because `new URL()` has already resolved `..`,
 * percent-encoded a space and turned `` into `/` — `http://h/a/../b` would
 * otherwise quietly become `http://h/b`. The raw path is validated with
 * `normalizeMountPath`, then compared with the parsed `pathname`: any
 * difference means the parser rewrote something the rules did not see, and
 * is refused too. An empty or `"/"` path is the API at the origin root.
 */
export function resolveApiTarget(
  apiUrl: unknown,
  fail: ConfigFail,
): ResolvedApiTarget {
  if (typeof apiUrl !== "string" || apiUrl === "") {
    throw fail("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  if (apiUrl.startsWith("/") && !apiUrl.startsWith("//")) {
    refuseQueryOrFragment(apiUrl, fail);
    const path = normalizeMountPath(apiUrl, "apiUrl", "UI", fail);
    return { apiBase: path, apiPath: path, apiOrigin: undefined };
  }
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw fail("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fail("apiUrl must use http: or https:", { apiUrl });
  }
  const raw = RAW_HTTP_URL.exec(apiUrl);
  if (raw === null) {
    throw fail("apiUrl must be an absolute path or an http(s) URL", {
      apiUrl,
    });
  }
  refuseQueryOrFragment(apiUrl, fail);
  const [, authority = "", rawPath = ""] = raw;
  if (authority.includes("@") || url.username !== "" || url.password !== "") {
    throw fail("apiUrl may not carry credentials", { apiUrl });
  }
  const path = /^\/*$/.test(rawPath)
    ? ""
    : normalizeMountPath(rawPath, "apiUrl", "UI", fail);
  if (url.pathname.replace(/\/+$/, "") !== path) {
    throw fail(
      `apiUrl may only contain "/"-separated segments of letters, digits, "_", ".", "~" and "-"`,
      { apiUrl },
    );
  }
  return {
    apiBase: `${url.origin}${path}`,
    apiPath: undefined,
    apiOrigin: url.origin,
  };
}
