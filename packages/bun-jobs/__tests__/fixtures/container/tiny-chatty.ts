/** Prints `job.data.lines` lines of one character each, then returns the count. */
export default async (job: { data: unknown }) => {
  const { lines } = job.data as { lines: number };
  let chunk = "";
  for (let i = 0; i < lines; i++) {
    chunk += "x\n";
    if (chunk.length >= 64 * 1024) {
      await Bun.write(Bun.stdout, chunk);
      chunk = "";
    }
  }
  if (chunk) {
    await Bun.write(Bun.stdout, chunk);
  }
  return lines;
};
