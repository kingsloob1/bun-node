/**
 * The two fixes nest-fixes.ts proves, as a runtime patch: import it, or pass
 * it to `bun test --preload` to run a package's suite with them applied.
 */
import { BunRequest, BunResponse } from "@kingsleyweb/bun-common";

// Fix 1: headers are sent once a response exists, a stream was opened, or
// an upgrade was accepted — not because the socket was asked to keep alive.
Object.defineProperty(BunResponse.prototype, "headersSent", {
  get(this: BunResponse & { _isLongLived: boolean }) {
    return !!this.upgradeToWsData || !!this.settledResponse || this._isLongLived;
  },
});
// Fix 2: setTimeout(0) on the socket shim exempts the request from idleTimeout.
const desc = Object.getOwnPropertyDescriptor(BunRequest.prototype, "socket")!;
const patched = new WeakSet<object>();
Object.defineProperty(BunRequest.prototype, "socket", {
  get(this: BunRequest) {
    const socket = desc.get!.call(this);
    if (!patched.has(socket)) {
      patched.add(socket);
      const original = socket.setTimeout;
      socket.setTimeout = (timeout: number, cb?: () => void) => {
        const server = this.server as { timeout?: (r: Request, s: number) => void } | undefined;
        if (timeout === 0 && typeof server?.timeout === "function") server.timeout(this.request, 0);
        return original(timeout, cb);
      };
    }
    return socket;
  },
});
