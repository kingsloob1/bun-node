/**
 * The routing differential (NestJS 12 parity plan, §5.6): one Nest
 * application per group, booted on `@nestjs/platform-express`'s
 * `ExpressAdapter` and on `BunHttpAdapter`, sent the same requests, on
 * whichever Nest major is installed. Compared, per request: status, parsed
 * body, `content-type`, `allow`, `location`, `x-custom`, the handler that
 * ran (`x-h`) and the middleware trail (`x-trail`); per boot: the boot error
 * and every warning Nest logged. Express's answer is the expectation,
 * measured, not assumed.
 *
 * Ours is asked twice, through the socket-free `adapter.fetch()` and over
 * its socket, and the two must agree before either is compared. Paths
 * starting with `//` go over a raw socket (oven-sh/bun#45330, see
 * `routingCompat/harness.ts`).
 *
 * The differences not fixed yet are `KNOWN` (`routingCompat/probes.ts`),
 * each still checked to differ: a fix fails this test until its entry goes.
 */
import type { Booted, Group } from "./routingCompat/harness";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  boot,
  bootFields,
  close,
  resetNestLogger,
  viaAdapterFetch,
  viaSocket,
} from "./routingCompat/harness";
import { GROUPS, KNOWN } from "./routingCompat/probes";

/**
 * Asserts `bun` equals `express` outside the known fields of `key`, and
 * that each known field still differs.
 */
function compare(
  key: string,
  express: Record<string, string>,
  bun: Record<string, string>,
) {
  const known = KNOWN[key];
  const names = new Set([...Object.keys(express), ...Object.keys(bun)]);
  const differing = [...names].filter((name) => express[name] !== bun[name]);
  const unexpected = differing.filter((name) => !known?.fields.includes(name));

  // Every field outside the known differences is Express's.
  expect(
    Object.fromEntries(unexpected.map((name) => [name, bun[name]])),
  ).toEqual(
    Object.fromEntries(unexpected.map((name) => [name, express[name]])),
  );

  // A known difference that no longer differs is taken off the list.
  const stale = (known?.fields ?? []).filter(
    (name) => !differing.includes(name),
  );
  expect(stale).toEqual([]);
}

function describeGroup(group: Group) {
  describe.skipIf(group.when === false)(
    `routing: bun-nest vs platform-express: ${group.name}`,
    () => {
      let express: Booted | undefined;
      let bun: Booted | undefined;

      beforeAll(async () => {
        // One at a time: `create({ logger })` replaces Nest's static logger,
        // which `LegacyRouteConverter` logs through, so two boots at once
        // could swap each other's warnings.
        express = await boot("express", group);
        bun = await boot("bun", group);
      });

      afterAll(async () => {
        await close(express);
        await close(bun);
        resetNestLogger();
      });

      it("boot: the same boot error and warnings", () => {
        compare(`${group.name}/(boot)`, bootFields(express!), bootFields(bun!));
      });

      for (const probe of group.probes) {
        const key = `${group.name}/${probe.name}`;
        it(`${probe.method ?? "GET"} ${probe.path} — ${probe.name}`, async () => {
          const expected = await viaSocket(express!, probe);
          const served = await viaSocket(bun!, probe);
          const fetched = await viaAdapterFetch(bun!, probe);
          // adapter.fetch() is the production path without the socket.
          expect(fetched).toEqual(served);
          compare(key, expected, served);
        });
      }
    },
  );
}

for (const group of GROUPS) {
  describeGroup(group);
}

describe("routing: KNOWN", () => {
  it("names only probes that exist", () => {
    const keys = new Set(
      GROUPS.flatMap((group) => [
        `${group.name}/(boot)`,
        ...group.probes.map((probe) => `${group.name}/${probe.name}`),
      ]),
    );
    expect(Object.keys(KNOWN).filter((key) => !keys.has(key))).toEqual([]);
  });

  it("has unique probe names per group", () => {
    for (const group of GROUPS) {
      const names = group.probes.map((probe) => probe.name);
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    }
  });
});
