/**
 * A `node:net` socket whose peer has closed (its `end` has arrived) answers a
 * `write()` with `false` and calls its callback with EPIPE, but never emits
 * `error` or `drain`: only `close`. Node emits `error` (EPIPE).
 * oven-sh/bun#47834. The `mongodb` driver writes a command as
 * `if (!socket.write(bytes)) await once(socket, "drain")`, so under Bun that
 * write never settles when it lands in that window — a MongoDB server
 * restarting under a live client leaves an operation pending for good.
 *
 *   bun docs/bun-bugs/node-net-write-after-peer-close-no-error.ts
 *
 * Exits 1 while the bug is present, 0 once the write is answered by `error`
 * (or `drain`), as Node answers it.
 */
import { once } from "node:events";
import net from "node:net";
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision}) ${process.platform}-${process.arch}`);

// A server that accepts and closes its side after 50 ms.
const server = net.createServer((peer) => {
  peer.on("error", () => {});
  setTimeout(() => peer.destroy(), 50);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as net.AddressInfo;

const socket = net.connect(port, "127.0.0.1");
await once(socket, "connect");
const events: string[] = [];
for (const name of ["end", "close", "error", "drain"]) {
  socket.on(name, (error?: NodeJS.ErrnoException) => {
    events.push(error?.code === undefined ? name : `${name}(${error.code})`);
  });
}
// The peer's FIN has arrived; 'close' has not been seen yet.
await once(socket, "end");
const wrote = socket.write(new Uint8Array(64));
const outcome = wrote
  ? "write() answered true"
  : await Promise.race([
      once(socket, "drain").then(
        () => "drain",
        (error: NodeJS.ErrnoException) => `error (${error.code})`,
      ),
      Bun.sleep(2_000).then(() => "nothing within 2 s"),
    ]);
console.log(`write() after the peer closed: ${wrote}; then: ${outcome}`);
console.log(`events: ${events.join(", ")}`);
console.log("Node v24.2.0 answers: false; then: error (EPIPE); events: end, error(EPIPE)");
socket.destroy();
server.close();
const present = outcome === "nothing within 2 s";
console.log(present ? "PRESENT: the write never settles" : "fixed");
process.exit(present ? 1 : 0);
