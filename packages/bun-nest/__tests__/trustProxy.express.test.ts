/**
 * bun-common's `trustProxy` against Express 5's `trust proxy`, value for
 * value: the same socket peer, forwarded headers and setting go to an
 * Express request (the app `@nestjs/platform-express` builds) and to a
 * `BunRequest`, and `ip`, `ips`, `protocol`, `host` and `hostname` must
 * agree. Underneath, the address parser and range matcher are compared
 * with the `ipaddr.js` and `proxy-addr` Express itself loads, on fixed and
 * random input. A negative control shows the comparison can fail.
 *
 * It lives in bun-nest because Express is reached here through a declared
 * dependency (`@nestjs/platform-express`), not borrowed from a hoisted copy.
 */
import type { TrustProxyOption } from "@kingsleyweb/bun-common";
import type { Server } from "bun";
import { createRequire } from "node:module";
import {
  BunRequest,
  compileIpMatcher,
  compileTrustProxy,
  isIpAddress,
  parseIpAddress,
} from "@kingsleyweb/bun-common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { describe, expect, it } from "bun:test";

/** The slice of an Express application this test drives. */
interface ExpressApp {
  set: (setting: string, value: unknown) => unknown;
  request: object;
}

/** The fields of an Express request compared here. */
interface ExpressReq {
  ip: string | undefined;
  ips: string[];
  protocol: string;
  host: string | undefined;
  hostname: string | undefined;
}

/** `ipaddr.js` 1.9.1, as proxy-addr uses it. */
interface IpaddrLib {
  isValid: (value: string) => boolean;
  parse: (value: string) => { kind: () => string; toByteArray: () => number[] };
}

/** `proxy-addr`'s `compile`. */
type ProxyAddrCompile = (value: string[]) => (addr: string) => boolean;

// Express and its parsers, resolved through platform-express.
const requireFromPlatform = createRequire(
  import.meta.resolve("@nestjs/platform-express"),
);
const expressPath = requireFromPlatform.resolve("express");
const requireFromExpress = createRequire(expressPath);
const proxyAddrPath = requireFromExpress.resolve("proxy-addr");
const proxyAddr = requireFromExpress("proxy-addr") as {
  compile: ProxyAddrCompile;
};
const ipaddr = createRequire(proxyAddrPath)("ipaddr.js") as IpaddrLib;

/** A fresh Express application, as platform-express creates it. */
function expressApp(): ExpressApp {
  return new ExpressAdapter().getInstance<ExpressApp>();
}

/** One request: its socket peer and headers (lower-case names). */
interface Case {
  peer: string;
  headers: Record<string, string>;
}

/** What Express answers for `c` under `app`'s settings. */
function viaExpress(app: ExpressApp, c: Case): ExpressReq {
  const req = Object.create(app.request) as ExpressReq & {
    headers: Record<string, string>;
    socket: { remoteAddress: string | undefined; encrypted: boolean };
  };
  req.headers = { host: "origin.test:3000", ...c.headers };
  req.socket = {
    remoteAddress: c.peer === "" ? undefined : c.peer,
    encrypted: false,
  };
  return {
    ip: req.ip,
    ips: req.ips,
    protocol: req.protocol,
    host: req.host,
    hostname: req.hostname,
  };
}

/** A server stand-in whose `requestIP()` reports `peer` (none for `""`). */
function serverWithPeer(peer: string): Server<unknown> {
  const stub = {
    requestIP: () =>
      peer === ""
        ? null
        : {
            address: peer,
            port: 40000,
            family: peer.includes(":") ? "IPv6" : "IPv4",
          },
    upgrade: () => false,
    timeout: () => {},
  };
  return stub as unknown as Server<unknown>;
}

/** What bun-common answers for `c` with `trustProxy`. */
async function viaBun(trustProxy: TrustProxyOption, c: Case) {
  const request = new Request("http://origin.test:3000/", {
    headers: { host: "origin.test:3000", ...c.headers },
  });
  const req = await BunRequest.init(request, serverWithPeer(c.peer), {
    parseBody: false,
    trustProxy,
  });
  return {
    // Express has `undefined` where bun-common has `""`: no peer.
    ip: req.ip === "" ? undefined : req.ip,
    ips: req.ips,
    protocol: req.protocol,
    host: req.host,
    hostname: req.hostname,
  };
}

const PEERS = [
  "127.0.0.1",
  "10.0.0.2",
  "100.64.3.4",
  "203.0.113.5",
  "::1",
  "::ffff:10.0.0.2",
  "::ffff:127.0.0.1",
  "2001:db8::5",
  "fe80::1",
  "",
];

const FORWARDED_FOR = [
  undefined,
  "203.0.113.9",
  "198.51.100.1, 203.0.113.9, 10.0.0.2",
  " a , ,b,",
  "2001:db8::1, ::ffff:10.0.0.9",
  "0x7f.0.0.1, 2130706433, 0177.0.0.1",
  "fe80::1%eth0, 10.1.1.1",
  "1.2.3.4:5678, 100.64.0.9",
  "203.0.113.9,10.0.0.2,127.0.0.1",
];

const FORWARDED_PROTO = [undefined, "https", "https, http", " HTTPS "];
const FORWARDED_HOST = [
  undefined,
  "app.example:8443",
  "a.example , b.example",
  "[2001:db8::7]:80",
];

/** The `trust proxy` values compared, by name. */
const TRUST_VALUES: Record<string, TrustProxyOption> = {
  false: false,
  true: true,
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  loopback: "loopback",
  "all presets": "loopback, linklocal, uniquelocal",
  "10/8": "10.0.0.0/8",
  "list with a netmask": ["127.0.0.1", "10.0.0.0/255.0.0.0"],
  "mapped range": "::ffff:10.0.0.0/104",
  "::1": "::1",
  "mapped loopback, no prefix": "::ffff:127.0.0.1",
  "shared range": "100.64.0.0/10",
  "an IPv6 range": "2001:db8::/32",
  function: (addr: string, i: number) =>
    String(addr).startsWith("10.") || i === 0,
};

/** Every request of the matrix. */
function cases(): Case[] {
  const out: Case[] = [];
  for (const peer of PEERS) {
    for (const xff of FORWARDED_FOR) {
      out.push({
        peer,
        headers: xff === undefined ? {} : { "x-forwarded-for": xff },
      });
    }
    FORWARDED_PROTO.forEach((proto, i) => {
      const host = FORWARDED_HOST[i];
      out.push({
        peer,
        headers: {
          ...(proto === undefined ? {} : { "x-forwarded-proto": proto }),
          ...(host === undefined ? {} : { "x-forwarded-host": host }),
        },
      });
    });
  }
  return out;
}

describe("trustProxy against Express 5's trust proxy", () => {
  for (const [name, value] of Object.entries(TRUST_VALUES)) {
    it(`agrees on ip, ips, protocol, host and hostname: ${name}`, async () => {
      const app = expressApp();
      app.set("trust proxy", value);
      const mismatches: string[] = [];
      for (const c of cases()) {
        const expected = viaExpress(app, c);
        const actual = await viaBun(value, c);
        if (!Bun.deepEquals(actual, expected)) {
          mismatches.push(
            `${JSON.stringify(c)}: express ${JSON.stringify(expected)}, bun ${JSON.stringify(actual)}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("refuses what Express refuses, with its messages", () => {
    for (const bad of [
      "",
      "10.0.0.0/0",
      "10.0.0.0/33",
      "nope",
      "10.0.0.0/255.0.255.0",
      ["1.2.3.4", "x"],
    ]) {
      let expressError = "";
      try {
        expressApp().set("trust proxy", bad);
      } catch (error) {
        expressError = String(error);
      }
      let bunError = "";
      try {
        compileTrustProxy(bad as TrustProxyOption);
      } catch (error) {
        bunError = String(error);
      }
      expect(expressError).not.toBe("");
      expect(bunError).toBe(expressError);
    }
  });

  it("negative control: a right-most X-Forwarded-For reading is caught", async () => {
    // The mutant believes the right-most entry whatever the trust: the bug
    // ConcaveHR hit. The same comparison must report it.
    const app = expressApp();
    app.set("trust proxy", "loopback");
    let caught = 0;
    for (const c of cases()) {
      const expected = viaExpress(app, c);
      const actual = await viaBun("loopback", c);
      const entries = (c.headers["x-forwarded-for"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      const mutant = { ...actual, ip: entries.at(-1) ?? actual.ip };
      if (!Bun.deepEquals(mutant, expected)) {
        caught++;
      }
    }
    expect(caught).toBeGreaterThan(10);
  });
});

/** A seeded generator, so a failure names an input that reproduces. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Random strings over the characters an address is written with. */
function randomAddresses(count: number, seed: number): string[] {
  const random = prng(seed);
  const alphabet = "0123456789abcdefABCDEFxX.:%:.0f";
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = 1 + Math.floor(random() * 22);
    let text = "";
    for (let i = 0; i < length; i++) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    out.push(text);
  }
  return out;
}

const FIXED_ADDRESSES = [
  "127.0.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "256.0.0.1",
  "127.1",
  "2130706433",
  "4294967295",
  "4294967296",
  "0x7f.0.0.1",
  "0X7f.0.0.1",
  "0177.0.0.1",
  "09.0.0.1",
  "08.1.2.3",
  "1.2.3.4.5",
  "1.2.3",
  "",
  " 1.2.3.4",
  "::",
  "::1",
  "1::",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7:8:9",
  "1::2::3",
  "::ffff:1.2.3.4",
  "::ffff:0x1.2.3.4",
  "::ffff:010.2.3.4",
  "::ffff:256.2.3.4",
  "fe80::1%eth0",
  "fe80::1%",
  "2001:db8::",
  "2001:DB8::ABCD",
  "12345::1",
  ":1:2:3:4:5:6:7",
  "1.2.3.4:80",
  "[::1]",
  "::ffff:7f00:1",
];

describe("the address parser against ipaddr.js 1.9.1", () => {
  const inputs = [...FIXED_ADDRESSES, ...randomAddresses(20_000, 7)];

  it("accepts and refuses the same strings, parsing each to the same bytes", () => {
    const mismatches: string[] = [];
    for (const input of inputs) {
      const valid = ipaddr.isValid(input);
      if (isIpAddress(input) !== valid) {
        mismatches.push(`${JSON.stringify(input)}: ipaddr ${valid}`);
        continue;
      }
      if (!valid) {
        continue;
      }
      const theirs = ipaddr.parse(input);
      const ours = parseIpAddress(input);
      const bytes =
        ours?.kind === "ipv4"
          ? [...ours.octets]
          : (ours?.parts ?? []).flatMap((part) => [part >> 8, part & 0xff]);
      if (
        ours?.kind !== theirs.kind() ||
        !Bun.deepEquals(bytes, theirs.toByteArray())
      ) {
        mismatches.push(`${JSON.stringify(input)}: parsed differently`);
      }
    }
    expect(mismatches).toEqual([]);
    // The corpus is not all garbage: it exercises both answers.
    expect(
      inputs.filter((input) => ipaddr.isValid(input)).length,
    ).toBeGreaterThan(200);
  });

  const RANGES = [
    "10.0.0.0/8",
    "127.0.0.1",
    "loopback",
    "linklocal",
    "uniquelocal",
    "::ffff:10.0.0.0/104",
    "::ffff:10.0.0.0/95",
    "::ffff:127.0.0.1",
    "2001:db8::/32",
    "::/1",
    "0.0.0.0/1",
    "128.0.0.0/1",
    "192.168.0.0/255.255.0.0",
    "100.64.0.0/10",
  ];
  const CANDIDATES = [
    ...FIXED_ADDRESSES,
    "10.1.2.3",
    "::ffff:10.1.2.3",
    "::ffff:a01:203",
    "100.127.255.255",
    "100.128.0.0",
    "169.254.9.9",
    "fe80::abcd",
    "fc00::1",
    "fd12:3456::1",
    "2001:db8:ffff::1",
    "2001:db9::1",
    "192.168.4.5",
    ...randomAddresses(3000, 11),
  ];

  it("matches each range as proxy-addr's compiled trust does", () => {
    const mismatches: string[] = [];
    for (const range of RANGES) {
      const theirs = proxyAddr.compile([range]);
      const ours = compileIpMatcher([range]);
      for (const candidate of CANDIDATES) {
        if (ours(candidate) !== theirs(candidate)) {
          mismatches.push(
            `${range} ∋ ${JSON.stringify(candidate)}: proxy-addr ${theirs(candidate)}`,
          );
        }
      }
    }
    const theirsAll = proxyAddr.compile(RANGES);
    const oursAll = compileIpMatcher(RANGES);
    for (const candidate of CANDIDATES) {
      if (oursAll(candidate) !== theirsAll(candidate)) {
        mismatches.push(`all ∋ ${JSON.stringify(candidate)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("negative control: the parser comparison catches a stricter IPv4 parser", () => {
    // `node:net`'s isIP refuses the legacy forms ipaddr.js takes.
    const strict = (value: string) =>
      /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(
        value,
      ) ||
      (isIpAddress(value) && value.includes(":"));
    const differing = inputs.filter(
      (input) => strict(input) !== ipaddr.isValid(input),
    );
    expect(differing.length).toBeGreaterThan(0);
  });
});
