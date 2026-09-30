import type { SummonFacet } from "../../../lib/provider/index";
import type {
  ConformanceCheck,
  ConformanceReport,
  FakePlatform,
} from "../../../lib/provider/testing/index";
import type { KitRun } from "../../../lib/provider/testing/run";
import type { AcmeConfig } from "./acme";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { isServableFact } from "../../../lib/api/serialize";
import {
  defineComputeProvider,
  toStandardSchema,
} from "../../../lib/provider/index";
import { MIN_SECRET_LENGTH } from "../../../lib/provider/redact";
import { describeChecks } from "../../../lib/provider/testing/checks";
import { runProviderConformance } from "../../../lib/provider/testing/index";
import { acmeConfig, acmeFake, acmeProvider } from "./acme";

/**
 * The kit's secret checks, hardened:
 *
 * - `summon.secrets.no-leak` looks for every declared secret by its real,
 *   validated value (as the controller and the redactor read it), not only
 *   for the canaries it seeds into the config the author passes: a secret
 *   the schema *derives* is looked for too, and a leak of one names its
 *   path. A declared secret under the redactor's floor is not looked for by
 *   value, and the check's detail says so.
 * - `summon.describe.facts` warns about exactly the facts the status route
 *   drops: a credential name by `isCredentialKey`, or a URL with userinfo.
 */

setDefaultTimeout(120_000);

/** The fakes a test opened, closed after it. */
const platforms: FakePlatform[] = [];
afterEach(async () => {
  for (const platform of platforms.splice(0)) {
    await platform.close();
  }
});

/** Acme's config, with one secret the schema derives from the token. */
type DerivedConfig = AcmeConfig & {
  /** Derived from `apiToken` by the schema; declared a secret. */
  derived: string;
};

/**
 * An Acme provider whose schema derives a second secret, `derived`, from
 * the token, and declares both. With `leak`, `summon` returns the derived
 * secret as one of its handles, which bun-jobs would store.
 */
function derivingProvider(options: {
  /** Put the derived secret in summon's handles. */
  leak: boolean;
  /** How the derived secret is made from the token. */
  derive?: (token: string) => string;
}) {
  const base = acmeProvider();
  const derive =
    options.derive ??
    ((token: string) => `drv-${[...token].reverse().join("")}-derived`);
  const baseSchema = base.definition.config!;
  return defineComputeProvider<DerivedConfig, AcmeConfig>({
    ...base.definition,
    config: toStandardSchema<AcmeConfig, DerivedConfig>((input) => {
      const result = baseSchema["~standard"].validate(input);
      if (result instanceof Promise || result.issues !== undefined) {
        throw new Error("acme's schema is synchronous and the config valid");
      }
      return {
        value: { ...result.value, derived: derive(result.value.apiToken) },
      };
    }),
    secrets: ["apiToken", "derived"],
    describe: (config) => ({ region: config.region }),
    validate: base.definition.validate as never,
    summon: (config, context) => {
      const facet = base.definition.summon!(config, context);
      return {
        ...facet,
        summon: async (request, ctx) => {
          const result = await facet.summon(request, ctx);
          return options.leak && result.status === "started"
            ? { ...result, handles: [...result.handles, config.derived] }
            : result;
        },
      } satisfies SummonFacet;
    },
  });
}

/** Runs the kit on a provider over a fresh Acme fake, the handoff and the race skipped. */
async function kit(
  provider: ReturnType<typeof derivingProvider>,
): Promise<ConformanceReport> {
  const platform = await acmeFake();
  platforms.push(platform);
  return await runProviderConformance(provider, {
    config: acmeConfig(platform),
    platform,
    skip: [
      "summon.handoff.started",
      "summon.handoff.released",
      "summon.handoff.drained",
      "summon.handoff.scale-down",
      "summon.cas.one-call",
    ].map((id) => ({ id, reason: "not under test" })),
  });
}

/** The no-leak check of a report. */
function noLeak(report: ConformanceReport): ConformanceCheck {
  return report.checks.find((check) => check.id === "summon.secrets.no-leak")!;
}

describe("summon.secrets.no-leak looks for every declared secret by its validated value", () => {
  it("a secret the schema derives, leaked in a handle, fails the check and names its path", async () => {
    const report = await kit(derivingProvider({ leak: true }));
    const check = noLeak(report);
    expect(check.status, report.toMarkdown()).toBe("fail");
    expect(check.detail).toContain("derived");
    expect(check.detail).not.toContain("apiToken");
  });

  it("the same provider, not leaking, passes: both secrets looked for", async () => {
    const report = await kit(derivingProvider({ leak: false }));
    const check = noLeak(report);
    expect(check.status, report.toMarkdown()).toBe("pass");
    expect(check.detail).toMatch(/^2 secret\(s\) looked for/);
  });

  it(`a derived secret of ${MIN_SECRET_LENGTH} characters is looked for by value`, async () => {
    const report = await kit(
      derivingProvider({
        leak: true,
        derive: (token) => token.slice(-MIN_SECRET_LENGTH),
      }),
    );
    const check = noLeak(report);
    expect(check.status, report.toMarkdown()).toBe("fail");
    expect(check.detail).toContain("derived");
    expect(check.detail).not.toContain("under");
  });

  it(`a derived secret under ${MIN_SECRET_LENGTH} characters is not, and the detail says so`, async () => {
    const report = await kit(
      derivingProvider({
        leak: true,
        derive: (token) => token.slice(-(MIN_SECRET_LENGTH - 1)),
      }),
    );
    const check = noLeak(report);
    expect(check.status, report.toMarkdown()).toBe("pass");
    expect(check.detail).toContain(
      `1 declared secret(s) under ${MIN_SECRET_LENGTH} characters are not redacted, so not checked by value`,
    );
  });
});

describe("summon.secrets.no-leak counts a declared secret that is not a string", () => {
  it("an object at a declared path is not looked for by value, and the detail says so", async () => {
    const report = await kit(
      derivingProvider({
        leak: false,
        derive: () => ({ nested: "not a string" }) as unknown as string,
      }),
    );
    const check = noLeak(report);
    expect(check.status, report.toMarkdown()).toBe("pass");
    expect(check.detail).toMatch(/^1 secret\(s\) looked for/);
    expect(check.detail).toContain(
      "; 1 declared secret(s) are not strings, so not checked by value",
    );
  });
});

/** Runs the describe check alone on a summoner describing `facts`. */
function describeStatus(facts: Record<string, string>): ConformanceCheck {
  const check: ConformanceCheck = {
    id: "summon.describe.facts",
    level: "should",
    status: "pass",
  };
  const run = {
    summoner: { describe: () => facts },
    scanned: [] as unknown[],
    set: (_id: string, status: ConformanceCheck["status"], detail?: string) => {
      check.status = status;
      if (detail === undefined) {
        delete check.detail;
      } else {
        check.detail = detail;
      }
    },
  } as unknown as KitRun;
  describeChecks(run);
  return check;
}

describe("summon.describe.facts warns about exactly the facts the status route drops", () => {
  const facts: Record<string, string> = {
    keyspace: "jobs",
    tokenizerModel: "bpe",
    author: "ada",
    region: "eu-west-1",
    sessionId: "s-1",
    apikey: "x",
    dbPassword: "x",
    authorization: "x",
    endpoint: "https://user:pw@api.example",
  };

  it("names each fact the status route would drop, and no other", () => {
    const check = describeStatus(facts);
    expect(check.status).toBe("fail");
    const problems = check.detail!.split("; ");
    const warned = Object.keys(facts).filter((key) =>
      problems.some((problem) => problem.startsWith(`${key} `)),
    );
    const dropped = Object.entries(facts)
      .filter(([key, value]) => !isServableFact(key, value, true))
      .map(([key]) => key);
    expect(warned).toEqual(dropped);
    expect(warned).toEqual([
      "sessionId",
      "apikey",
      "dbPassword",
      "authorization",
      "endpoint",
    ]);
  });

  it("warns about a value holding a credential shape, as the status route drops it", () => {
    const shaped: Record<string, string> = {
      note: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      limits: "max_tokens=4096",
      cluster: "session-workers:prod",
      // Negative control: ordinary values under ordinary keys pass.
      region: "eu-west-1",
      image: "ghcr.io/acme/worker:1.2.3",
    };
    const check = describeStatus(shaped);
    expect(check.status).toBe("fail");
    const problems = check.detail!.split("; ");
    const warned = Object.keys(shaped).filter((key) =>
      problems.some((problem) => problem.startsWith(`${key} `)),
    );
    const dropped = Object.entries(shaped)
      .filter(([key, value]) => !isServableFact(key, value, true))
      .map(([key]) => key);
    expect(warned).toEqual(dropped);
    expect(warned).toEqual(["note", "limits", "cluster"]);
    expect(
      describeStatus({
        region: "eu-west-1",
        image: "ghcr.io/acme/worker:1.2.3",
      }).status,
    ).toBe("pass");
  });

  it("keyspace, tokenizerModel and author pass on their own", () => {
    expect(
      describeStatus({ keyspace: "a", tokenizerModel: "b", author: "c" })
        .status,
    ).toBe("pass");
  });
});
