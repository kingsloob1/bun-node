/**
 * The smoke check for `nest-jobs.ts`: starts it on its own port with no simulation, and checks
 * through `fetch` that processors ran, `@Cron` and `@Every` fired, the pipeline refused what it
 * should, and the guard denies on the API and the UI. Then it stops it with SIGINT.
 *
 * ```bash
 * bun playground/nest-jobs-smoke.ts
 * ```
 */
import process from "node:process";

/** What `/status` answers. */
interface Status {
  completed: Record<string, number>;
  ticks: { cron: number; every: number };
  dead: {
    queue: string;
    name: string;
    attempts: number;
    error: string;
    message?: string;
  }[];
}

let failures = 0;

/** One check. */
function check(what: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) {
      console.log(`      ${JSON.stringify(detail)}`);
    }
  }
}

const child = Bun.spawn(["bun", "nest-jobs.ts"], {
  cwd: import.meta.dir,
  env: { ...process.env, PORT_NEST_JOBS: "0", PLAYGROUND_INTERVAL_MS: "0" },
  stdout: "pipe",
  stderr: "inherit",
});

/** Reads the banner for the URL. */
async function urlOfChild(): Promise<string> {
  let seen = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    seen += decoder.decode(chunk, { stream: true });
    const found = /Start\s+(http:\/\/\S+)/.exec(seen)?.[1];
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`nest-jobs.ts printed no URL:\n${seen}`);
}

const url = await Promise.race([
  urlOfChild(),
  Bun.sleep(20_000).then(() => {
    throw new Error("nest-jobs.ts did not start within 20 s");
  }),
]);

/** Reads `/status`. */
async function status(): Promise<Status> {
  return (await (await fetch(`${url}/status`)).json()) as Status;
}

/** Waits for a condition on `/status`, answering the last one seen. */
async function until(test: (seen: Status) => boolean): Promise<Status> {
  const by = Date.now() + 10_000;
  let seen = await status();
  while (!test(seen) && Date.now() < by) {
    await Bun.sleep(50);
    seen = await status();
  }
  return seen;
}

try {
  const seeded = await until(
    (seen) =>
      seen.dead.length >= 3 &&
      seen.completed.welcome === 1 &&
      seen.completed.charge === 1 &&
      seen.completed.refund === 1,
  );
  check("a processor ran, through DI", seeded.completed.welcome === 1, seeded);
  check(
    "a charge and an approved refund ran",
    seeded.completed.charge === 1 && seeded.completed.refund === 1,
    seeded,
  );

  const refund = seeded.dead.find((job) => job.name === "refund");
  check(
    "a guard denied the unapproved refund: dead at once, whatever its attempts",
    refund?.message?.includes("a guard denied") === true &&
      refund.attempts === 1,
    refund,
  );
  const charges = seeded.dead.filter((job) => job.name === "charge");
  check(
    "a pipe refused a charge that is not a number",
    charges.some((job) => /numeric string/.test(job.message ?? "")),
    charges,
  );
  check(
    "a filter ended the declined card at once, of 3 attempts",
    charges.some(
      (job) =>
        job.message?.includes("over the limit") === true && job.attempts === 1,
    ),
    charges,
  );

  const ticking = await until(
    (seen) => seen.ticks.cron >= 2 && seen.ticks.every >= 2,
  );
  check("@Cron fired, more than once", ticking.ticks.cron >= 2, ticking.ticks);
  check(
    "@Every fired, more than once",
    ticking.ticks.every >= 2,
    ticking.ticks,
  );

  const page = await fetch(url);
  check(
    "the page shows where to go",
    page.status === 200 && (await page.text()).includes("/jobs-api/queues"),
  );

  const before = ticking.completed.welcome ?? 0;
  const ordered = await fetch(`${url}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "grace@example.com", cents: 700 }),
  });
  check(
    "an order over HTTP is accepted",
    ordered.status === 201,
    ordered.status,
  );
  const afterOrder = await until(
    (seen) => seen.completed.welcome === before + 1,
  );
  check(
    "and its job runs",
    afterOrder.completed.welcome === before + 1,
    afterOrder,
  );

  const asRole = (role?: string): Record<string, string> =>
    role === undefined ? {} : { cookie: `role=${role}` };
  const api = async (method: string, path: string, role?: string) => {
    const response = await fetch(`${url}/jobs-api${path}`, {
      method,
      headers: { "content-type": "application/json", ...asRole(role) },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    const problem = (await response.json()) as { code?: string };
    return [response.status, problem.code];
  };
  check(
    "the API, signed out: 401",
    String(await api("GET", "/queues")) === "401,UNAUTHORIZED",
  );
  const [read] = await api("GET", "/queues", "reader");
  check("the API, as a reader: reads", read === 200, read);
  check(
    "the API, as a reader: a pause is denied, 403",
    String(await api("POST", "/queues/emails/pause", "reader")) ===
      "403,FORBIDDEN",
  );
  const [paused] = await api("POST", "/queues/emails/pause", "admin");
  check("the API, as an admin: pauses", paused === 200, paused);
  await api("POST", "/queues/emails/resume", "admin");

  const shell = async (role?: string) =>
    (await fetch(`${url}/jobs`, { headers: asRole(role) })).status;
  check("the UI, signed out: 401", (await shell()) === 401);
  check("the UI, as a reader: the shell", (await shell("reader")) === 200);

  const socket = (role?: string) =>
    new Promise<string>((resolve) => {
      const ws = new WebSocket(`${url.replace("http", "ws")}/jobs-api/ws`, {
        headers: asRole(role),
      });
      ws.addEventListener("open", () => {
        ws.close();
        resolve("connected");
      });
      ws.addEventListener("error", () => {
        resolve("refused");
      });
    });
  check("the socket, signed out: refused", (await socket()) === "refused");
  check(
    "the socket, as a reader: connects",
    (await socket("reader")) === "connected",
  );
} finally {
  child.kill("SIGINT");
}
const code = await Promise.race([
  child.exited,
  Bun.sleep(5_000).then(() => "still running"),
]);
check("Ctrl+C stops it cleanly", code === 0, code);
if (code !== 0) {
  child.kill("SIGKILL");
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
