/**
 * HTTP, declared through the core (plan §4.1.1): one request shape, and
 * responses keyed by status, each with headers, cookies and a body keyed by
 * media type. `validate()` builds its contracts on it.
 *
 * The inbound parts are listed in the order BunValidate checks them
 * (headers first, so a cheap header check fails before a body is read);
 * `cookies` and `signedCookies` are declared for V2, which adds them as
 * `validate()` targets.
 */
import { defineTransport } from "./transport";

/**
 * The HTTP transport. Its exported name is not approved (internal); reach a
 * validator's contract with `getContract(middleware)`.
 *
 * @internal
 */
export const httpTransport = defineTransport({
  name: "http",
  wire: "json",
  inbound: {
    parts: ["headers", "cookies", "signedCookies", "params", "query", "body"],
    media: ["body"],
    encodings: {
      headers: "header-string",
      cookies: "cookie-string",
      signedCookies: "signed-cookie",
      params: "path-string",
      query: "querystring",
      body: "body",
    },
  },
  outbound: {
    key: "status",
    parts: ["headers", "cookies", "body"],
    media: ["body"],
    encodings: {
      headers: "header-string",
      cookies: "set-cookie",
      body: "body",
    },
  },
});
