import type { Server } from "bun";
import { BunRequest, BunResponse, BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunNestWebsocketAdapter } from "../lib/BunWebSocketAdapter";

let bunServer!: Server<unknown>;
let httpAdapter!: BunHttpAdapter<unknown>;
let bunRequest!: BunRequest;

beforeAll(async () => {
  bunServer = Bun.serve({
    port: 0,
    fetch() {
      return new Response("hi");
    },
  });
  bunRequest = new BunRequest(new Request("https://google.com"), bunServer);
  httpAdapter = new BunHttpAdapter(10000);
});

afterAll(async () => {
  await bunServer?.stop(true);
  await httpAdapter.close();
});

describe("Test Bun Http Adapter For Nest", () => {
  test("Can initialize Bun Request", () => {
    expect(bunRequest).toBeInstanceOf(BunRequest);
  });

  test("Can initialize Bun Response", () => {
    expect(new BunResponse(bunRequest)).toBeInstanceOf(BunResponse);
  });

  test("Can initialize Bun Router", () => {
    expect(new BunRouter()).toBeInstanceOf(BunRouter);
  });

  test("Can initialize http adapter", () => {
    expect(
      new BunNestWebsocketAdapter({
        httpAdapter,
      }),
    ).toBeInstanceOf(BunNestWebsocketAdapter);
  });
});
