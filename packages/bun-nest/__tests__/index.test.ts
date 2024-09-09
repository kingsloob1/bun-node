import { describe, expect, test } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";

describe("Test Bun Http Adapter For Nest", () => {
  test("Can initialize http adapter", () => {
    expect(new BunHttpAdapter()).toBeInstanceOf(BunHttpAdapter);
  });
});
