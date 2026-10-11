// A single-use job runner: says it is ready, runs exactly one NDJSON job from
// stdin, writes its result, and exits (so its container is removed).
process.stdout.write("ready\n");
for await (const line of console) {
  if (line.length === 0) continue;
  const job = JSON.parse(line) as { id: number; n: number };
  process.stdout.write(`${JSON.stringify({ id: job.id, result: job.n * 2 })}\n`);
  break;
}
process.exit(0);
