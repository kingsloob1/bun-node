/**
 * The managed probe set (layers.md L7): a small, conservative set of rules
 * for the scanning a public service sees every day (ConcaveHR's `.env`,
 * `.git`, `wp-admin` and `phpmyadmin` probes, plan §12), written in the
 * rule language like an operator's. Off unless the policy turns it on,
 * then in dry run unless it says `enforce`. A probe of a path is answered
 * `404` (nothing to see), a scanner `403`. A verified crawler (PR-S12) is
 * never refused by it: its hits are logged as `crawler.probe`.
 */
import type { ManagedRuleId, RequestRule } from "./types";

/** The scanners' own `User-Agent` tokens: names no browser or ordinary client sends. */
export const SCANNER_AGENTS: readonly string[] = Object.freeze([
  "sqlmap",
  "nikto",
  "nmap",
  "masscan",
  "zgrab",
  "nuclei",
  "wpscan",
  "dirbuster",
  "gobuster",
  "feroxbuster",
  "ffuf",
  "acunetix",
  "nessus",
  "openvas",
  "w3af",
  "havij",
]);

/** A `404` probe rule over path globs. */
function pathProbe(id: ManagedRuleId, globs: readonly string[]): RequestRule {
  return {
    id,
    when: { any: globs.map((glob) => ({ path: { glob } })) },
    action: "block",
    status: 404,
    code: "not_found",
    crawlers: "skip",
  };
}

/** The set, by id, in the order they run. */
export const MANAGED_RULES: ReadonlyMap<ManagedRuleId, RequestRule> = new Map<
  ManagedRuleId,
  RequestRule
>([
  ["dotenv", pathProbe("dotenv", ["/**/.env", "/**/.env.*"])],
  [
    "vcs",
    pathProbe("vcs", [
      "/**/.git",
      "/**/.git/**",
      "/**/.svn",
      "/**/.svn/**",
      "/**/.hg",
      "/**/.hg/**",
    ]),
  ],
  [
    "wordpress",
    pathProbe("wordpress", [
      "/**/wp-admin",
      "/**/wp-admin/**",
      "/**/wp-login.php",
      "/**/xmlrpc.php",
    ]),
  ],
  [
    "phpmyadmin",
    pathProbe("phpmyadmin", ["/**/phpmyadmin", "/**/phpmyadmin/**"]),
  ],
  ["cgi-bin", pathProbe("cgi-bin", ["/cgi-bin", "/cgi-bin/**"])],
  ["actuator", pathProbe("actuator", ["/actuator", "/actuator/**"])],
  [
    "scanner-agents",
    {
      id: "scanner-agents",
      when: {
        any: SCANNER_AGENTS.map((agent) => ({
          header: "user-agent",
          contains: agent,
          ignoreCase: true,
        })),
      },
      action: "block",
      crawlers: "skip",
    },
  ],
  [
    "header-control-chars",
    {
      id: "header-control-chars",
      when: {
        any: [
          { anyHeader: { contains: "\u0000" } },
          { anyHeader: { contains: "\r" } },
          { anyHeader: { contains: "\n" } },
        ],
      },
      action: "block",
      status: 400,
      code: "rejected",
      crawlers: "skip",
    },
  ],
  [
    "oversized-cookie",
    {
      id: "oversized-cookie",
      when: { header: "cookie", length: { gt: 8192 } },
      action: "block",
      status: 431,
      code: "rejected",
      crawlers: "skip",
    },
  ],
]);

/** Every id of the managed set. */
export const MANAGED_RULE_IDS: readonly ManagedRuleId[] = Object.freeze([
  ...MANAGED_RULES.keys(),
]);
