import { Buffer } from "node:buffer";
import process from "node:process";
import { encodeFrames } from "../../../lib/runner/bootstrap/container-frames";

/**
 * Not a processor: a script that builds a large non-ASCII message as JSON
 * (about 5M characters, 15 MB of UTF-8), takes its UTF-8 bytes — the least
 * any encoder must hold — and, with `argv[2]` `encode`, also cuts it into
 * frames and drops each. The test compares the two processes' peak RSS:
 * whatever the encoder holds beyond that is its own, measured outside the JS
 * heap too, where a large string's characters live.
 */
const mode = process.argv[2];
const json = JSON.stringify({
  t: "done",
  result: "漢😀é\u0000".repeat(1_000_000),
});
const bytes = Buffer.from(json, "utf8").length;
let frames = 0;
if (mode === "encode") {
  for (const frame of encodeFrames("c".repeat(32), 1, json)) {
    frames += frame.length > 0 ? 1 : 0;
  }
}
// The frames written and the message's UTF-8 length, for the test to check.
process.stdout.write(`${frames} ${bytes}\n`);
