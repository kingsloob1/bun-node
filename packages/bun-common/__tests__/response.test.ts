import type { Server } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunRequest, BunResponse } from "../lib";

let server!: Server;
beforeAll(() => {
  server = Bun.serve({
    fetch() {},
    websocket: {
      drain() {},
      message() {},
      open() {},
      close() {},
    },
  });
  // setup tests
});

afterAll(() => {
  server.stop(true);
});

describe("Test Bun Response", () => {
  test("Can initialize response", () => {
    const request = new BunRequest(new Request("https://google.com"), server);
    expect(new BunResponse(request)).toBeInstanceOf(BunResponse);
  });
});
