import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { BunRequest, BunResponse } from '../lib';
import type { Server } from 'bun';

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

describe('Test Bun Request', () => {
  test('Can initialize request', () => {
    expect(
      new BunRequest(new Request('https://google.com'), server),
    ).toBeInstanceOf(BunRequest);
  });
});

describe('Test Bun Response', () => {
  test('Can initialize response', () => {
    const request = new BunRequest(new Request('https://google.com'), server);
    expect(new BunResponse(request)).toBeInstanceOf(BunResponse);
  });
});
