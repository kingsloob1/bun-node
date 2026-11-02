/**
 * The browser-safety test's negative control: an entry that reaches the
 * contract core and one server module, as a stray import would. Never
 * imported by the package.
 */
import { join } from "node:path";
import { defineTransport } from "../../lib/index";

/** A transport, so the core is in the bundle beside the server code. */
export const transport = defineTransport({
  name: "fixture",
  inbound: { parts: ["data"] },
});

/** Uses the Node API, so the bundler keeps it. */
export const where = join("a", Bun.version);
