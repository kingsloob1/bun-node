import process from "node:process";

/**
 * Writes one line of `job.data.bytes` bytes to stdout and one to stderr,
 * then a short line after each; with `job.data.forged`, also that many
 * frame-shaped lines on stdout (the channel's prefix from its argv) whose
 * part is `job.data.bytes` long, and as many frames of messages that are
 * never finished; with `job.data.tooLarge`, the first frame of a message
 * claiming more frames than the channel takes, then that many of its later
 * frames, in one write. Returns `"ok"`.
 */
export default async (job: {
  data: { bytes: number; forged?: number; broken?: number; tooLarge?: number };
}) => {
  const { bytes, forged = 0, broken = 0, tooLarge = 0 } = job.data;
  const prefix = process.argv.at(-2);
  process.stdout.write(`${"o".repeat(bytes)}\nafter the long stdout line\n`);
  process.stderr.write(`${"e".repeat(bytes)}\nafter the long stderr line\n`);
  for (let i = 0; i < forged; i++) {
    process.stdout.write(
      `\n${prefix} zz ${i} ${forged + 1} ${"a".repeat(bytes)}\n`,
    );
  }
  // Frame 0 of a two-frame message, then frame 0 of the next: each cuts the
  // one before it off.
  for (let i = 0; i < broken; i++) {
    process.stdout.write(`\n${prefix} b${i} 0 2 ${"a".repeat(64)}\n`);
  }
  if (tooLarge > 0) {
    // 6000 frames of 2880 bytes: over the channel's 16 MiB.
    let frames = `\n${prefix} tl 0 6000 ${"a".repeat(64)}\n`;
    for (let i = 1; i <= tooLarge; i++) {
      frames += `${prefix} tl ${i} 6000 ${"a".repeat(64)}\n`;
    }
    process.stdout.write(frames);
  }
  await Bun.sleep(50);
  return "ok";
};
