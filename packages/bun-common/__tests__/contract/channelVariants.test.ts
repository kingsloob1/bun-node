/**
 * `channelContract()` refuses a `variants()` entry on a send. `variants()` is
 * bun-common's (`lib/responseBodies.ts`), so this case stays here while the
 * rest of the channel contract's tests live with the core in
 * `packages/bun-contract/__tests__/channel.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { channelContract } from "../../lib/contract/channel";
import { variants } from "../../lib/responseBodies";

const Said = z.object({ by: z.string(), text: z.string() });

describe("channelContract: the declaration", () => {
  it("refuses a variants() entry for now (the variants-on-sends shape is an open design point, plan §9)", () => {
    expect(() =>
      channelContract({
        path: "/c",
        receives: {},
        sends: {
          said: variants({
            admin: { content: { "application/json": Said } },
          }) as never,
        },
      }),
    ).toThrow(
      new TypeError(
        'defineChannel(): the sends "said" must be a Standard Schema or null',
      ),
    );
  });
});
