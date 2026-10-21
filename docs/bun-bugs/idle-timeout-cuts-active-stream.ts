/**
 * `Bun.serve`'s `idleTimeout` from 1 to 4 cuts a response that is actively
 * streaming at the first 4-second timeout sweep: the server writes every
 * 50 ms and the client reads every chunk, yet the stream is cut at about
 * 4.0 s. `idleTimeout: 5` (and `0`, no timeout) keep the same stream open.
 *
 *   bun docs/bun-bugs/idle-timeout-cuts-active-stream.ts
 *
 * Takes about 18 s: three 6 s streams, one after another.
 * Exits 1 while the behaviour is present, 0 once it is fixed.
 */
import process from "node:process";

console.log(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)})`);

/** How long a client reads a stream, in ms: past one sweep, with room. */
const READ_FOR = 6000;

/** Streams `x\n` every 50 ms for `READ_FOR` ms; how the client's read ended. */
async function stream(idleTimeout: number): Promise<string> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout,
    fetch: () => {
      let timer: Timer | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(
              () => controller.enqueue(new TextEncoder().encode("x\n")),
              50,
            );
          },
          cancel() {
            clearInterval(timer);
          },
        }),
      );
    },
  });
  const reader = (await fetch(server.url)).body!.getReader();
  let bytes = 0;
  let end = `open at ${READ_FOR} ms`;
  try {
    while (ms() < READ_FOR) {
      const chunk = await reader.read();
      if (chunk.done) {
        end = `ended at ${ms()} ms`;
        break;
      }
      bytes += chunk.value.length;
    }
  } catch (error) {
    end = `${(error as Error).name} at ${ms()} ms`;
  }
  await reader.cancel().catch(() => undefined);
  await server.stop(true);
  return `${end}, ${bytes} bytes read`;
}

let present = false;
// The controls first: no timeout, and the smallest value that is fine.
for (const idleTimeout of [0, 5, 4]) {
  const outcome = await stream(idleTimeout);
  const open = outcome.startsWith("open");
  if (idleTimeout === 4 && !open) present = true;
  console.log(
    `${open ? "open" : "CUT "}  idleTimeout ${idleTimeout}: ${outcome}`,
  );
}
process.exit(present ? 1 : 0);
