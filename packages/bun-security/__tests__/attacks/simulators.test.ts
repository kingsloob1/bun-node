/**
 * The simulators themselves (`./testing`): the runner's outcome counting,
 * its fake-clock moves and refusal test, the targets, and each attack's
 * shape (its addresses, times and bodies), so a policy test built on them
 * tests the policy and not the simulator.
 */
import { describe, expect, it } from "bun:test";
import { createSecurity } from "../../lib/index";
import { dropResponse } from "../../lib/serve/respond";
import { withSecurity } from "../../lib/serve/index";
import {
  accountEnumeration,
  addressRotation,
  apiKeyAbuse,
  burst,
  crawl,
  CRAWLER_USER_AGENTS,
  credentialStuffing,
  crossSitePosts,
  disposableSignups,
  distributedGuessing,
  enumerationLeaks,
  forwardedForSpoof,
  handlerTarget,
  ipv6InPrefix,
  ipv6Rotation,
  keyCardinalityFlood,
  lowAndSlow,
  nthAddress,
  paced,
  passwordSpraying,
  pathScan,
  PROBE_PATHS,
  probeAnswers,
  runAttack,
  sequence,
  spoofedCrawler,
  staticCrawlerResolver,
} from "../../lib/testing/index";
import type {
  Attack,
  AttackTarget,
  ProbeAnswer,
} from "../../lib/testing/index";
import { cidrContains, parseAddress, parseCidr } from "../../lib/ip/address";
import { INTERNAL_RANGES } from "../../lib/policy/internal";

/** Whether `address` is in an internal range (which the engine lets past most layers). */
function isInternal(address: string): boolean {
  const parsed = parseAddress(address);
  return (
    parsed !== null &&
    INTERNAL_RANGES.some((range) => cidrContains(parseCidr(range)!, parsed))
  );
}

/** A target answering each request with `answer(i)`. */
function scripted(answer: (i: number) => Response): AttackTarget {
  let i = 0;
  return () => Promise.resolve(answer(i++));
}

/** A problem+json answer. */
function problem(status: number, code?: string): Response {
  return new Response(JSON.stringify({ status, ...(code ? { code } : {}) }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

const FIVE: Attack = {
  name: "five",
  requests: Array.from({ length: 5 }, (_, i) => ({
    path: `/${i}`,
    client: "203.0.113.1",
  })),
};

describe("runAttack", () => {
  it("counts statuses, codes and the first refusal, in order", async () => {
    const answers = [
      new Response("ok"),
      problem(401, "login_failed"),
      problem(404, "not_found"),
      problem(403, "banned"),
      new Response(null, { status: 429 }),
    ];
    const result = await runAttack(
      FIVE,
      scripted((i) => answers[i]),
    );
    expect(result).toMatchObject({
      name: "five",
      sent: 5,
      statuses: [200, 401, 404, 403, 429],
      byStatus: { "200": 1, "401": 1, "404": 1, "403": 1, "429": 1 },
      // A uniform 401 is the app's answer; a disguised 404 problem, a 403
      // and a 429 are refusals.
      refused: 3,
      firstRefused: 2,
      codes: { not_found: 1, banned: 1 },
      answers: [undefined, "login_failed", "not_found", "banned", undefined],
    });
  });

  it("does not count a router's plain 404 or an app's 400 without a code", async () => {
    const answers = [
      new Response("nope", { status: 404 }),
      new Response("bad", { status: 400 }),
      problem(400),
    ];
    const result = await runAttack(
      { name: "x", requests: FIVE.requests.slice(0, 3) },
      scripted((i) => answers[i]),
    );
    expect(result.refused).toBe(0);
    expect(result.firstRefused).toBeUndefined();
  });

  it("reads a dropped connection (an erroring body, or a target that throws) as status 0, refused, code dropped", async () => {
    let i = 0;
    const target: AttackTarget = () =>
      i++ === 0
        ? Promise.resolve(dropResponse())
        : Promise.reject(new Error("ECONNRESET"));
    const result = await runAttack(
      { name: "x", requests: FIVE.requests.slice(0, 2) },
      target,
    );
    expect(result.statuses).toEqual([0, 0]);
    expect(result.refused).toBe(2);
    expect(result.codes).toEqual({ dropped: 2 });
  });

  it("moves the clock to each request's time by the difference, never backwards", async () => {
    const moves: number[] = [];
    const attack: Attack = {
      name: "t",
      requests: [0, 1000, 1000, 500, 4000].map((at) => ({
        path: "/",
        client: "203.0.113.1",
        at,
      })),
    };
    await runAttack(
      attack,
      scripted(() => new Response("ok")),
      { advance: (ms) => moves.push(ms) },
    );
    expect(moves).toEqual([1000, 3000]);
  });

  it("awaits settle after each answer, and stops after stopAfterRefusals", async () => {
    let settled = 0;
    const result = await runAttack(
      FIVE,
      scripted(() => problem(403, "banned")),
      {
        settle: () => {
          settled++;
          return Promise.resolve();
        },
        stopAfterRefusals: 2,
      },
    );
    expect(result.sent).toBe(2);
    expect(settled).toBe(2);
  });

  it("takes a refusal test of the caller's", async () => {
    const result = await runAttack(
      FIVE,
      scripted(() => new Response("ok")),
      { refused: (response) => response.status === 200 },
    );
    expect(result.refused).toBe(5);
  });
});

describe("handlerTarget", () => {
  it("hands withSecurity the request's client as its peer, and reads no answer as a drop", async () => {
    const security = createSecurity<Request>({
      policy: { lists: [{ ip: "203.0.113.9", action: "block" }] },
      logger: () => {},
    });
    const handler = withSecurity(
      security,
      (request) => new Response(new URL(request.url).pathname),
    );
    const result = await runAttack(
      addressRotation({
        addresses: ["203.0.113.8", "203.0.113.9"],
        path: "/x",
      }),
      handlerTarget(handler),
    );
    expect(result.statuses).toEqual([200, 403]);
    const none = await runAttack(
      FIVE,
      handlerTarget(() => undefined),
    );
    expect(none.codes).toEqual({ dropped: 5 });
  });
});

describe("addresses", () => {
  it("nthAddress gives distinct, valid, public addresses", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64_516; i++) {
      const address = nthAddress(i);
      expect(parseAddress(address)).not.toBeNull();
      seen.add(address);
    }
    expect(seen.size).toBe(64_516);
    // Past the base's capacity it throws rather than repeating an address.
    expect(() => nthAddress(64_516)).toThrow(RangeError);
    expect(() => nthAddress(254, "203.0.113")).toThrow(RangeError);
    expect(() => nthAddress(0, "1.2.3.4")).toThrow(RangeError);
    expect([nthAddress(0), nthAddress(253), nthAddress(254)]).toEqual([
      "198.51.0.1",
      "198.51.0.254",
      "198.51.1.1",
    ]);
    expect(nthAddress(5, "203.0.113")).toBe("203.0.113.6");
    expect(nthAddress(0, "10")).toBe("10.0.0.1");
    expect([...seen].some(isInternal)).toBe(false);
    expect(
      keyCardinalityFlood({ count: 3000 }).requests.some((request) =>
        isInternal(request.client),
      ),
    ).toBe(false);
  });

  it("ipv6InPrefix gives distinct addresses inside one /64", () => {
    const prefix = parseCidr("2001:db8:1:2::/64")!;
    const addresses = ipv6InPrefix(500);
    expect(new Set(addresses).size).toBe(500);
    for (const address of addresses)
      expect(cidrContains(prefix, parseAddress(address)!)).toBe(true);
    expect(
      ipv6Rotation({ count: 3 }).requests.map((request) => request.client),
    ).toEqual(ipv6InPrefix(3));
  });
});

describe("timing helpers", () => {
  it("paced sets each request's time; sequence runs attacks one after another", () => {
    expect(paced(FIVE, 50, 100).requests.map((request) => request.at)).toEqual([
      100, 150, 200, 250, 300,
    ]);
    const both = sequence("both", paced(FIVE, 10), paced(FIVE, 20));
    expect(both.requests.map((request) => request.at)).toEqual([
      0, 10, 20, 30, 40, 40, 60, 80, 100, 120,
    ]);
    expect(both.name).toBe("both");
  });
});

describe("the sign-in attacks", () => {
  /** The bodies' usernames. */
  const usernames = (attack: Attack) =>
    attack.requests.map(
      (request) => (JSON.parse(request.body!) as { username: string }).username,
    );

  it("credential stuffing: one address, a new username and password each time", () => {
    const attack = credentialStuffing({ count: 50, everyMs: 3000 });
    expect(new Set(attack.requests.map((request) => request.client))).toEqual(
      new Set(["203.0.113.66"]),
    );
    expect(new Set(usernames(attack)).size).toBe(50);
    expect(attack.requests[2]).toMatchObject({
      method: "POST",
      path: "/login",
      at: 6000,
      headers: { "content-type": "application/json" },
    });
  });

  it("distributed guessing: one username, a new address each time", () => {
    const attack = distributedGuessing({
      username: "hank",
      count: 1000,
      path: "/auth/login",
      usernameField: "email",
    });
    expect(new Set(attack.requests.map((request) => request.client)).size).toBe(
      1000,
    );
    expect(
      new Set(
        attack.requests.map(
          (request) => (JSON.parse(request.body!) as { email: string }).email,
        ),
      ),
    ).toEqual(new Set(["hank"]));
  });

  it("password spraying: one password, the usernames in turn, a pool of addresses", () => {
    const attack = passwordSpraying({
      usernames: ["a", "b", "c", "d"],
      clients: 2,
    });
    expect(attack.requests.map((request) => request.client)).toEqual([
      "203.0.0.1",
      "203.0.0.2",
      "203.0.0.1",
      "203.0.0.2",
    ]);
    expect(
      new Set(
        attack.requests.map(
          (request) =>
            (JSON.parse(request.body!) as { password: string }).password,
        ),
      ).size,
    ).toBe(1);
  });

  it("low and slow: spread evenly over the hours", () => {
    const attack = lowAndSlow({ count: 72, hours: 6, username: "hank" });
    expect(attack.requests.map((request) => request.at).slice(0, 3)).toEqual([
      0, 300_000, 600_000,
    ]);
    expect(attack.requests.at(-1)?.at).toBe(71 * 300_000);
    expect(new Set(usernames(attack))).toEqual(new Set(["hank"]));
    expect(new Set(usernames(lowAndSlow({ count: 10 }))).size).toBe(10);
  });

  it("account enumeration: one wrong password per name", () => {
    expect(usernames(accountEnumeration({ usernames: ["a", "b"] }))).toEqual([
      "a",
      "b",
    ]);
  });

  it("enumerationLeaks names what tells the groups apart, and nothing when nothing does", async () => {
    const answer = (
      username: string,
      status: number,
      body: string,
      ms: number,
    ): ProbeAnswer => ({ username, status, body, ms });
    const known = new Set(["a"]);
    expect(
      enumerationLeaks(
        [answer("a", 401, "x", 200), answer("b", 401, "x", 200)],
        known,
        150,
      ),
    ).toEqual([]);
    expect(
      enumerationLeaks(
        [answer("a", 401, "x", 200), answer("b", 404, "x", 200)],
        known,
        150,
      ),
    ).toEqual(["status"]);
    expect(
      enumerationLeaks(
        [answer("a", 401, "x", 200), answer("b", 401, "y", 200)],
        known,
        150,
      ),
    ).toEqual(["body"]);
    expect(
      enumerationLeaks(
        [answer("a", 401, "x", 200), answer("b", 401, "x", 3)],
        known,
        150,
      ),
    ).toEqual(["time"]);
    const answers = await probeAnswers(
      accountEnumeration({ usernames: ["a", "b"] }),
      scripted((i) => new Response(String(i), { status: 401 })),
    );
    expect(
      answers.map((probe) => [probe.username, probe.status, probe.body]),
    ).toEqual([
      ["a", 401, "0"],
      ["b", 401, "1"],
    ]);
  });
});

describe("the other attacks", () => {
  it("path scan: the probe paths first, then the dead links, one address, a scanner's User-Agent", () => {
    const attack = pathScan({ count: 5 });
    expect(attack.requests.map((request) => request.path)).toEqual([
      ...PROBE_PATHS,
      "/api/v1/fuzz-0",
      "/api/v1/fuzz-1",
      "/api/v1/fuzz-2",
      "/api/v1/fuzz-3",
      "/api/v1/fuzz-4",
    ]);
    expect(attack.requests[0]?.headers?.["user-agent"]).toContain(
      "Fuzz Faster",
    );
  });

  it("address rotation, the flood and a burst", () => {
    expect(
      addressRotation({
        addresses: ["a", "b"],
        perAddress: 2,
        method: "POST",
      }).requests.map((request) => [request.client, request.method]),
    ).toEqual([
      ["a", "POST"],
      ["a", "POST"],
      ["b", "POST"],
      ["b", "POST"],
    ]);
    expect(
      addressRotation({ addresses: ["a"], body: "{}" }).requests[0]?.body,
    ).toBe("{}");
    expect(
      new Set(
        keyCardinalityFlood({ count: 3000 }).requests.map(
          (request) => request.client,
        ),
      ).size,
    ).toBe(3000);
    expect(
      burst({ count: 3 }).requests.every((request) => request.at === undefined),
    ).toBe(true);
    expect(
      burst({ count: 3, everyMs: 10 }).requests.map((request) => request.at),
    ).toEqual([0, 10, 20]);
  });

  it("a forwarded-for spoof: the peer, claiming another address", () => {
    expect(
      forwardedForSpoof({ peer: "198.51.100.7", claimed: "203.0.113.5" })
        .requests,
    ).toEqual([
      {
        path: "/",
        client: "198.51.100.7",
        headers: { "x-forwarded-for": "203.0.113.5" },
      },
    ]);
  });

  it("crawls carry the crawler's User-Agent; a spoofed one, from an outsider", () => {
    expect(
      crawl({ crawler: "bing", client: "157.55.39.1", paths: ["/"] })
        .requests[0]?.headers?.["user-agent"],
    ).toBe(CRAWLER_USER_AGENTS.bing);
    const spoofed = spoofedCrawler();
    expect(spoofed.name).toBe("spoofed-crawler:google");
    expect(spoofed.requests[0]).toMatchObject({
      client: "203.0.113.70",
      headers: { "user-agent": CRAWLER_USER_AGENTS.google },
    });
  });

  it("disposable sign-ups, a key from many addresses, and cross-site posts", () => {
    const signups = disposableSignups({ count: 4 });
    expect(
      signups.requests.map(
        (request) =>
          (JSON.parse(request.body!) as { email: string }).email.split("@")[1],
      ),
    ).toEqual([
      "mailinator.example",
      "tempmail.example",
      "10minutemail.example",
      "mailinator.example",
    ]);
    const keyed = apiKeyAbuse({ key: "k", count: 3, header: "authorization" });
    expect(new Set(keyed.requests.map((request) => request.client)).size).toBe(
      3,
    );
    expect(keyed.requests[0]?.headers).toEqual({ authorization: "k" });
    const posts = crossSitePosts();
    expect(
      posts.requests.map((request) => [
        request.headers?.["sec-fetch-site"],
        request.headers?.origin,
      ]),
    ).toEqual([
      ["cross-site", "https://evil.example"],
      ["same-origin", "http://app.test"],
      [undefined, "https://evil.example"],
      [undefined, "http://app.test"],
    ]);
    expect(
      posts.requests.every(
        (request) =>
          request.method === "POST" &&
          request.headers?.cookie === "session=victim",
      ),
    ).toBe(true);
  });
});

describe("staticCrawlerResolver", () => {
  it("answers what it knows and rejects the rest with ENOTFOUND", async () => {
    const resolver = staticCrawlerResolver({
      reverse: { "66.249.66.1": ["crawl-66-249-66-1.googlebot.com"] },
      forward: { "crawl-66-249-66-1.googlebot.com": ["66.249.66.1"] },
    });
    expect(await resolver.reverse("66.249.66.1")).toEqual([
      "crawl-66-249-66-1.googlebot.com",
    ]);
    expect(await resolver.lookup("crawl-66-249-66-1.googlebot.com")).toEqual([
      "66.249.66.1",
    ]);
    const missing = await resolver
      .reverse("203.0.113.1")
      .catch((error: unknown) => error);
    expect((missing as { code?: string }).code).toBe("ENOTFOUND");
    expect(
      (
        (await staticCrawlerResolver()
          .lookup("x")
          .catch((error: unknown) => error)) as { code?: string }
      ).code,
    ).toBe("ENOTFOUND");
  });
});
