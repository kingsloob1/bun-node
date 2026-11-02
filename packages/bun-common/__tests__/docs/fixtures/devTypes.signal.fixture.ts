/**
 * A child process for devTypes.test.ts: serves an app with `devTypes()` and a
 * token file, prints `ready <token file>` and waits to be signalled.
 *
 * Environment: `TOKEN_FILE` (the file's template), `MODE`: `plain` (no signal
 * handler of its own), `own` (a `SIGTERM` handler that exits 7), `nofile`
 * (`tokenFile: false`).
 */
import process from "node:process";
import { BunHttpAdapter } from "../../../lib/BunHttpAdapter";
import { devTypes } from "../../../lib/docs/devTypes";

const mode = process.env.MODE ?? "plain";
const app = new BunHttpAdapter(0);
const dev = devTypes(app, {
  enabled: true,
  tokenFile: mode === "nofile" ? false : (process.env.TOKEN_FILE ?? false),
});
app.use(dev);
if (mode === "own") {
  process.on("SIGTERM", () => {
    process.exit(7);
  });
}
await app.listen(0);
process.stdout.write(
  `ready ${dev.tokenFile ?? "-"} ${process.listenerCount("SIGTERM")}\n`,
);
setInterval(() => {}, 1000);
