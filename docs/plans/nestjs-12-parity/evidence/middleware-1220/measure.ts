/**
 * Counts how often a Nest middleware runs per request, in whole Nest apps on
 * `@nestjs/platform-express` and bun-nest's `BunHttpAdapter`, on whichever
 * Nest the given repo copy installs.
 *
 *   cd <root>/packages/bun-nest && bun <this file> <root>
 *
 * `<root>` is a bun-node checkout (develop's lock) or a `nest-matrix.ts`
 * copy pinned to another Nest. Decorators are applied by hand, so the file
 * needs no tsconfig. Prints one table per case.
 */
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: bun measure.ts <repo root>");
  process.exit(2);
}
const from = join(root, "packages/bun-nest");
const load = async (spec: string) => import(Bun.resolveSync(spec, from));

const core = await load("@nestjs/core");
const common = await load("@nestjs/common");
const { ExpressAdapter } = await load("@nestjs/platform-express");
const express = (await load("express")).default;
const { BunHttpAdapter } = await import(join(from, "lib/index.ts"));
const version = (await load("@nestjs/core/package.json")).default.version;
const { Controller, Get, Module, RequestMethod } = common;

/** Applies a method decorator by hand. */
function method(cls: Function, key: string, decorator: Function): void {
  const proto = cls.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, key)!;
  const out = decorator(proto, key, desc) ?? desc;
  Object.defineProperty(proto, key, out);
}

let runs = 0;
const counter = (_req: unknown, _res: unknown, next: () => void) => {
  runs++;
  next();
};

class Hello {
  get() {
    return "hello";
  }
}
Controller("hello")(Hello);
method(Hello, "get", Get());

class Users {
  login() {
    return "login";
  }
}
Controller("users")(Users);
method(Users, "login", Get("login"));

class Invoices {
  list() {
    return "list";
  }

  one() {
    return "one";
  }
}
Controller("invoices")(Invoices);
method(Invoices, "list", Get());
method(Invoices, "one", Get(":id"));

interface Case {
  name: string;
  /** What `configure(consumer)` registers; none for "exact-alone". */
  configure?: (consumer: any) => void;
  /** Registered on the adapter by hand, before `listen()`. */
  raw?: (adapter: any) => void;
  caseSensitive?: boolean;
  /** `setGlobalPrefix("api", prefixOptions)`. */
  prefixOptions?: { exclude: string[] };
  paths: string[];
}

const cases: Case[] = [
  {
    name: "forRoutes('*') under setGlobalPrefix('api')",
    configure: (c) => c.apply(counter).forRoutes("*"),
    paths: ["/api", "/api/", "/api/hello", "/api/hello/", "/api/nope"],
  },
  {
    name: "the core's exact entry '/api$' alone (createMiddlewareFactory(ALL))",
    raw: (adapter) =>
      adapter.createMiddlewareFactory(RequestMethod.ALL)("/api$", counter),
    paths: ["/api", "/api/", "/api/hello"],
  },
  {
    name: "exclude('users/login', 'invoices/{*path}').forRoutes('*')",
    configure: (c) =>
      c.apply(counter).exclude("users/login", "invoices/{*path}").forRoutes("*"),
    paths: [
      "/api/users/login",
      "/api/users/LOGIN",
      "/api/users/login/",
      "/api/invoices",
      "/api/invoices/",
      "/api/invoices/7",
    ],
  },
  {
    name: "the same exclude, router case-sensitive",
    configure: (c) =>
      c.apply(counter).exclude("users/login", "invoices/{*path}").forRoutes("*"),
    caseSensitive: true,
    paths: ["/api/users/login", "/api/users/LOGIN", "/api/users/login/"],
  },
  {
    name: "forRoutes('*') under setGlobalPrefix('api', { exclude: ['/'] }) (overlapping paths)",
    configure: (c) => c.apply(counter).forRoutes("*"),
    prefixOptions: { exclude: ["/"] },
    paths: ["/", "/api", "/api/hello"],
  },
];

function adapterFor(kind: "express" | "bun", caseSensitive: boolean) {
  if (kind === "bun") {
    return new BunHttpAdapter(0, { router: { caseSensitive } });
  }
  const app = express();
  if (caseSensitive) app.set("case sensitive routing", true);
  return new ExpressAdapter(app);
}

async function measure(c: Case, kind: "express" | "bun") {
  class AppModule {
    configure(consumer: any) {
      c.configure?.(consumer);
    }
  }
  Module({ controllers: [Hello, Users, Invoices] })(AppModule);
  const app = await core.NestFactory.create(
    AppModule,
    adapterFor(kind, c.caseSensitive ?? false),
    { logger: false },
  );
  app.setGlobalPrefix("api", c.prefixOptions);
  c.raw?.(app.getHttpAdapter());
  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();
  const out: Record<string, string> = {};
  for (const path of c.paths) {
    runs = 0;
    const res = await fetch(url.replace("[::1]", "127.0.0.1") + path);
    await res.arrayBuffer();
    out[path] = `${runs} (${res.status})`;
  }
  await app.close();
  return out;
}

console.log(`@nestjs/core ${version}, Bun ${Bun.version} (${Bun.revision.slice(0, 9)})`);
console.log("cell: middleware runs (status)\n");
for (const c of cases) {
  const ex = await measure(c, "express");
  const bn = await measure(c, "bun");
  console.log(`## ${c.name}`);
  console.log("| path | platform-express | BunHttpAdapter |");
  console.log("|---|---|---|");
  for (const p of c.paths) {
    console.log(`| \`${p}\` | ${ex[p]} | ${bn[p]} |`);
  }
  console.log();
}
process.exit(0);
