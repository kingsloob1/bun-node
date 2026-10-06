import type { Route } from "@routejs/router";
import { describe, expect, it } from "bun:test";
import { BunRouter } from "../lib/BunRouter";
import { RouteTree } from "../lib/utils/routeTree";

/**
 * The route tree answers "which routes' regexes match this path, with which
 * captures" without running most regexes. It must answer exactly as running
 * every route's `pathRegexp.exec` would: this checks it against that, over a
 * route table of every shape `@routejs/router` compiles and a wide set of
 * paths.
 */

const handler = () => {};

/** A router holding one route of every shape, mounted ones included. */
function buildTable(): Route[] {
  const router = new BunRouter();
  router.use(handler);
  router.use("/mw", handler);
  router.use("/mw/deep", handler);
  router.use("/users/:uid", handler);
  router.get("/", handler);
  router.get("/static", handler);
  router.get("/static/inner", handler);
  router.get("/Case/Path", handler);
  router.get("/t/", handler);
  router.get("/user/:id", handler);
  router.get("/user/:id/posts/:post", handler);
  router.get("/user/me", handler);
  router.get("/assets/*", handler);
  router.get("/files/*splat", handler);
  router.get("/a/:b?", handler);
  router.get("/x/:y(\\d+)", handler);
  router.get("/u-:id", handler);
  router.get("/:lang/home", handler);
  router.get("/:a/:b/:c", handler);
  router.get("/dot.json", handler);
  router.get("/café/:id", handler);
  router.get("/tilde~/:id", handler);
  router.get("/r%20/:id", handler);
  for (let i = 0; i < 50; i++) {
    router.get(`/r${i}/:id`, handler);
  }
  const sub = new BunRouter();
  sub.get("/posts/:pid", handler);
  sub.use("/admin", handler);
  router.use("/org/:org", sub);
  const strict = new BunRouter({ caseSensitive: true });
  strict.get("/CS/:z", handler);
  strict.use("/Strict", handler);
  router.use(strict);
  return (router as unknown as { routes: () => Route[] }).routes();
}

const PIECES = [
  "",
  "static",
  "STATIC",
  "Static",
  "inner",
  "case",
  "Case",
  "path",
  "PATH",
  "t",
  "user",
  "USER",
  "me",
  "42",
  "posts",
  "7",
  "assets",
  "css",
  "app.css",
  "files",
  "a",
  "b",
  "x",
  "12",
  "1a",
  "u-9",
  "u-",
  "en",
  "home",
  "dot.json",
  "dotxjson",
  "café",
  "CAFÉ",
  "cafe",
  "tilde~",
  "r%20",
  "r 0",
  "r7",
  "R7",
  "r49",
  "r50",
  "%41",
  "%zz",
  "mw",
  "MW",
  "deep",
  "users",
  "org",
  "acme",
  "admin",
  "CS",
  "cs",
  "Strict",
  "strict",
  "ſtatic",
  "line\nbreak",
  "tab\tx",
];

/** Paths from the pieces: every 1- and 2-segment path, sampled longer ones, odd shapes. */
function buildPaths(): string[] {
  const paths = new Set<string>(["", "/", "//", "///", "*", "static", "/ /"]);
  for (const a of PIECES) {
    paths.add(`/${a}`);
    paths.add(`/${a}/`);
    paths.add(`/${a}//`);
    for (const b of PIECES) {
      paths.add(`/${a}/${b}`);
      paths.add(`/${a}/${b}/`);
    }
  }
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 4000; i++) {
    const count = 3 + Math.floor(random() * 3);
    let path = "";
    for (let k = 0; k < count; k++) {
      path += `/${PIECES[Math.floor(random() * PIECES.length)]}`;
    }
    if (random() < 0.2) {
      path += "/";
    }
    paths.add(path);
  }
  return [...paths];
}

/** What running every route's regex finds: `[index, captures]` in order. */
function bruteForce(routes: Route[], path: string) {
  const found: [number, (string | undefined)[]][] = [];
  routes.forEach((route, index) => {
    const result = (route.pathRegexp as RegExp | null)?.exec(path);
    if (result) {
      found.push([index, [...result]]);
    }
  });
  return found;
}

describe("RouteTree: exactly what each route's regex matches", () => {
  const routes = buildTable();
  const paths = buildPaths();

  it(`agrees with exec on ${paths.length} paths over ${routes.length} routes`, () => {
    const tree = new RouteTree();
    const mismatches: string[] = [];
    for (const path of paths) {
      const found = tree.match(routes, path);
      const actual = found.indices.map(
        (index, k) => [index, [...found.captures[k]]] as const,
      );
      const expected = bruteForce(routes, path);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `${JSON.stringify(path)}: tree ${JSON.stringify(actual)} regex ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("is rebuilt when routes are added, and after invalidate()", () => {
    const router = new BunRouter();
    router.get("/one", handler);
    const table = (router as unknown as { routes: () => Route[] }).routes();
    const tree = new RouteTree();
    expect(tree.match(table, "/two").indices).toEqual([]);
    router.get("/two", handler);
    expect(tree.match(table, "/two").indices).toEqual([1]);
    // A route changed in place is picked up after invalidate().
    table[1].pathRegexp = /^\/three\/?$/i;
    tree.invalidate();
    expect(tree.match(table, "/three").indices).toEqual([1]);
  });
});

describe("routing through the tree", () => {
  it("runs matching layers in registration order, with params and wildcards", async () => {
    const router = new BunRouter();
    const seen: string[] = [];
    router.use((_req, _res, next) => {
      seen.push("global");
      next();
    });
    router.get("/:lang/home", (req, _res, next) => {
      seen.push(`lang:${(req.params as Record<string, string>).lang}`);
      next();
    });
    router.get("/en/home", (_req, res) => {
      seen.push("static");
      res.send("ok");
    });
    router.get("/files/*splat", (req, res) => {
      res.json(req.params);
    });
    expect(await (await router.fetch("/EN/home/")).text()).toBe("ok");
    expect(seen).toEqual(["global", "lang:EN", "static"]);
    expect(await (await router.fetch("/files/a/b%20c/")).json()).toEqual({
      "0": "a/b c/",
      splat: "a/b c/",
    });
  });
});
