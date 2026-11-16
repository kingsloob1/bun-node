/**
 * The challenge page's policy and markup (layers.md L10.2): nothing by
 * default, scripts by nonce and the provider's script origins only, frames
 * and connections to the provider alone, forms to this origin; every value
 * the page shows escaped.
 */
import { describe, expect, it } from "bun:test";
import { hcaptcha, turnstile } from "../../lib/challenge/captcha";
import {
  challengeCsp,
  challengePage,
  escapeHtml,
} from "../../lib/challenge/page";
import { powChallenge } from "../../lib/challenge/pow";
import type { ChallengeContext } from "../../lib/challenge/types";

const CONTEXT: ChallengeContext = {
  client: "203.0.113.10",
  risk: 0,
  hostname: "app.test",
};

/** A policy as directive → sources. */
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split("; ").map((part) => {
      const [name = "", ...sources] = part.split(" ");
      return [name, sources];
    }),
  );
}

describe("challengeCsp", () => {
  it("allows the proof of work its nonce alone: no frame, no third party", async () => {
    const descriptor = await powChallenge({ secret: "p".repeat(32) }).issue(
      CONTEXT,
    );
    expect(directives(challengeCsp(descriptor, "N0nce"))).toEqual({
      "default-src": ["'none'"],
      "script-src": ["'nonce-N0nce'"],
      "style-src": ["'nonce-N0nce'"],
      "frame-src": ["'none'"],
      "connect-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "form-action": ["'self'"],
      "base-uri": ["'none'"],
      "frame-ancestors": ["'none'"],
    });
  });

  it("allows Turnstile its own origin only", async () => {
    const descriptor = await turnstile({ siteKey: "k", secret: "s" }).issue(
      CONTEXT,
    );
    const policy = directives(challengeCsp(descriptor, "n"));
    expect(policy["script-src"]).toEqual([
      "'nonce-n'",
      "https://challenges.cloudflare.com",
    ]);
    expect(policy["frame-src"]).toEqual(["https://challenges.cloudflare.com"]);
    expect(policy["connect-src"]).toEqual([
      "'self'",
      "https://challenges.cloudflare.com",
    ]);
    expect(policy["default-src"]).toEqual(["'none'"]);
  });

  it("allows hCaptcha its origins", async () => {
    const descriptor = await hcaptcha({ siteKey: "k", secret: "s" }).issue(
      CONTEXT,
    );
    const policy = directives(challengeCsp(descriptor, "n"));
    expect(policy["script-src"]).toEqual([
      "'nonce-n'",
      "https://js.hcaptcha.com",
    ]);
    expect(policy["frame-src"]).toContain("https://*.hcaptcha.com");
    expect(policy["style-src"]).toContain("https://hcaptcha.com");
  });

  it("takes no source from a script URL that is not absolute http(s)", () => {
    const csp = challengeCsp(
      {
        provider: "x",
        field: "f",
        html: "",
        scripts: ["javascript:alert(1)", "/local.js"],
      },
      "n",
    );
    expect(directives(csp)["script-src"]).toEqual(["'nonce-n'"]);
  });
});

describe("challengePage", () => {
  it("escapes its title, notice, action and return path", async () => {
    const response = challengePage(
      { provider: "x", field: "f", html: "" },
      {
        action: '/a"b',
        returnTo: '/x"><script>',
        title: "<T>",
        notice: "<N>",
        status: 403,
      },
    );
    const html = await response.text();
    expect(html).toContain("<title>&lt;T&gt;</title>");
    expect(html).toContain('<p role="alert">&lt;N&gt;</p>');
    expect(html).toContain('action="/a&quot;b"');
    expect(html).toContain('value="/x&quot;&gt;&lt;script&gt;"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("uses a fresh nonce per page", () => {
    const descriptor = { provider: "x", field: "f", html: "" };
    const options = { action: "/c", returnTo: "/", title: "t", status: 403 };
    const nonce = (r: Response) =>
      /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy")!)![1];
    expect(nonce(challengePage(descriptor, options))).not.toBe(
      nonce(challengePage(descriptor, options)),
    );
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
