/**
 * A hardened server for T-L1-1, run in a child process: listens on port 0
 * with `hardenServe({ idleTimeout: <argv[2]> })` and prints its port.
 */
import { hardenServe } from "../../lib/serve/index";

const idleTimeout = Number(process.argv[2] ?? "10");
const server = Bun.serve(
  hardenServe(
    {
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout,
      fetch: () => new Response("ok"),
    },
    { production: false },
  ),
);
process.stdout.write(`${server.port}\n`);
