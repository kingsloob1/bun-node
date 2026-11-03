/**
 * `signallingContract` (lib/webrtc/signalling.ts), the contract half: the
 * fixed messages over the given path and options, the vendor-free schemas
 * (what each accepts and refuses, value-free; only the declared fields kept),
 * their JSON Schema in the AsyncAPI document a relay's router produces, and
 * the declaration checks.
 */
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { BunRouter } from "../../lib/BunRouter";
import { BunWebSocket } from "../../lib/BunWebSocket";
import { createReceiver, createSender } from "../../lib/contract/guard";
import { generateAsyncApi } from "../../lib/docs/index";
import { signallingContract, signallingRelay } from "../../lib/webrtc";

const signalling = signallingContract({ path: "/rtc/:room" });

/** A guard, as these tests call it (the contract is untyped: `AnyContract`). */
type AnyGuard = (frame: unknown) => unknown;

/** The receiving guard over what clients send, and the sending one over what the relay sends. */
const inbound = createReceiver(
  signalling.contract,
  "inbound",
) as unknown as AnyGuard;
const outbound = createSender(
  signalling.contract,
  "outbound",
) as unknown as AnyGuard;

/** The issues' paths of a refused frame, sorted; `[]` when it passed. */
async function pathsOf(guard: AnyGuard, frame: unknown): Promise<string[]> {
  const verdict = await guard(frame);
  return verdict instanceof Error
    ? (verdict as Error & { issues: { path: string }[] }).issues
        .map((i) => i.path)
        .sort()
    : [];
}

describe("signallingContract", () => {
  it("declares the fixed messages on the path, with join answered by peers", () => {
    expect(signalling.meta.path).toBe("/rtc/:room");
    expect(signalling.meta.replies).toEqual({ join: "peers" });
    expect(Object.keys(signalling.spec.receives).sort()).toEqual([
      "answer",
      "candidate",
      "join",
      "leave",
      "offer",
    ]);
    expect(Object.keys(signalling.spec.sends).sort()).toEqual([
      "answer",
      "candidate",
      "join",
      "leave",
      "offer",
      "peers",
    ]);
    expect(signalling.spec.receives.leave).toBeNull();
  });

  it("keeps the options given: the upgrade's request, the subprotocol, the policies", () => {
    const Room = z.object({ room: z.string().min(1) });
    const custom = signallingContract({
      path: "/signal/:room",
      request: { params: Room },
      subprotocol: "rtc.v1",
      messageValidation: { out: "warn" },
      meta: { name: "rtc" },
    });
    expect(custom.meta.request).toEqual({ params: Room });
    expect(custom.meta.subprotocol).toBe("rtc.v1");
    expect(custom.spec.messageValidation).toEqual({ out: "warn" });
    expect(custom.contract.meta.name).toBe("rtc");
  });

  it("throws a TypeError for a path that is not a route path", () => {
    expect(() => signallingContract({ path: "rtc" })).toThrow(TypeError);
  });

  it("accepts the browser's own shapes, and keeps only the declared fields", async () => {
    const offer = {
      type: "offer",
      data: {
        to: "bob",
        description: { type: "offer", sdp: "v=0", extra: 1 },
        from: "mallory",
      },
    };
    expect(await inbound(offer)).toEqual({
      type: "offer",
      data: { to: "bob", description: { type: "offer", sdp: "v=0" } },
    });
    for (const candidate of [
      {
        candidate: "candidate:1 1 UDP 1 127.0.0.1 1 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
      {
        candidate: "",
        sdpMid: null,
        sdpMLineIndex: null,
        usernameFragment: null,
      },
      { candidate: "candidate:x", usernameFragment: "abcd" },
    ]) {
      expect(
        await pathsOf(inbound, {
          type: "candidate",
          data: { to: "b", candidate },
        }),
      ).toEqual([]);
    }
    expect(
      await pathsOf(inbound, {
        type: "answer",
        data: { to: "a", description: { type: "pranswer", sdp: "v=0" } },
      }),
    ).toEqual([]);
    expect(await pathsOf(inbound, { type: "leave" })).toEqual([]);
    expect(
      await pathsOf(outbound, { type: "peers", data: { peers: ["a", "b"] } }),
    ).toEqual([]);
  });

  it("refuses what is not, with every issue, value-free", async () => {
    expect(
      await pathsOf(inbound, {
        type: "offer",
        data: { to: "", description: { type: "answer", sdp: 5 } },
      }),
    ).toEqual(["description.sdp", "description.type", "to"]);
    expect(
      await pathsOf(inbound, {
        type: "candidate",
        data: {
          to: "b",
          candidate: { candidate: 1, sdpMLineIndex: -1, sdpMid: 3 },
        },
      }),
    ).toEqual([
      "candidate.candidate",
      "candidate.sdpMLineIndex",
      "candidate.sdpMid",
    ]);
    expect(
      await pathsOf(inbound, { type: "join", data: { peer: "x".repeat(129) } }),
    ).toEqual(["peer"]);
    expect(
      await pathsOf(inbound, {
        type: "offer",
        data: {
          to: "b",
          description: { type: "offer", sdp: "x".repeat(65_537) },
        },
      }),
    ).toEqual(["description.sdp"]);
    expect(
      await pathsOf(outbound, { type: "peers", data: { peers: [1] } }),
    ).toEqual(["peers.0"]);
    const verdict = (await inbound({
      type: "join",
      data: { peer: 42, secret: "Hunter2" },
    })) as Error;
    expect(verdict).toBeInstanceOf(Error);
    expect(JSON.stringify(verdict)).not.toContain("Hunter2");
  });

  it("documents every message with its JSON Schema (AsyncAPI, from a relay's router)", () => {
    const router = new BunRouter();
    // Generation never binds: a socket with no server.
    router.setBunWebSocket(
      new BunWebSocket({
        newInstance: false,
        getServer: () => undefined,
        router,
      }),
    );
    router.ws(...signallingRelay(signalling));
    const { document, warnings } = generateAsyncApi(router, {
      title: "Signalling",
      version: "1.0.0",
    });
    expect(warnings).toEqual([]);
    const text = JSON.stringify(document);
    for (const field of [
      "description",
      "sdpMLineIndex",
      "peers",
      "usernameFragment",
    ]) {
      expect(text).toContain(`"${field}"`);
    }
    expect(text).toContain('"maxLength":65536');
    expect(text).toContain('"reply"');
  });
});
