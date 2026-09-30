import { ConfigError } from "@kingsleyweb/bun-jobs/provider";
import { describe, expect, it } from "bun:test";
import { acme } from "../src/index";

/**
 * The config rules the conformance kit cannot know: the bearer token goes on
 * every call, so it may cross plain HTTP only to this machine.
 */

/** A config pointing at `url`. */
function at(url: string) {
  return {
    url,
    region: "eu-west",
    pool: "workers",
    apiToken: "acme-test-token-0123456789",
  };
}

/** The issue paths of what configuring with `config` threw, or `[]` when it did not throw. */
function refused(config: ReturnType<typeof at>): string[] {
  try {
    acme(config);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const issues = (error as ConfigError).context?.issues as {
      /** The dotted path. */
      path: string;
    }[];
    return issues.map((issue) => issue.path);
  }
}

describe("url", () => {
  it("accepts https anywhere, and http only to this machine", () => {
    for (const url of [
      "https://api.acme-compute.example",
      "https://10.0.0.5:8443/",
      "http://localhost:4000",
      "http://127.0.0.1:41234",
      "http://[::1]:8080",
    ]) {
      expect(refused(at(url)), url).toEqual([]);
    }
  });

  it("refuses plain http to any other host, and what is not a URL", () => {
    for (const url of [
      "http://api.acme-compute.example",
      "http://10.0.0.5",
      "http://localhost.evil.example",
      "http://127.0.0.2",
      "ftp://api.acme-compute.example",
      "api.acme-compute.example",
      "https://",
    ]) {
      expect(refused(at(url)), url).toEqual(["url"]);
    }
  });

  it("says why an http URL was refused", () => {
    expect(() => acme(at("http://api.acme-compute.example"))).toThrow(/https/);
  });
});
