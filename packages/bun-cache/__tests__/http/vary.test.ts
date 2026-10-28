/**
 * `Vary` variants (plan §9.1): the response's own `Vary` is learned per URL.
 * The base key holds a vary record naming the headers and carrying the
 * first variant; every other combination of values gets a key of its own.
 */
import { describe, expect, test } from "bun:test";
import { BunRouter } from "@kingsleyweb/bun-common";
import { cacheResponse } from "../../lib/http/index";
import { frameAt, keyFor, makeHttpCache, nextSet } from "./helpers";

/** A router whose `/greet` answers in the request's `Accept-Language`, `Vary: Accept-Language`. */
function greeter(vary = "Accept-Language") {
  const cache = makeHttpCache();
  const router = new BunRouter();
  let runs = 0;
  let varyOn = vary;
  router.get("/greet", cacheResponse(cache, { ttl: 60_000 }), (req, res) => {
    runs++;
    res.setHeader("Vary", varyOn);
    res.send(`${req.getHeader("accept-language") ?? "none"} #${runs}`);
  });
  const ask = async (lang?: string) => {
    const response = await router.fetch(
      "/greet",
      lang === undefined ? {} : { headers: { "accept-language": lang } },
    );
    return {
      status: response.headers.get("x-cache"),
      text: await response.text(),
    };
  };
  return {
    cache,
    ask,
    runs: () => runs,
    setVary: (value: string) => {
      varyOn = value;
    },
  };
}

describe("Vary", () => {
  test("each value of a varied header is its own entry; the first is carried by the base key's record", async () => {
    const { cache, ask, runs } = greeter();
    let written = nextSet(cache);
    expect(await ask("en")).toEqual({ status: "MISS", text: "en #1" });
    await written;
    const base = await frameAt(cache, keyFor("/greet"));
    expect(base?.kind).toBe("vary");
    if (base?.kind === "vary") {
      expect(base.record.vary).toEqual(["accept-language"]);
      expect(base.record.values).toEqual(["en"]);
    }

    written = nextSet(cache);
    expect(await ask("fr")).toEqual({ status: "MISS", text: "fr #2" });
    await written;
    expect(await ask("en")).toEqual({ status: "HIT", text: "en #1" });
    expect(await ask("fr")).toEqual({ status: "HIT", text: "fr #2" });
    written = nextSet(cache);
    expect(await ask()).toEqual({ status: "MISS", text: "none #3" });
    await written;
    expect(await ask()).toEqual({ status: "HIT", text: "none #3" });
    expect(runs()).toBe(3);
  });

  test("Vary names are case-insensitive and order-free", async () => {
    const { cache, ask } = greeter("ACCEPT-language, X-Unused");
    const written = nextSet(cache);
    await ask("en");
    await written;
    const base = await frameAt(cache, keyFor("/greet"));
    expect(base?.kind === "vary" ? base.record.vary : []).toEqual([
      "accept-language",
      "x-unused",
    ]);
    expect((await ask("en")).status).toBe("HIT");
  });

  test("a response whose Vary changed under its base key is not stored there; the base key is relearned", async () => {
    const { cache, ask, setVary } = greeter();
    let written = nextSet(cache);
    await ask("en");
    await written;
    setVary("Accept-Language, X-Theme");
    // "fr" reads the variant key of the old record; its answer varies on
    // more now, so it is not stored, and the record is dropped.
    expect((await ask("fr")).status).toBe("MISS");
    await Bun.sleep(5);
    expect(await frameAt(cache, keyFor("/greet"))).toBeUndefined();
    written = nextSet(cache);
    await ask("fr");
    await written;
    const relearned = await frameAt(cache, keyFor("/greet"));
    expect(relearned?.kind === "vary" ? relearned.record.vary : []).toEqual([
      "accept-language",
      "x-theme",
    ]);
  });
});
