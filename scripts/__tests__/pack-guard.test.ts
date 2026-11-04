import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  checkPackedManifest,
  guardTarball,
  readPackedManifest,
  readTarEntry,
  unresolvedProtocols,
} from "../pack-guard";

const scratch = mkdtempSync(join(tmpdir(), "pack-guard-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Runs a command, throwing with its output when it fails; its stdout. */
function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0)
    throw new Error(
      `${cmd.join(" ")}: ${r.stdout.toString()}${r.stderr.toString()}`,
    );
  return r.stdout.toString();
}

/** A two-package Bun workspace: `@fx/b` names `@fx/a` `workspace:^` and takes `left-pad` from the catalog. */
function workspace(): string {
  const root = mkdtempSync(join(scratch, "ws-"));
  const write = (rel: string, value: unknown) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(
      join(root, rel),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  write("package.json", {
    name: "ws",
    private: true,
    workspaces: { packages: ["packages/*"], catalog: { "left-pad": "^1.3.0" } },
  });
  write("packages/a/package.json", {
    name: "@fx/a",
    version: "1.0.0-rc.0",
    files: ["index.js"],
  });
  write("packages/a/index.js", "export {};\n");
  write("packages/b/package.json", {
    name: "@fx/b",
    version: "1.0.0-rc.0",
    files: ["index.js"],
    dependencies: { "@fx/a": "workspace:^" },
    peerDependencies: { "@fx/a": "workspace:^" },
    devDependencies: { "left-pad": "catalog:" },
  });
  write("packages/b/index.js", "export {};\n");
  return root;
}

describe("the guard on real tarballs", () => {
  const root = workspace();
  const out = join(root, "out");
  mkdirSync(join(out, "bun"), { recursive: true });
  mkdirSync(join(out, "npm"), { recursive: true });
  const dir = join(root, "packages", "b");
  run(
    [
      process.execPath,
      "pm",
      "pack",
      "--destination",
      join(out, "bun"),
      "--quiet",
    ],
    dir,
  );
  run(["npm", "pack", "--pack-destination", join(out, "npm")], dir);
  const bunTarball = join(out, "bun", "fx-b-1.0.0-rc.0.tgz");
  const npmTarball = join(out, "npm", "fx-b-1.0.0-rc.0.tgz");
  const expected = {
    name: "@fx/b",
    version: "1.0.0-rc.0",
    internal: ["@fx/a", "@fx/b"],
  };

  it("passes a tarball bun pm pack made: workspace:^ and catalog: rewritten", () => {
    expect(readPackedManifest(bunTarball)).toMatchObject({
      dependencies: { "@fx/a": "^1.0.0-rc.0" },
      peerDependencies: { "@fx/a": "^1.0.0-rc.0" },
      devDependencies: { "left-pad": "^1.3.0" },
    });
    expect(guardTarball(bunTarball, expected)).toEqual([]);
  });

  it("fails a tarball npm pack made from the package directory (the negative control)", () => {
    expect(guardTarball(npmTarball, expected)).toEqual([
      "unresolved workspace protocol: dependencies.@fx/a: workspace:^",
      "unresolved workspace protocol: peerDependencies.@fx/a: workspace:^",
      "unresolved workspace protocol: devDependencies.left-pad: catalog:",
      "dependencies.@fx/a is workspace:^, not ^1.0.0-rc.0",
      "peerDependencies.@fx/a is workspace:^, not ^1.0.0-rc.0",
    ]);
  });
});

describe("checkPackedManifest", () => {
  const good = {
    name: "@fx/b",
    version: "2.0.0",
    dependencies: { "@fx/a": "^2.0.0", zod: "^4" },
    devDependencies: { "@fx/c": "^2.0.0" },
  };
  const expected = {
    name: "@fx/b",
    version: "2.0.0",
    internal: ["@fx/a", "@fx/c"],
  };

  it("passes a manifest with every internal range at ^<version>", () => {
    expect(checkPackedManifest(good, expected)).toEqual([]);
  });

  it("fails a stale internal range, a wrong version and a wrong name", () => {
    expect(
      checkPackedManifest(
        {
          ...good,
          name: "@fx/x",
          version: "2.0.1",
          devDependencies: { "@fx/c": "^1.9.0" },
        },
        expected,
      ),
    ).toEqual([
      "name is @fx/x, not @fx/b",
      "version is 2.0.1, not 2.0.0",
      "devDependencies.@fx/c is ^1.9.0, not ^2.0.0",
    ]);
  });

  it("finds workspace: and catalog: anywhere, keys and named catalogs included", () => {
    expect(
      unresolvedProtocols({
        optionalDependencies: { x: "catalog:testing" },
        overrides: { "workspace:y": "1" },
        nested: [{ deep: "a workspace:* inside" }],
        fine: "workspaces are fine",
      }),
    ).toEqual([
      "optionalDependencies.x: catalog:testing",
      "overrides.workspace:y (key)",
      "nested[0].deep: a workspace:* inside",
    ]);
  });
});

describe("readTarEntry", () => {
  it("reads a long path in the pax and GNU forms tar writes", () => {
    const long = `package/${"d".repeat(60)}/${"e".repeat(60)}/file.json`;
    for (const format of ["pax", "gnu", "ustar"]) {
      const stage = mkdtempSync(join(scratch, `tar-${format}-`));
      mkdirSync(join(stage, long, ".."), { recursive: true });
      writeFileSync(join(stage, long), `{"format":"${format}"}`);
      writeFileSync(join(stage, "package", "package.json"), "{}");
      const tgz = join(stage, "x.tgz");
      run(["tar", `--format=${format}`, "-czf", tgz, "package"], stage);
      const bytes = readFileSync(tgz);
      expect(new TextDecoder().decode(readTarEntry(bytes, long))).toBe(
        `{"format":"${format}"}`,
      );
      expect(
        new TextDecoder().decode(readTarEntry(bytes, "package/package.json")),
      ).toBe("{}");
      expect(readTarEntry(bytes, "package/missing.json")).toBeUndefined();
    }
  });
});
