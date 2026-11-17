/**
 * Deception: honeypot routes no one legitimate visits, canary credentials no
 * one legitimate uses, and a form field no person sees.
 *
 * ```bash
 * bun 08-deception/honeypots-and-canaries.ts
 * ```
 *
 * - A honeypot hit is answered as a real route would be (here the router's
 *   missing page: the scanner cannot tell), weighs 10 on the offence
 *   ladder, and so bans the client from its next request.
 * - A canary is a user or API key id planted where only a leak would find it
 *   (a backup, a seed file). Any use is refused at once, weighs 100, and
 *   raises a `canary.used` warning naming it: that says where the leak was.
 * - `trapField()` renders an input moved off screen; a bot fills it. The app
 *   checks it with `isTrapFilled()` and signals `trap.filled` (weight 10).
 */
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { BunRequest } from "@kingsleyweb/bun-common";
import {
  createSecurity,
  isTrapFilled,
  trapField,
} from "@kingsleyweb/bun-security";
import type { SecurityWarning } from "@kingsleyweb/bun-security";
import {
  installSecurity,
  requestSecurity,
} from "@kingsleyweb/bun-security/http";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title } from "../shared/console";

title("honeypots, canaries and trap fields");

const warnings: SecurityWarning[] = [];
const security = createSecurity<BunRequest>({
  policy: {
    deception: {
      honeypots: true, // "/wp-login.php", "/.env", "/admin.php"
      canaries: [{ id: "backup-2026-q3", apiKey: "key_planted_in_backup" }],
    },
  },
  // The app says which key is calling; the engine knows the canary by its id.
  identify: (req) => {
    const apiKey = req.request.headers.get("x-api-key");
    return apiKey === null ? undefined : { apiKey };
  },
  onWarning: (warning) => warnings.push(warning),
  logger: () => {},
});

const app = new BunHttpAdapter(0, { logger: () => {} });
await installSecurity(app, security, { logger: () => {} });

const trap = trapField({ name: "website" });
app.get("/signup", (_req, res) =>
  res
    .type("html")
    .send(`<form method="post">${trap.html}<input name="email"></form>`),
);
app.post("/signup", async (req, res) => {
  // The parsed form, as bun-common's body parser left it.
  const form = (req.body ?? {}) as Readonly<Record<string, unknown>>;
  if (isTrapFilled(form, trap.name)) {
    const facts = requestSecurity(req)?.facts;
    if (facts !== undefined) await security.signal(facts, "trap.filled");
    return res.status(400).json({ error: "could not sign you up" });
  }
  return res.status(201).json({ ok: true });
});
app.get("/reports", (_req, res) => res.json({ reports: [] }));

/** A request from `client`. */
const get = async (
  path: string,
  client: string,
  headers: Record<string, string> = {},
) => {
  const response = await app.fetch(path, { remoteAddress: client, headers });
  await response.body?.cancel();
  return response.status;
};

/* ------------------------------------------------------------------ */
step("a honeypot: answered like any missing page, then the client is banned");
const scanner = "203.0.113.20";
const first = await get("/admin.php", scanner);
const next = await get("/reports", scanner);
show("/admin.php, then /reports", [first, next]);
checkEqual("the honeypot looks like a missing page", first, 404);
checkEqual("the next request is refused", next, 403);
checkEqual(
  "the ladder banned it",
  security.bans().map((b) => [b.id, b.rule]),
  [[`ip:${scanner}`, "ladder"]],
);

/* ------------------------------------------------------------------ */
step("a canary key: refused at once, with a warning naming the leak");
const leaked = await get("/reports", "198.51.100.40", {
  "x-api-key": "key_planted_in_backup",
});
checkEqual("refused", leaked, 403);
const canary = warnings.find((w) => w.kind === "canary.used");
show("warning", canary?.message);
check(
  "the warning names the canary",
  canary?.message.includes("backup-2026-q3") === true,
  warnings,
);
checkEqual(
  "an ordinary key passes",
  await get("/reports", "198.51.100.41", { "x-api-key": "key_real" }),
  200,
);

/* ------------------------------------------------------------------ */
step("a trap field: a person leaves it empty, a bot fills it");
const page = await app.fetch("/signup", { remoteAddress: "198.51.100.50" });
check(
  "the form carries the hidden field",
  (await page.text()).includes('name="website"'),
);
/** Posts the sign-up form from `client`. */
const post = async (client: string, body: string) => {
  const response = await app.fetch("/signup", {
    method: "POST",
    remoteAddress: client,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  await response.body?.cancel();
  return response.status;
};
checkEqual(
  "a person signs up",
  await post("198.51.100.50", "email=ada%40mail.org&website="),
  201,
);
const bot = "198.51.100.51";
checkEqual(
  "a bot's filled trap is refused",
  await post(bot, "email=x%40mail.org&website=http%3A%2F%2Fspam"),
  400,
);
checkEqual(
  "…and weighs 10: banned from its next request",
  await get("/reports", bot),
  403,
);

security.close();
summary();
