/**
 * Turnstile and hCaptcha as challenge providers, verified with an injected
 * `fetch`: nothing here reaches Cloudflare or hCaptcha.
 *
 * ```bash
 * bun 10-challenges/captcha-providers.ts
 * ```
 *
 * - `turnstile({ siteKey, secret })` and `hcaptcha({ siteKey, secret })`
 *   verify the widget's token at the provider over `fetch` (injectable, with
 *   a `timeoutMs`), checking `success`, the `hostname` (the request's, or
 *   `hostnames`) and `action` when set. A network failure fails the answer.
 * - The fake below answers as the providers' siteverify endpoints do, so the
 *   example shows what the engine checks, not the provider.
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import { createSecurity } from "@kingsleyweb/bun-security";
import {
  challenges,
  hcaptcha,
  turnstile,
} from "@kingsleyweb/bun-security/challenge";
import type { ChallengeProvider } from "@kingsleyweb/bun-security/challenge";
import { installSecurity } from "@kingsleyweb/bun-security/http";
import { checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("Turnstile and hCaptcha, with a fake verify endpoint");

/** Every verify call the fake received: the URL and the token. */
const calls: { url: string; token: string | null }[] = [];

/**
 * A fake siteverify endpoint: token `good` passes for `localhost`, `wrong-host`
 * passes for another site, `down` is a network failure, anything else fails.
 */
const fakeFetch = (url: string, init: { body: URLSearchParams }) => {
  const token = init.body.get("response");
  calls.push({ url, token });
  if (token === "down") return Promise.reject(new Error("ECONNRESET"));
  const ok = token === "good" || token === "wrong-host";
  return Promise.resolve(
    Response.json({
      success: ok,
      hostname: token === "wrong-host" ? "evil.example" : "localhost",
    }),
  );
};

/** An app whose `/pay` challenges every client, with `provider`. */
async function appWith(provider: ChallengeProvider) {
  const security = createSecurity<BunRequest>({
    policy: {
      requestRules: {
        rules: [
          {
            id: "pay",
            when: { path: { prefix: "/pay" } },
            action: "challenge",
          },
        ],
      },
    },
    challenge: challenges({
      provider,
      secret: "a-clearance-signing-secret-of-32-bytes!",
    }),
    logger: () => {},
  });
  const app = new BunHttpAdapter(0, { logger: () => {} });
  await installSecurity(app, security, { logger: () => {} });
  app.get("/pay", (_req, res) => res.json({ ok: true }));
  return { app, security };
}

/** Posts `token` as the answer; the answer endpoint's status. */
async function answer(app: BunHttpAdapter, token: string) {
  const response = await app.fetch("/__bun-security/challenge", {
    method: "POST",
    remoteAddress: "198.51.100.5",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ answer: token }),
  });
  await response.body?.cancel();
  return response.status;
}

for (const [name, provider] of [
  [
    "turnstile",
    turnstile({
      siteKey: "0x4AAAA-site",
      secret: "0x4AAAA-secret",
      fetch: fakeFetch,
    }),
  ],
  [
    "hcaptcha",
    hcaptcha({
      siteKey: "10000000-site",
      secret: "0x0000-secret",
      fetch: fakeFetch,
    }),
  ],
] as const) {
  step(name);
  const { app, security } = await appWith(provider);
  const asked = await app.fetch("/pay", {
    remoteAddress: "198.51.100.5",
    headers: { accept: "application/json" },
  });
  const problem = (await asked.json()) as {
    code: string;
    challenge: { provider: string; data: unknown };
  };
  show("the challenge", problem.challenge);
  checkEqual(
    "challenge_required, naming the provider",
    [problem.code, problem.challenge.provider],
    ["challenge_required", name],
  );
  checkEqual("a good token passes", await answer(app, "good"), 200);
  checkEqual(
    "a failed token is refused",
    (await answer(app, "bad")) === 200,
    false,
  );
  checkEqual(
    "a token for another hostname is refused",
    (await answer(app, "wrong-host")) === 200,
    false,
  );
  checkEqual(
    "a network failure fails the answer",
    (await answer(app, "down")) === 200,
    false,
  );
  security.close();
}

show(
  "verify calls",
  calls.map((c) => c.url),
);
checkEqual(
  "each provider's own endpoint was asked",
  [...new Set(calls.map((c) => new URL(c.url).hostname))],
  ["challenges.cloudflare.com", "api.hcaptcha.com"],
);

summary();
