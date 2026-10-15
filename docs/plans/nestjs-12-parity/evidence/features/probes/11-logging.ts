/**
 * Item 11: do Nest 12's logger changes (#17893, structured params 2dbaae86b/5dafe4586,
 * opt-out 4ab3ce86d) alter what BunHttpAdapter logs? Replays the adapter's exact
 * call shapes (BunHttpAdapter.ts:500, 1035, 1181/1183, 1407, 3244) on ConsoleLogger,
 * text and json, and triggers the real `disable("x-powered-by")` warning.
 */
import { ConsoleLogger, Controller, Get, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { nestVersion } from "./harness";

const lines: string[] = [];
const capture = (s: any) => {
  lines.push(String(s).replace(/\x1b\[[0-9;]*m/g, "").replace(/\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/, "<ts>").replace(/"timestamp":\d+/, '"timestamp":0').replace(/^\[Nest\] \d+/, "[Nest] <pid>").replace(/"pid":\d+/, '"pid":0').trimEnd());
  return true;
};
const ow = process.stdout.write.bind(process.stdout);
const ew = process.stderr.write.bind(process.stderr);
function grab(fn: () => void) {
  lines.length = 0;
  (process.stdout as any).write = capture;
  (process.stderr as any).write = capture;
  try {
    fn();
  } finally {
    (process.stdout as any).write = ow;
    (process.stderr as any).write = ew;
  }
  return lines.slice();
}
const stack = "Error: boom\n    at handler (/app/x.ts:1:1)";
const shapes: Record<string, (l: any) => void> = {
  "500 error(msg, stack)": (l) => l.error("Error after a streaming response started", stack),
  "1035 error(msg, String(nonError))": (l) => l.error("Error while binding to 127.0.0.1:1", "not an Error"),
  "1181 warn(msg, stack)": (l) => l.warn("Not Found (GET /x, 404)", stack),
  "1407 error(msg, errorObject)": (l) => l.error("An error occurred while closing bun http adapter ====> ", new Error("boom")),
  "3244 warn(msg)": (l) => l.warn('app.set("x-powered-by") has no effect on BunHttpAdapter'),
  "control: warn(msg, plainObject)": (l) => l.warn("with params", { userId: 1 }),
};
const out: any = { probe: "11-logging", nest: nestVersion(), bun: Bun.version };
for (const json of [false, true]) {
  const logger = new ConsoleLogger("", { colors: false, json, timestamp: false } as any);
  const r: Record<string, string[]> = {};
  for (const [k, fn] of Object.entries(shapes)) r[k] = grab(() => fn(logger));
  out[json ? "json" : "text"] = r;
}

@Controller()
class C {
  @Get()
  g() {
    return "x";
  }
}
@Module({ controllers: [C] })
class M {}
const { BunHttpAdapter } = await import("@kingsleyweb/bun-nest");
const app: any = await NestFactory.create(M, new BunHttpAdapter(), { logger: ["warn", "error"] });
out.useSecurityHeadersWarning = typeof app.useSecurityHeaders === "function" ? grab(() => app.useSecurityHeaders()) : "n/a (Nest 11)";
out.defaultAdapterLoggerContext = (app.getHttpAdapter() as any).logger?.context ?? null;
await app.close();
console.log(JSON.stringify(out, null, 2));
process.exit(0);
