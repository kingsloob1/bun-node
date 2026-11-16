/**
 * Layer L6's canonical path (layers.md L6, README §11.3): T-L6-1's forms
 * read as the path they disguise; the canonicaliser is idempotent and agrees
 * with Bun's own URL normalisation on random paths, and with what `Bun.serve`
 * hands a handler over a raw socket; and the path and query checks.
 */
import { connect } from "node:net";
import { afterAll, describe, expect, it } from "bun:test";
import { canonicalPath, pathProblem, queryShape } from "../../lib/engine/path";
import { seededRandom } from "../helpers";

describe("canonicalPath", () => {
  it("T-L6-1: reads //admin, encoded dots, backslashes and encoded letters as /admin", () => {
    for (const raw of [
      "/admin",
      "//admin",
      "///admin//",
      "/a/%2e%2e/admin",
      "/a/%2E./admin",
      "/a/./../admin",
      "/a\\..\\admin",
      "\\admin",
      "/%61dmin",
      "/%61%64%6D%69%6E",
    ]) {
      expect({ raw, path: canonicalPath(raw).replace(/\/$/, "") }).toEqual({
        raw,
        path: "/admin",
      });
    }
  });

  it("keeps case, an encoded slash (L6 refuses it), and upper-cases other escapes", () => {
    expect(canonicalPath("/Admin/X")).toBe("/Admin/X");
    expect(canonicalPath("/a%2fb")).toBe("/a%2Fb");
    expect(canonicalPath("/a%20b%7e")).toBe("/a%20b~");
    // A % that starts no escape is written %25, so decoding forms no new one.
    expect(canonicalPath("/%zz/%")).toBe("/%25zz/%25");
    expect(canonicalPath("/%%61a")).toBe("/%25aa");
  });

  it("resolves dot segments as the WHATWG parser does", () => {
    expect(canonicalPath("/a/b/..")).toBe("/a/");
    expect(canonicalPath("/a/b/.")).toBe("/a/b/");
    expect(canonicalPath("/..")).toBe("/");
    expect(canonicalPath("/../../x")).toBe("/x");
    expect(canonicalPath("/.hidden/..x")).toBe("/.hidden/..x");
  });

  /** A random raw path from an alphabet rich in the forms that matter. */
  function randomPath(random: () => number): string {
    const pieces = [
      "a",
      "B",
      "/",
      "/",
      "//",
      ".",
      "..",
      "%2e",
      "%2E",
      "%2f",
      "%5c",
      "\\",
      "%61",
      "%7E",
      "%20",
      "%25",
      "~",
      "-",
      "_",
      "x.y",
      "%zz",
      "%",
    ];
    let path = "/";
    const length = Math.floor(random() * 12);
    for (let i = 0; i < length; i++) {
      path += pieces[Math.floor(random() * pieces.length)] ?? "";
    }
    return path;
  }

  it("is idempotent (5,000 random paths)", () => {
    const random = seededRandom(31);
    for (let i = 0; i < 5_000; i++) {
      const raw = randomPath(random);
      const once = canonicalPath(raw);
      expect({ raw, twice: canonicalPath(once) }).toEqual({ raw, twice: once });
    }
  });

  it("agrees with Bun's URL normalisation (5,000 random paths)", () => {
    const random = seededRandom(32);
    for (let i = 0; i < 5_000; i++) {
      const raw = randomPath(random);
      // As a server builds the URL: origin, then the request target as sent
      // (resolved against a base, `//x` would read as a host). The
      // alphabet holds no `?` or `#`.
      const bun = new URL(`http://x.test${raw}`).pathname;
      expect({ raw, ours: canonicalPath(raw) }).toEqual({
        raw,
        ours: canonicalPath(bun),
      });
    }
  });
});

describe("agreement with Bun.serve over a raw socket", () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push(new URL(request.url).pathname);
      return new Response("ok");
    },
  });
  afterAll(() => server.stop(true));

  /** The pathname Bun hands the handler for `target` sent as written. */
  function served(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const before = seen.length;
      const socket = connect(server.port ?? 0, "127.0.0.1", () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
        );
      });
      socket.on("data", () => {});
      socket.on("error", reject);
      socket.on("close", () => resolve(seen[before] ?? "(not served)"));
    });
  }

  it("each T-L6-1 form's canonical path equals that of the pathname Bun serves", async () => {
    for (const target of [
      "//admin//x",
      "/a/%2e%2e/admin",
      "/a\\..\\admin",
      "/admin%2Fsecret",
      "/%61dmin/./x/../y",
    ]) {
      const pathname = await served(target);
      expect({ target, ours: canonicalPath(target) }).toEqual({
        target,
        ours: canonicalPath(pathname),
      });
    }
  });
});

describe("pathProblem", () => {
  it("finds encoded slashes and backslashes, NUL and escapes that are not UTF-8", () => {
    expect(pathProblem("/a%2Fb", false)).toBe("encoded slash");
    expect(pathProblem("/a%2fb", false)).toBe("encoded slash");
    expect(pathProblem("/a%5Cb", false)).toBe("encoded backslash");
    expect(pathProblem("/a%00", false)).toBe("NUL");
    expect(pathProblem("/a\0", false)).toBe("NUL");
    // Overlong forms of "." and "/", and a lone continuation byte.
    for (const raw of ["/%C0%AE%C0%AE/", "/%E0%80%AF", "/%80", "/%FF"]) {
      expect({ raw, problem: pathProblem(raw, false) }).toEqual({
        raw,
        problem: "invalid UTF-8",
      });
    }
  });

  it("accepts real UTF-8, a bare %, and an opted-out encoded slash", () => {
    expect(pathProblem("/caf%C3%A9", false)).toBeUndefined();
    expect(pathProblem("/100%", false)).toBeUndefined();
    expect(pathProblem("/plain", false)).toBeUndefined();
    expect(pathProblem("/a%2Fb", true)).toBeUndefined();
  });
});

describe("queryShape", () => {
  it("counts bytes, parameters and the deepest nesting", () => {
    expect(queryShape("a=1&b=2&&c")).toEqual({
      bytes: 10,
      params: 3,
      depth: 0,
    });
    expect(queryShape("a[b][c]=1&x.y=2")).toEqual({
      bytes: 15,
      params: 2,
      depth: 2,
    });
    expect(queryShape("a%5Bb%5D%5Bc%5D%5Bd%5D=1").depth).toBe(3);
    expect(queryShape("é=1").bytes).toBe(4);
  });
});
