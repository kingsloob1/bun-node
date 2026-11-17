/**
 * The kit's `connect-src` sources: with sockets (the default, the jobs UI)
 * the page origin's and the API's `ws(s)` forms; with `sockets: false` (the
 * security UI, whose live updates are server-sent events) none, only a
 * cross-origin API's `http(s)` origin.
 */
import { describe, expect, it } from "bun:test";
import { connectSources } from "../../../lib/kit/connect";

describe("connectSources", () => {
  it("adds the ws(s) forms by default", () => {
    expect(
      connectSources({
        host: "h.example:81",
        secure: true,
        apiOrigin: "https://api.example",
      }),
    ).toEqual([
      "wss://h.example:81",
      "https://api.example",
      "wss://api.example",
    ]);
  });

  it("with sockets: false, no ws(s) source at all", () => {
    expect(
      connectSources({ host: "h.example:81", secure: true, sockets: false }),
    ).toEqual([]);
    expect(
      connectSources({
        host: "h.example",
        secure: false,
        apiOrigin: "https://api.example:8443",
        websocketPort: 9000,
        sockets: false,
      }),
    ).toEqual(["https://api.example:8443"]);
  });
});
