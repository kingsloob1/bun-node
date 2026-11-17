// The negative control for the bundle-safety test: a value import of the
// security API's server side, which a browser bundle must never carry.
import { createSecurityApi } from "@kingsleyweb/bun-security/control";

export const leaked = createSecurityApi;
