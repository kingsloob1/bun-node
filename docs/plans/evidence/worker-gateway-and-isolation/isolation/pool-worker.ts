// A long-lived job loop: one NDJSON job per stdin line, one NDJSON result
// per stdout line. The job is trivial on purpose, so what gets measured is
// the transport and the isolation, not the work.
//   {"id":1,"n":21}  ->  {"id":1,"result":42}

for await (const line of console) {
  if (line.length === 0) continue;
  const job = JSON.parse(line) as { id: number; n: number };
  process.stdout.write(`${JSON.stringify({ id: job.id, result: job.n * 2 })}\n`);
}
