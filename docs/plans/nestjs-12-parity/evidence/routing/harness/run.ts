/**
 * Runs every group of `probes.ts` on `@nestjs/platform-express` and on
 * bun-nest's `BunHttpAdapter`, on whatever Nest the cwd's node_modules
 * resolve, and writes the raw outcomes as JSON.
 *
 *   bun run.ts <out.json> [group-name-filter]
 *
 * Express is served on port 0 and asked with `fetch`; the Bun adapter is
 * asked through its socket-free `adapter.fetch()` and, as a cross-check,
 * over its own socket (port 0) too.
 */
import type { LoggerService } from "@nestjs/common";
import type { Group, Probe, Side } from "./probes";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { BunHttpAdapter } from "../packages/bun-nest/lib/BunHttpAdapter";
import { GROUPS } from "./probes";

const require = createRequire(import.meta.url);
function versionOf(pkg: string): string {
  const file = require.resolve(`${pkg}/package.json`);
  return JSON.parse(readFileSync(file, "utf8")).version;
}

const nestVersions = {
  core: versionOf("@nestjs/core"),
  common: versionOf("@nestjs/common"),
  "platform-express": versionOf("@nestjs/platform-express"),
  express: versionOf("express"),
  "path-to-regexp": versionOf("path-to-regexp"),
};
const isNest12 = nestVersions.core.startsWith("12.");

/** Records warnings and errors the application logs while it boots. */
class CaptureLogger implements LoggerService {
  entries: { level: string; context?: string; message: string }[] = [];
  private push(level: string, message: unknown, rest: unknown[]) {
    const context = typeof rest.at(-1) === "string" ? (rest.at(-1) as string) : undefined;
    const text = message instanceof Error ? message.message : String(message);
    this.entries.push({ level, context, message: text });
  }
  log() {}
  debug() {}
  verbose() {}
  warn(message: unknown, ...rest: unknown[]) {
    this.push("warn", message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.push("error", message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.push("fatal", message, rest);
  }
}

export interface Outcome {
  status?: number;
  body?: unknown;
  contentType?: string | null;
  allow?: string | null;
  xPoweredBy?: string | null;
  trail?: string | null;
  handler?: string | null;
  location?: string | null;
  xCustom?: string | null;
  error?: string;
}

const RECORDED = {
  contentType: "content-type",
  allow: "allow",
  xPoweredBy: "x-powered-by",
  trail: "x-trail",
  handler: "x-h",
  location: "location",
  xCustom: "x-custom",
} as const;

async function record(res: Response): Promise<Outcome> {
  const out: Outcome = { status: res.status };
  for (const [key, name] of Object.entries(RECORDED)) {
    (out as Record<string, unknown>)[key] = res.headers.get(name);
  }
  const text = await res.text();
  try {
    out.body = text === "" ? "" : JSON.parse(text);
  } catch {
    out.body = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function initOf(probe: Probe): RequestInit {
  return {
    method: probe.method ?? "GET",
    headers: probe.headers,
    body: probe.body,
    redirect: "manual",
  };
}

/**
 * Sends the request over a raw TCP socket and parses the reply. Used for a
 * path starting with `//`: Bun's `fetch` client sends `//a//b` as `/a//b`
 * (Node's sends it as given), so `fetch` cannot deliver that request target.
 */
function rawRequest(base: string, probe: Probe): Promise<Response> {
  const { hostname, port } = new URL(base);
  const headers: Record<string, string> = { host: `${hostname}:${port}`, connection: "close", ...probe.headers };
  const head = [`${probe.method ?? "GET"} ${probe.path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(Number(port), hostname, () => socket.write(`${head.join("\r\n")}\r\n\r\n`));
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", reject);
    socket.on("close", () => {
      const all = Buffer.concat(chunks);
      const split = all.indexOf("\r\n\r\n");
      const lines = all.subarray(0, split).toString("latin1").split("\r\n");
      const status = Number(lines[0].split(" ")[1]);
      const h = new Headers();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      let body = all.subarray(split + 4);
      if (h.get("transfer-encoding")?.includes("chunked")) {
        const parts: Buffer[] = [];
        let at = 0;
        for (;;) {
          const eol = body.indexOf("\r\n", at);
          const size = Number.parseInt(body.subarray(at, eol).toString(), 16);
          if (!size) break;
          parts.push(body.subarray(eol + 2, eol + 2 + size));
          at = eol + 2 + size + 2;
        }
        body = Buffer.concat(parts);
      }
      h.delete("transfer-encoding");
      resolve(new Response(probe.method === "HEAD" || status === 204 || status === 304 ? null : body, { status, headers: h }));
    });
  });
}

async function viaSocket(base: string, probe: Probe): Promise<Outcome> {
  try {
    if (probe.path.startsWith("//")) return await withTimeout(rawRequest(base, probe).then(record));
    return await withTimeout(fetch(`${base}${probe.path}`, initOf(probe)).then(record));
  } catch (error) {
    return { error: String(error) };
  }
}

async function viaAdapterFetch(adapter: BunHttpAdapter, probe: Probe): Promise<Outcome> {
  try {
    // A full URL, so `//a//b` is not read as a protocol-relative URL, and
    // the authority carries the probe's Host.
    const host = probe.headers?.host ?? "127.0.0.1";
    const request = new Request(`http://${host}${probe.path}`, initOf(probe));
    return await withTimeout(adapter.fetch(request).then(record));
  } catch (error) {
    return { error: String(error) };
  }
}

interface SideResult {
  bootError?: string;
  logs: CaptureLogger["entries"];
  adapterInfo?: Record<string, unknown>;
  results: Record<string, Outcome>;
  served?: Record<string, Outcome>;
}

async function runSide(group: Group, side: Side): Promise<SideResult> {
  const logger = new CaptureLogger();
  const adapter =
    side === "express" ? new ExpressAdapter() : new BunHttpAdapter(0, group.bunOptions as never);
  const result: SideResult = { logs: logger.entries, results: {} };
  if (side === "bun") {
    const a = adapter as unknown as Record<string, unknown>;
    result.adapterInfo = {
      isRouteOrderSensitive: typeof a.isRouteOrderSensitive,
      normalizePathOwn: Object.prototype.hasOwnProperty.call(BunHttpAdapter.prototype, "normalizePath"),
      queryOnRouter: typeof (adapter.getInstance() as Record<string, unknown>).query,
    };
  }
  let app;
  try {
    app = await NestFactory.create(group.module, adapter as never, {
      logger,
      abortOnError: false,
      ...(group.options ?? {}),
    });
    group.configure?.(app);
    await app.listen(0, "127.0.0.1");
  } catch (error) {
    result.bootError = `${(error as Error)?.constructor?.name}: ${(error as Error)?.message ?? error}`;
    await app?.close().catch(() => {});
    return result;
  }
  try {
    const port =
      side === "express"
        ? (app.getHttpServer() as { address: () => { port: number } }).address().port
        : Number((adapter as BunHttpAdapter).listeningPort);
    const base = `http://127.0.0.1:${port}`;
    if (side === "bun") result.served = {};
    for (const probe of group.probes) {
      const key = probe.name;
      if (side === "express") {
        result.results[key] = await viaSocket(base, probe);
      } else {
        result.results[key] = await viaAdapterFetch(adapter as BunHttpAdapter, probe);
        result.served![key] = await viaSocket(base, probe);
      }
    }
  } finally {
    await app.close();
  }
  return result;
}

async function main() {
  const [out, filter] = process.argv.slice(2);
  if (!out) throw new Error("usage: bun run.ts <out.json> [group filter]");
  const groups = GROUPS.filter((g) => (!g.only12 || isNest12) && (!filter || g.name.includes(filter)));
  const report = {
    generatedAt: new Date().toISOString(),
    bun: { version: Bun.version, revision: Bun.revision },
    nest: nestVersions,
    groups: [] as unknown[],
  };
  for (const group of groups) {
    const express = await runSide(group, "express");
    const bun = await runSide(group, "bun");
    report.groups.push({
      name: group.name,
      only12: !!group.only12,
      options: group.options ?? null,
      bunOptions: group.bunOptions ?? null,
      probes: group.probes,
      express,
      bun,
    });
    console.log(
      `${group.name}: express ${express.bootError ? "BOOT ERROR" : "ok"}, bun ${bun.bootError ? "BOOT ERROR" : "ok"}`,
    );
  }
  await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${out} (${groups.length} groups, Nest ${nestVersions.core})`);
}

await main();
process.exit(0);
