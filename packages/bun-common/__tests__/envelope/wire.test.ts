/**
 * The envelope's wire compatibility across PR-P4's move (bun-security plan
 * §15.1): envelopes bun-jobs signed before the move (a fixture captured from
 * the old code, `fixtures/bun-jobs-envelopes.json`) verify with bun-common's
 * copy and are signed to the same bytes by it; and the old code itself (a
 * frozen copy, `fixtures/old/`) verifies what the moved code signs, and the
 * moved code what the old code signs, both ways and with each MAC. The
 * codec that bun-jobs binds keeps its error class and header names.
 */
import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  envelopeCodec,
  signEnvelope,
  signEnvelopeWith,
  verifyEnvelope,
  verifyEnvelopeWith,
} from "../../lib/envelope/index";
import type {
  RemoteBody,
  RemoteSignatureDirection,
} from "../../lib/envelope/index";
import { ConfigError } from "../../lib/errors";
import { subtleHmacSha256 as oldSubtle } from "./fixtures/old/mac";
import {
  signEnvelopeWith as oldSign,
  verifyEnvelopeWith as oldVerify,
} from "./fixtures/old/signing";
import { nodeHmacSha256 } from "./nodeMac";

/** One captured envelope. */
interface Captured {
  readonly name: string;
  readonly direction: RemoteSignatureDirection;
  readonly body: string | null;
  readonly bodyHex?: string;
  readonly id?: string;
  readonly secret: string | string[];
  readonly now: number;
  readonly header: string;
}

const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures/bun-jobs-envelopes.json"),
    "utf8",
  ),
) as { cases: Captured[] };

/** A case's body as the signer took it. */
function bodyOf(item: Captured): RemoteBody | null {
  return item.bodyHex === undefined
    ? item.body
    : Uint8Array.from(Buffer.from(item.bodyHex, "hex"));
}

/** A case's signing options. */
function optionsOf(item: Captured) {
  return {
    direction: item.direction,
    secret: item.secret,
    now: item.now,
    ...(item.id === undefined ? {} : { id: item.id }),
  };
}

describe("envelopes signed before the move", () => {
  it("covers every form: bodies, a bodyless request, a rotation list, a binary body", () => {
    expect(FIXTURE.cases).toHaveLength(7);
  });

  for (const item of FIXTURE.cases) {
    it(`${item.name}: verifies with the moved code, which signs the same bytes`, async () => {
      expect(await signEnvelope(bodyOf(item), optionsOf(item))).toBe(
        item.header,
      );
      expect(
        await signEnvelopeWith(nodeHmacSha256, bodyOf(item), optionsOf(item)),
      ).toBe(item.header);
      expect(
        await verifyEnvelope(bodyOf(item), item.header, optionsOf(item)),
      ).toMatchObject({ ok: true, keyIndex: 0 });
      // Negative control: one byte of the MAC changed, refused.
      const tampered = item.header.replace(/.$/, (c) =>
        c === "0" ? "1" : "0",
      );
      expect(
        await verifyEnvelope(bodyOf(item), tampered, optionsOf(item)),
      ).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
    });
  }
});

describe("the old code and the moved code, against each other", () => {
  for (const item of FIXTURE.cases) {
    it(`${item.name}: each verifies the other's signature, with each MAC`, async () => {
      for (const mac of [oldSubtle, nodeHmacSha256]) {
        const byNew = await signEnvelopeWith(
          mac,
          bodyOf(item),
          optionsOf(item),
        );
        expect(
          await oldVerify(mac, bodyOf(item), byNew, optionsOf(item)),
        ).toMatchObject({ ok: true });
        const byOld = await oldSign(mac, bodyOf(item), optionsOf(item));
        expect(byOld).toBe(byNew);
        expect(
          await verifyEnvelopeWith(mac, bodyOf(item), byOld, optionsOf(item)),
        ).toMatchObject({ ok: true });
      }
      // Both refuse the other direction alike.
      const other = item.direction === "request" ? "response" : "request";
      if (item.body !== null) {
        const options = { ...optionsOf(item), direction: other } as const;
        expect(
          await oldVerify(oldSubtle, bodyOf(item), item.header, options),
        ).toEqual(await verifyEnvelope(bodyOf(item), item.header, options));
      }
    });
  }

  it("refuse alike: the same result for a skewed clock, a missing header and a bodyless request without an id", async () => {
    const item = FIXTURE.cases[0];
    if (item === undefined) throw new Error("no case");
    const cases: [string | null, Parameters<typeof verifyEnvelope>[2]][] = [
      [item.header, { ...optionsOf(item), now: item.now + 400_000 }],
      [null, optionsOf(item)],
    ];
    for (const [header, options] of cases) {
      const before = await oldVerify(oldSubtle, bodyOf(item), header, options);
      const after = await envelopeCodec({
        headers: { signature: "bun-jobs-signature", id: "bun-jobs-id" },
      }).verifyEnvelope(bodyOf(item), header, options);
      expect(after).toEqual(before);
    }
    const bodyless = {
      direction: "request",
      secret: "s",
      now: item.now,
    } as const;
    expect(
      await envelopeCodec({
        headers: { signature: "bun-jobs-signature", id: "bun-jobs-id" },
      }).verifyEnvelope(null, `t=1,v1=${"0".repeat(64)}`, bodyless),
    ).toEqual(
      await oldVerify(oldSubtle, null, `t=1,v1=${"0".repeat(64)}`, bodyless),
    );
  });
});

describe("envelopeCodec", () => {
  it("throws the error its configError makes, and names its headers in a refusal", async () => {
    class OwnError extends Error {}
    const codec = envelopeCodec({
      configError: (message) => new OwnError(message),
      headers: { signature: "x-own-signature", id: "x-own-id" },
    });
    await expect(
      codec.signEnvelope("{}", { direction: "request", secret: "" }),
    ).rejects.toBeInstanceOf(OwnError);
    expect(() => codec.createRemoteNonceCache({ max: 0 })).toThrow(OwnError);
    expect(() => codec.keysOf([])).toThrow(OwnError);
    const refused = await codec.verifyEnvelope("{}", undefined, {
      direction: "request",
      secret: "k",
    });
    expect(refused).toMatchObject({ ok: false, code: "SIGNATURE_MISSING" });
    expect(refused.ok === false && refused.detail).toContain("x-own-signature");
    // bun-common's own functions throw its ConfigError and name generic headers.
    await expect(
      signEnvelope("{}", { direction: "request", secret: "" }),
    ).rejects.toBeInstanceOf(ConfigError);
    const generic = await verifyEnvelope(null, `t=1,v1=${"0".repeat(64)}`, {
      direction: "request",
      secret: "k",
    });
    expect(generic.ok === false && generic.detail).toContain("x-signature-id");
  });
});
