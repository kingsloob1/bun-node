/**
 * Prints 32 KiB lines from a timer, without pause, while it returns a result
 * of `job.data.bytes` characters: the processor's own output racing the
 * runner's largest message on the same stdout.
 */
export default async (job: { data: unknown }) => {
  const { bytes } = job.data as { bytes: number };
  const line = "n".repeat(32 * 1024);
  const timer = setInterval(() => {
    // eslint-disable-next-line no-console -- the noise is the point
    console.log(line);
  }, 0);
  await Bun.sleep(30);
  // Returned while the timer still runs: it is never cleared.
  void timer;
  return "r".repeat(bytes);
};
