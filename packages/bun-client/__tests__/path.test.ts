/**
 * The URL builder against the server's matcher (plan §6.1): each path form
 * bun-common compiles (path-to-regexp 8, and routejs's bridged `:x?` and
 * `:x(re)`) is built with params, sent to a real `BunRouter.fetch()` route
 * registered with the same literal, and the params the router matched must
 * be the ones given.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { describe, expect, it } from "bun:test";
import { ClientError } from "../lib/index";
import { buildPath } from "../lib/path";

/** Each form: the route literal, the params, the path written, and what the router must match. */
const FORMS: [
  literal: string,
  params: Record<string, unknown>,
  written: string,
  matched: Record<string, unknown>,
][] = [
  ["/users/:id", { id: "42" }, "/users/42", { id: "42" }],
  [
    "/users/:id",
    { id: "a b/c?#%" },
    "/users/a%20b%2Fc%3F%23%25",
    { id: "a b/c?#%" },
  ],
  [
    "/users/:id/posts/:postId",
    { id: 1, postId: "x" },
    "/users/1/posts/x",
    { id: "1", postId: "x" },
  ],
  [
    "/files/*path",
    { path: ["a", "b c", "d"] },
    "/files/a/b%20c/d",
    { path: ["a", "b c", "d"] },
  ],
  ["/files{/:name}", { name: "readme" }, "/files/readme", { name: "readme" }],
  ["/files{/:name}", {}, "/files", {}],
  ["/a{/:b{/:c}}", { b: "1", c: "2" }, "/a/1/2", { b: "1", c: "2" }],
  ["/a{/:b{/:c}}", { b: "1" }, "/a/1", { b: "1" }],
  ["/:a-:b", { a: "x", b: "y" }, "/x-y", { a: "x", b: "y" }],
  ['/q/:"weird name"', { "weird name": "v" }, "/q/v", { "weird name": "v" }],
  ["/lit\\:eral/:id", { id: "1" }, "/lit:eral/1", { id: "1" }],
  ["/opt/:x?", { x: "v" }, "/opt/v", { x: "v" }],
  ["/opt/:x?", {}, "/opt", {}],
  ["/num/:id(\\d+)", { id: 7 }, "/num/7", { id: "7" }],
];

describe("buildPath writes what the server's matcher reads back", () => {
  for (const [literal, params, written, matched] of FORMS) {
    it(`${literal} with ${JSON.stringify(params)}`, async () => {
      expect(buildPath(literal, params)).toBe(written);
      const router = new BunRouter();
      router.get(literal, (req, res) => res.json({ ...req.params }));
      const response = await router.fetch(written);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(matched);
    });
  }
});

describe("missing params", () => {
  it("throws a ClientError naming every missing required param", () => {
    expect(() => buildPath("/a/:x/:y", { x: "1" }, "GET /a/:x/:y")).toThrow(
      new ClientError('Missing path param "y" for /a/:x/:y'),
    );
    expect(() => buildPath("/a/:x/:y")).toThrow('Missing path params "x", "y"');
    expect(() => buildPath("/f/*rest", { rest: [] })).toThrow('"rest"');
  });

  it("treats null and undefined as missing, and takes only own keys", () => {
    expect(() => buildPath("/a/:x", { x: null })).toThrow('"x"');
    expect(() => buildPath("/a/:toString", {})).toThrow('"toString"');
  });

  it("negative control: a group with a missing param is left out, not written half", () => {
    expect(buildPath("/a{/:b/:c}", { b: "1" })).toBe("/a");
  });
});
