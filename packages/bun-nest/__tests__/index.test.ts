import type { Server } from "bun";
import type {
  BunNestWebSocketClient,
  WsAckFunction,
  WsEmitFunction,
  WsResponse,
  WsResponseTransform,
} from "../lib";
import { BunRequest, BunResponse, BunRouter } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { of } from "rxjs";
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

  test("exports the WebSocket reply, ack and emit types", () => {
    // Compile-time: these imports fail the tests typecheck if not exported.
    const response: WsResponse<number> = { event: "n", data: 1 };
    const ack: WsAckFunction = () => undefined;
    const emit: WsEmitFunction = () => true;
    const transform: WsResponseTransform = (value) => of(value);
    const client = { emit } as unknown as BunNestWebSocketClient;

    expect([response.event, typeof ack, typeof transform]).toEqual([
      "n",
      "function",
      "function",
    ]);
    expect(client.emit("x")).toBe(true);
  });

  test("Can initialize http adapter", () => {
    expect(
      new BunNestWebsocketAdapter({
        httpAdapter,
      }),
    ).toBeInstanceOf(BunNestWebsocketAdapter);
  });
});
