/**
 * Bot signals (layers.md L10.1): each signal from the headers that show it
 * and not from a real browser's; their weights adding to the decision's
 * risk, logged as one L10 hit; `challengeAt` turning a risky request into
 * a challenge; dry run; the early stage only; and the policy's checks.
 */
import { describe, expect, it } from "bun:test";
import { challenges } from "../../lib/challenge/flow";
import type { Decision } from "../../lib/engine/decision";
import type { RequestFacts } from "../../lib/engine/facts";
import { createSecurity } from "../../lib/engine/security";
import type { Security } from "../../lib/engine/security";
import {
  BOT_SIGNALS,
  botSignalsOf,
  readSignals,
  validateBotSignals,
} from "../../lib/engine/signals";
import { compilePolicy } from "../../lib/policy/compile";
import type { SecurityPolicy } from "../../lib/policy/types";
import { facts } from "../helpers";

const CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** A real Chrome's navigation headers. */
const CHROME_NAVIGATION = {
  "user-agent": CHROME,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140"',
};

/** The signals a request shows under `policy`'s section. */
function signalsOf(
  headers: Record<string, string>,
  policy: SecurityPolicy = { botSignals: {} },
  path = "/",
) {
  const compiled = botSignalsOf(compilePolicy(policy));
  return readSignals(compiled, facts({ headers, path, rawPath: path })).map(
    (s) => s.name,
  );
}

/** `evaluate()`, synchronously. */
function decide(
  security: Security,
  request: RequestFacts,
  stage?: "early" | "route",
): Decision {
  const decision = security.evaluate(request, stage ? { stage } : {});
  if (decision instanceof Promise) throw new Error("expected synchronous");
  return decision;
}

describe("reading the signals", () => {
  it("finds none on a real browser's navigation (negative control for every signal)", () => {
    expect(signalsOf(CHROME_NAVIGATION)).toEqual([]);
    expect(
      signalsOf({
        "user-agent": FIREFOX,
        accept: "text/html",
        "sec-fetch-mode": "navigate",
      }),
    ).toEqual([]);
  });

  it("noUserAgent: none, or blank", () => {
    expect(signalsOf({})).toEqual(["noUserAgent"]);
    expect(signalsOf({ "user-agent": "   " })).toEqual(["noUserAgent"]);
  });

  it("libraryUserAgent: HTTP libraries and command-line tools", () => {
    for (const ua of [
      "curl/8.5.0",
      "Wget/1.21",
      "python-requests/2.32.3",
      "Python-urllib/3.12",
      "Go-http-client/2.0",
      "Java/17.0.2",
      "okhttp/4.12.0",
      "axios/1.7.2",
      "node-fetch/1.0",
      "Scrapy/2.11 (+https://scrapy.org)",
      "libwww-perl/6.72",
    ]) {
      expect(signalsOf({ "user-agent": ua })).toEqual(["libraryUserAgent"]);
    }
    // A library's name inside a browser's is not one.
    expect(
      signalsOf({ ...CHROME_NAVIGATION, "user-agent": `${CHROME} curl/8` }),
    ).toEqual([]);
  });

  it("headlessUserAgent: HeadlessChrome and PhantomJS", () => {
    expect(
      signalsOf({
        ...CHROME_NAVIGATION,
        "user-agent": CHROME.replace("Chrome/", "HeadlessChrome/"),
      }),
    ).toEqual(["headlessUserAgent"]);
    expect(
      signalsOf({
        "user-agent": "Mozilla/5.0 (Unknown) AppleWebKit/538 PhantomJS/2.1.1",
      }),
    ).toEqual(["headlessUserAgent"]);
  });

  it("missingFetchMetadata: a browser's page request without Sec-Fetch-Mode, or any request on a browser-only route", () => {
    const {
      "sec-fetch-mode": _mode,
      "sec-fetch-site": _site,
      ...bare
    } = CHROME_NAVIGATION;
    expect(signalsOf(bare)).toEqual(["missingFetchMetadata"]);
    // An API call (JSON first) without it is not counted…
    const api = { ...bare, accept: "application/json, text/html" };
    expect(signalsOf(api)).toEqual([]);
    // …unless the route is browser-only.
    expect(
      signalsOf(
        api,
        { botSignals: { browserPaths: ["/app/**"] } },
        "/app/settings",
      ),
    ).toEqual(["missingFetchMetadata"]);
    expect(
      signalsOf(api, { botSignals: { browserPaths: ["/app/**"] } }, "/api/x"),
    ).toEqual([]);
  });

  it("clientHintsMismatch: Sec-CH-UA beside a User-Agent that is not Chromium's", () => {
    expect(
      signalsOf({
        "user-agent": FIREFOX,
        accept: "text/html",
        "sec-fetch-mode": "navigate",
        "sec-ch-ua": '"Chromium";v="140"',
      }),
    ).toEqual(["clientHintsMismatch"]);
  });

  it("takes each signal's weight, 0 turning it off", () => {
    const policy = { botSignals: { weights: { libraryUserAgent: 0 } } };
    expect(signalsOf({ "user-agent": "curl/8" }, policy)).toEqual([]);
    const compiled = botSignalsOf(
      compilePolicy({ botSignals: { weights: { noUserAgent: 2.5 } } }),
    );
    expect(readSignals(compiled, facts())).toEqual([
      { name: "noUserAgent", points: 2.5 },
    ]);
  });
});

describe("signals in the engine", () => {
  it("are off without the section: no hit, no risk", () => {
    const decision = decide(createSecurity({ policy: {} }), facts());
    expect(decision).toMatchObject({ action: "allow", risk: 0 });
  });

  it("add to the decision's risk, logged as one L10 hit, refusing nothing by default", () => {
    const security = createSecurity({
      policy: { botSignals: { weights: { headlessUserAgent: 2 } } },
    });
    const decision = decide(
      security,
      facts({
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11) AppleWebKit/537.36 HeadlessChrome/140",
        },
      }),
    );
    expect(decision.action).toBe("log");
    expect(decision.risk).toBe(2);
    expect(decision.hits).toEqual([
      {
        layer: "L10",
        rule: "botSignals",
        action: "log",
        reason: "bot signals: headlessUserAgent (risk 2)",
      },
    ]);
  });

  it("challenge at challengeAt, and not below it", () => {
    const flow = challenges({
      provider: {
        id: "p",
        field: "a",
        issue: () => ({ provider: "p", field: "a", html: "" }),
        verify: () => ({ ok: true }),
      },
      secret: "s".repeat(32),
    });
    const security = createSecurity({
      policy: { botSignals: { challengeAt: 2 } },
      challenge: flow,
    });
    expect(
      decide(security, facts({ headers: { "user-agent": "curl/8" } })).action,
    ).toBe("log");
    const both = decide(
      security,
      facts({
        headers: { "user-agent": "curl/8", "sec-ch-ua": '"Chromium";v="140"' },
      }),
    );
    expect(both.action).toBe("challenge");
    // The signals' 2, and 1 for the refusing hit.
    expect(both.risk).toBe(3);
    expect(both.hits[0]).toMatchObject({
      layer: "L10",
      action: "challenge",
      reason: "bot signals: libraryUserAgent, clientHintsMismatch (risk 2)",
    });
  });

  it("log the challenge they would have made in dry run (a block without a flow)", () => {
    const security = createSecurity({
      policy: { botSignals: { challengeAt: 1, mode: "dryRun" } },
    });
    const decision = decide(
      security,
      facts({ headers: { "user-agent": "curl/8" } }),
    );
    expect(decision.action).toBe("log");
    expect(decision.hits[0]).toMatchObject({
      action: "log",
      wouldHaveBeen: "block",
    });
    expect(decision.hits[0]?.reason).toStartWith(
      "dry run: bot signals: libraryUserAgent",
    );
  });

  it("are read in the early stage only, so a staged request is counted once", () => {
    const security = createSecurity({
      policy: { botSignals: { challengeAt: 1 } },
    });
    const request = facts({ headers: { "user-agent": "curl/8" } });
    expect(decide(security, request, "early").action).toBe("block");
    expect(decide(security, request, "route").action).toBe("allow");
  });

  it("skip an allow-listed or internal client", () => {
    const security = createSecurity({
      policy: {
        botSignals: { challengeAt: 1 },
        lists: [{ ip: "203.0.113.0/24", action: "allow" }],
      },
    });
    expect(
      decide(security, facts({ headers: { "user-agent": "curl/8" } })).action,
    ).toBe("allow");
  });
});

describe("the botSignals section's checks", () => {
  it("accepts a full section", () => {
    expect(
      validateBotSignals({
        mode: "dryRun",
        weights: Object.fromEntries(BOT_SIGNALS.map((name) => [name, 1])),
        challengeAt: 3,
        browserPaths: ["/app/**"],
      }),
    ).toEqual([]);
  });

  it("names every problem, with its path", () => {
    expect(
      validateBotSignals({
        mode: "on",
        weights: { teleport: 1, noUserAgent: -1 },
        challengeAt: 0,
        browserPaths: ["app", "/a/***"],
        extra: true,
      }).map((issue) => issue.path.join(".")),
    ).toEqual([
      "botSignals.extra",
      "botSignals.mode",
      "botSignals.weights.teleport",
      "botSignals.weights.noUserAgent",
      "botSignals.challengeAt",
      "botSignals.browserPaths.0",
      "botSignals.browserPaths.1",
    ]);
    expect(validateBotSignals("yes")).toEqual([
      { path: ["botSignals"], message: "must be an object" },
    ]);
  });

  it("is checked by compilePolicy", () => {
    expect(() => compilePolicy({ botSignals: { challengeAt: -1 } })).toThrow(
      /botSignals/,
    );
  });
});
