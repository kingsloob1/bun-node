/**
 * Helpers for `securityUi()`'s server tests: the UI over the docs tests'
 * fixture bundle (no real build), a real `createSecurityApi()` to mount it
 * beside, and the shell parser.
 */
import type {
  SecurityApi,
  SecurityApiOptions,
} from "@kingsleyweb/bun-security/control";
import type { SecurityUiConfig } from "../../../lib/security/browser/config";
import type { SecurityUiInternals } from "../../../lib/security/securityUi";
import type {
  SecurityUi,
  SecurityUiOptions,
} from "../../../lib/security/types";
import { generateKeyPairSync } from "node:crypto";
import { noopLogger } from "@kingsleyweb/bun-common";
import { createSecurityApi } from "@kingsleyweb/bun-security/control";
import { memoryStore } from "@kingsleyweb/bun-security/store";
import { SECURITY_UI_CONFIG_ELEMENT_ID } from "../../../lib/security/browser/config";
import { createSecurityUi } from "../../../lib/security/securityUi";
import { FIXTURE_ENTRY, NO_DIST } from "../../docs/server/helpers";

export { cspNonce, parseCsp } from "../../docs/server/helpers";
export { FIXTURE_ENTRY, NO_DIST };

/** The UI over the fixture bundle, against an API at `/security/api` unless the options say otherwise. */
export function fixtureSecurityUi(
  options: Partial<SecurityUiOptions> = {},
  internals: SecurityUiInternals = {},
): SecurityUi {
  const merged = { logger: noopLogger, ...options } as SecurityUiOptions;
  if (merged.api === undefined && merged.apiUrl === undefined) {
    (merged as { apiUrl?: string }).apiUrl = "/security/api";
  }
  return createSecurityUi(merged, {
    entry: FIXTURE_ENTRY,
    distDir: NO_DIST,
    ...internals,
  });
}

/** Every API {@link memorySecurityApi} made and {@link closeSecurityApis} has not closed. */
const opened = new Set<SecurityApi>();

/** Closes every API {@link memorySecurityApi} made: its live hub and what it runs by itself (the bundle repair). Call it in `afterAll`. */
export function closeSecurityApis(): void {
  for (const api of opened) {
    api.live.close();
    api.close();
  }
  opened.clear();
}

/** A real security API on a memory store; `withBreakGlass` adds the account. Close it with {@link closeSecurityApis}. */
export async function memorySecurityApi(
  options: { withBreakGlass?: boolean } & Partial<SecurityApiOptions> = {},
): Promise<SecurityApi> {
  const { withBreakGlass, ...rest } = options;
  const api = createSecurityApi({
    store: memoryStore(),
    authenticate: () => ({ id: "op" }),
    owners: ["op"],
    allowWithoutStepUp: true,
    signing: {
      keyId: "sk_t",
      privateKey: generateKeyPairSync("ed25519").privateKey,
    },
    audit: {
      signing: {
        keyId: "ak_t",
        privateKey: generateKeyPairSync("ed25519").privateKey,
      },
      allowNoExternalCheckpoints: true,
    },
    bans: { secret: "security-ui-test-fleet-secret-0123456789" },
    ...(withBreakGlass === true
      ? {
          breakGlass: {
            passwordHash: await Bun.password.hash("pw", {
              algorithm: "argon2id",
              memoryCost: 4096,
              timeCost: 1,
            }),
            totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
          },
        }
      : {}),
    basePath: "/security/api",
    logger: () => {},
    ...rest,
  });
  opened.add(api);
  return api;
}

/** What a shell page references. */
export interface ParsedSecurityShell {
  /** The `<title>` text. */
  title: string;
  /** The injected config. */
  config: SecurityUiConfig;
  /** The config `<script>`'s nonce. */
  configNonce: string;
  /** The module `<script>`'s `src`, `integrity` and `nonce`. */
  script: { src: string; integrity: string; nonce: string };
  /** Every stylesheet `<link>`. */
  styles: { href: string; integrity: string }[];
}

/** One attribute's value in a tag's source. */
function attribute(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
}

/** Parses the shell. */
export function parseSecurityShell(html: string): ParsedSecurityShell {
  const configMatch = new RegExp(
    `(<script type="application/json" id="${SECURITY_UI_CONFIG_ELEMENT_ID}"[^>]*>)([\\s\\S]*?)</script>`,
  ).exec(html);
  if (!configMatch) throw new Error("no config script in the shell");
  const scriptTag = /<script type="module"[^>]*>/.exec(html)?.[0] ?? "";
  return {
    title: /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "",
    config: JSON.parse(configMatch[2]!) as SecurityUiConfig,
    configNonce: attribute(configMatch[1]!, "nonce"),
    script: {
      src: attribute(scriptTag, "src"),
      integrity: attribute(scriptTag, "integrity"),
      nonce: attribute(scriptTag, "nonce"),
    },
    styles: [...html.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(
      ([tag]) => ({
        href: attribute(tag, "href"),
        integrity: attribute(tag, "integrity"),
      }),
    ),
  };
}

/** Fetches the shell at `path` and parses it. */
export async function fetchSecurityShell(
  target: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  path: string,
): Promise<{ response: Response; shell: ParsedSecurityShell; html: string }> {
  const response = await target.fetch(path);
  const html = await response.text();
  return { response, shell: parseSecurityShell(html), html };
}
