/**
 * Differential test against `@nestjs/platform-express`: one Nest application
 * per group, booted on Express's adapter and on `BunHttpAdapter`, sent the
 * same requests. Status, every response header and the body must match,
 * except the differences listed in `KNOWN` (each with its reason, and each
 * still checked to differ, so a fixed one is taken off the list).
 *
 * Two normalisations, both cosmetic: `Content-Type` parameters are compared
 * as `type; param` (Bun writes `application/json;charset=utf-8`), and an
 * `ETag`'s hash part is masked (both are `W/"<hex length>-<hash>"`, hashed
 * differently). The Bun side is given `etag: "weak"`, Express's default.
 *
 * Express's behaviour here is measured, not assumed: whatever the Express
 * application answers is the expectation.
 */
import type { Booted, Side } from "./expressCompat/app";
import type { ProbeGroup } from "./expressCompat/probes";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootBoth, comparable as fields, observe } from "./expressCompat/app";
import { GROUPS, KNOWN } from "./expressCompat/probes";

function describeGroup(group: ProbeGroup) {
  describe(`bun-nest vs platform-express: ${group.name}`, () => {
    let apps: Record<Side, Booted> | undefined;

    beforeAll(async () => {
      apps = await bootBoth(group.module, group.configure, group.options);
    });

    afterAll(async () => {
      await apps?.express.app.close();
      await apps?.bun.app.close();
    });

    for (const probe of group.probes) {
      const key = `${group.name}/${probe.name}`;
      const known = KNOWN[key];
      it(`${probe.init?.method ?? "GET"} ${probe.path} — ${probe.name}`, async () => {
        const express = fields(
          await observe(apps!.express.base, probe.path, probe.init),
        );
        const bun = fields(
          await observe(apps!.bun.base, probe.path, probe.init),
        );

        const names = new Set([...Object.keys(express), ...Object.keys(bun)]);
        const differing = [...names].filter(
          (name) => express[name] !== bun[name],
        );
        const unexpected = differing.filter(
          (name) => !known?.fields.includes(name),
        );

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
      });
    }
  });
}

for (const group of GROUPS) {
  describeGroup(group);
}
