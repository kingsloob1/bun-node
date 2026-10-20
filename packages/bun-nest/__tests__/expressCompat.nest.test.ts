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
 * application answers is the expectation. One exception: on Nest 12.0.0 and
 * 12.0.1 the reference carries 12.0.2's fix for its prefix-scoped not-found
 * router, which those releases mount where Express never matches
 * (`expressCompat/reference.ts`), so the prefix rows still compare there.
 */
import type { Booted, Side } from "./expressCompat/app";
import type { ProbeGroup } from "./expressCompat/probes";
import { ExpressAdapter } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootBoth,
  CLOSED_SOURCES,
  DisconnectModule,
  comparable as fields,
  observe,
} from "./expressCompat/app";
import { GROUPS, KNOWN } from "./expressCompat/probes";

function describeGroup(group: ProbeGroup) {
  // A group the installed Nest cannot run is skipped, and says why.
  const describeOrSkip = group.skip ? describe.skip : describe;
  const suffix = group.skip ? ` (skipped: ${group.skip})` : "";
  describeOrSkip(`bun-nest vs platform-express: ${group.name}${suffix}`, () => {
    let apps: Record<Side, Booted> | undefined;

    beforeAll(async () => {
      apps = await bootBoth(group.module, group.configure, group.options);
    });

    afterAll(async () => {
      await apps?.express.app.close();
      await apps?.bun.app.close();
      group.cleanup?.();
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

/**
 * Whether the reference destroys a `StreamableFile`'s source when the client
 * leaves: platform-express 12.1.3's `reply()` does (`finished(response, …)`,
 * nestjs/nest #17973); earlier ones leave it open, even mid-stream on 11.
 * Read from the reference's own `reply()`, never from a version.
 */
const REFERENCE_DESTROYS_SOURCE = ExpressAdapter.prototype.reply
  .toString()
  .includes("finished(");

/** Waits up to `ms` for `tag`'s source to close; whether it did. */
async function sourceClosed(tag: string, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!CLOSED_SOURCES.has(tag) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  return CLOSED_SOURCES.has(tag);
}

// Not a request/response comparison: whether a `StreamableFile`'s source is
// destroyed when the client leaves, as platform-express 12.1.3 destroys it
// (nestjs/nest #17973). bun-nest destroys it on every Nest; Express is
// measured too, and held to the same where its `reply()` has the fix.
describe("bun-nest vs platform-express: StreamableFile, client gone", () => {
  let apps: Record<Side, Booted> | undefined;

  beforeAll(async () => {
    apps = await bootBoth(DisconnectModule);
  });

  afterAll(async () => {
    await apps?.express.app.close();
    await apps?.bun.app.close();
  });

  it("destroys a source returned after the client left", async () => {
    const closed: Record<string, boolean> = {};
    for (const side of ["express", "bun"] as const) {
      const tag = `${side}-late`;
      const aborter = new AbortController();
      const pending = fetch(`${apps![side].base}/disconnect/late/${tag}`, {
        signal: aborter.signal,
      }).catch(() => undefined);
      await Bun.sleep(80);
      aborter.abort();
      await pending;
      closed[side] = await sourceClosed(tag);
    }
    expect(closed.bun).toBe(true);
    expect(closed.express).toBe(REFERENCE_DESTROYS_SOURCE);
  });

  it("destroys a source whose client leaves mid-stream", async () => {
    const closed: Record<string, boolean> = {};
    for (const side of ["express", "bun"] as const) {
      const tag = `${side}-now`;
      const aborter = new AbortController();
      const res = await fetch(`${apps![side].base}/disconnect/now/${tag}`, {
        signal: aborter.signal,
      });
      await res.body!.getReader().read();
      aborter.abort();
      closed[side] = await sourceClosed(tag);
    }
    expect(closed.bun).toBe(true);
    if (REFERENCE_DESTROYS_SOURCE) {
      expect(closed.express).toBe(true);
    }
  });
});
