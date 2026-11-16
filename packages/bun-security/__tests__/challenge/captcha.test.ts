/**
 * Turnstile and hCaptcha (layers.md L10.2), verified against a fake
 * verifier: no call leaves the machine. An injected `fetch` records what
 * the adapters post and answers as the providers' `siteverify` does; one
 * case points `verifyUrl` at a local `Bun.serve` fake instead, through the
 * real global `fetch`.
 */
import { ConfigError } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { hcaptcha, turnstile } from "../../lib/challenge/captcha";
import type { VerifyFetch } from "../../lib/challenge/captcha";
import type { ChallengeContext } from "../../lib/challenge/types";

const CONTEXT: ChallengeContext = {
  client: "203.0.113.10",
  risk: 0,
  hostname: "app.test",
};

/** A posted verification, as the fake saw it. */
interface Posted {
  url: string;
  method: string;
  form: Record<string, string>;
}

/** A fake verifier answering `answer` (or failing with it), recording each post. */
function fakeVerifier(answer: unknown | Error, status = 200) {
  const posted: Posted[] = [];
  const fetch: VerifyFetch = (url, init) => {
    posted.push({
      url,
      method: init.method,
      form: Object.fromEntries(init.body),
    });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(Response.json(answer, { status }));
  };
  return { fetch, posted };
}

describe.each([
  {
    name: "turnstile",
    make: turnstile,
    field: "cf-turnstile-response",
    url: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    script: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    widget: 'class="cf-turnstile"',
  },
  {
    name: "hcaptcha",
    make: hcaptcha,
    field: "h-captcha-response",
    url: "https://api.hcaptcha.com/siteverify",
    script: "https://js.hcaptcha.com/1/api.js",
    widget: 'class="h-captcha"',
  },
])("$name", ({ name, make, field, url, script, widget }) => {
  it("issues its widget, script and origins", async () => {
    const provider = make({ siteKey: 'site"key', secret: "s3cret" });
    expect(provider.id).toBe(name);
    expect(provider.field).toBe(field);
    const descriptor = await provider.issue(CONTEXT);
    expect(descriptor.field).toBe(field);
    expect(descriptor.scripts).toEqual([script]);
    expect(descriptor.html).toContain(widget);
    // The site key is escaped into the attribute; the secret never appears.
    expect(descriptor.html).toContain('data-sitekey="site&quot;key"');
    expect(JSON.stringify(descriptor)).not.toContain("s3cret");
    expect(descriptor.origins?.frame?.length).toBeGreaterThan(0);
  });

  it("posts the secret, the token and the client's address, and passes a success on this host", async () => {
    const fake = fakeVerifier({ success: true, hostname: "app.test" });
    const provider = make({
      siteKey: "site",
      secret: "s3cret",
      fetch: fake.fetch,
    });
    expect(await provider.verify("token-1", CONTEXT)).toEqual({ ok: true });
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0]!.url).toBe(url);
    expect(fake.posted[0]!.method).toBe("POST");
    expect(fake.posted[0]!.form).toMatchObject({
      secret: "s3cret",
      response: "token-1",
      remoteip: "203.0.113.10",
    });
    if (name === "hcaptcha") expect(fake.posted[0]!.form.sitekey).toBe("site");
  });

  it("refuses an unsuccessful token, with the provider's error codes", async () => {
    const fake = fakeVerifier({
      success: false,
      "error-codes": ["timeout-or-duplicate"],
    });
    const provider = make({ siteKey: "site", secret: "s", fetch: fake.fetch });
    expect(await provider.verify("token", CONTEXT)).toEqual({
      ok: false,
      reason: 'rejected: ["timeout-or-duplicate"]',
    });
  });

  it("refuses a token solved on another host, and passes one on a listed host", async () => {
    const fake = fakeVerifier({ success: true, hostname: "evil.test" });
    const provider = make({ siteKey: "site", secret: "s", fetch: fake.fetch });
    expect((await provider.verify("token", CONTEXT)).ok).toBe(false);
    const listed = make({
      siteKey: "site",
      secret: "s",
      fetch: fake.fetch,
      hostnames: ["evil.test"],
    });
    expect((await listed.verify("token", CONTEXT)).ok).toBe(true);
    // No hostname in the answer at all: refused.
    const none = make({
      siteKey: "site",
      secret: "s",
      fetch: fakeVerifier({ success: true }).fetch,
    });
    expect((await none.verify("token", CONTEXT)).ok).toBe(false);
  });

  it("checks the action when one is set", async () => {
    const provider = make({
      siteKey: "site",
      secret: "s",
      action: "login",
      fetch: fakeVerifier({
        success: true,
        hostname: "app.test",
        action: "signup",
      }).fetch,
    });
    expect(await provider.verify("token", CONTEXT)).toEqual({
      ok: false,
      reason: "for another action: signup",
    });
    const right = make({
      siteKey: "site",
      secret: "s",
      action: "login",
      fetch: fakeVerifier({
        success: true,
        hostname: "app.test",
        action: "login",
      }).fetch,
    });
    expect((await right.verify("token", CONTEXT)).ok).toBe(true);
  });

  it("fails closed on a network error, a non-200 answer, a timeout and an empty token", async () => {
    const down = make({
      siteKey: "site",
      secret: "s",
      fetch: fakeVerifier(new Error("ECONNREFUSED")).fetch,
    });
    expect(await down.verify("token", CONTEXT)).toEqual({
      ok: false,
      reason: "verification failed: ECONNREFUSED",
    });
    const broken = make({
      siteKey: "site",
      secret: "s",
      fetch: fakeVerifier({ success: true, hostname: "app.test" }, 502).fetch,
    });
    expect((await broken.verify("token", CONTEXT)).reason).toBe(
      "verify endpoint answered 502",
    );
    const slow = make({
      siteKey: "site",
      secret: "s",
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted", { cause: init.signal.reason })),
          );
        }),
    });
    const timedOut = await slow.verify("token", CONTEXT);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.reason).toStartWith("verification failed:");
    const fake = fakeVerifier({ success: true, hostname: "app.test" });
    const empty = make({ siteKey: "site", secret: "s", fetch: fake.fetch });
    expect((await empty.verify("", CONTEXT)).ok).toBe(false);
    expect((await empty.verify("x".repeat(5000), CONTEXT)).ok).toBe(false);
    expect(fake.posted).toHaveLength(0);
  });

  it("needs a site key and a secret", () => {
    expect(() => make({ siteKey: "", secret: "s" })).toThrow(ConfigError);
    expect(() => make({ siteKey: "k", secret: "" })).toThrow(
      /secret is required/,
    );
  });
});

describe("a hosted CAPTCHA against a local fake siteverify, through the real fetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: Record<string, string>[] = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const form = Object.fromEntries(
          new URLSearchParams(await request.text()),
        );
        seen.push(form);
        return Response.json(
          form.response === "good"
            ? { success: true, hostname: "app.test", action: "login" }
            : { success: false, "error-codes": ["invalid-input-response"] },
        );
      },
    });
  });
  afterAll(() => server.stop(true));

  it("verifies a good token and refuses a bad one", async () => {
    const provider = turnstile({
      siteKey: "site",
      secret: "s3cret",
      action: "login",
      verifyUrl: `http://127.0.0.1:${server.port}/siteverify`,
    });
    expect(await provider.verify("good", CONTEXT)).toEqual({ ok: true });
    expect((await provider.verify("bad", CONTEXT)).ok).toBe(false);
    expect(seen.map((form) => form.response)).toEqual(["good", "bad"]);
    expect(seen[0]!.secret).toBe("s3cret");
  });
});
