import type {
  CommandResult,
  Manifest,
  Member,
  PublishIo,
  PublishOptions,
  PublishResult,
} from "../publish";
import {
  mkdirSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  defaultTag,
  discoverMembers,
  parseArgs,
  PublishRefusal,
  publishOrder,
  remoteTagCommit,
  runPublish,
  tagProblems,
} from "../publish";

const scratch = mkdtempSync(join(tmpdir(), "publish-test-"));
// runPublish makes its work directory under tmpdir() when none is given:
// point that at this file's scratch, so every run here is removed with it.
const tmpdirBefore = process.env.TMPDIR;
process.env.TMPDIR = scratch;
afterAll(() => {
  if (tmpdirBefore === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = tmpdirBefore;
  rmSync(scratch, { recursive: true, force: true });
});

const VERSION = "3.0.0-rc.0";
const OTP = "135790";
const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

/** A publishable member's manifest: everything the script requires, plus `extra`. */
function member(name: string, extra: Partial<Manifest> = {}): Manifest {
  return {
    name: `@fx/${name}`,
    version: VERSION,
    files: ["dts", "lib"],
    scripts: { prepack: "bun scripts/build-declarations.ts" },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    devDependencies: { typescript: "catalog:" },
    ...extra,
  };
}

/** The repo's graph in miniature: the eight packages and how they name each other. */
const EIGHT: Record<string, Manifest> = {
  "bun-contract": member("bun-contract", { dependencies: null }),
  "bun-common": member("bun-common", {
    dependencies: { "@fx/bun-contract": "workspace:^", busboy: "^1.6.0" },
    peerDependencies: { "@fx/bun-api-docs-ui": "workspace:^" },
    peerDependenciesMeta: { "@fx/bun-api-docs-ui": { optional: true } },
  }),
  "bun-api-docs-ui": member("bun-api-docs-ui", {
    dependencies: { "@fx/bun-common": "workspace:^" },
  }),
  "bun-cache": member("bun-cache", {
    dependencies: { "@fx/bun-common": "workspace:^" },
  }),
  "bun-jobs": member("bun-jobs", {
    dependencies: { "@fx/bun-common": "workspace:^" },
  }),
  "bun-client": member("bun-client", {
    dependencies: { "@fx/bun-contract": "workspace:^" },
    peerDependencies: { "@fx/bun-common": "workspace:^" },
    peerDependenciesMeta: { "@fx/bun-common": { optional: true } },
    devDependencies: { "@fx/bun-cache": "workspace:^" },
  }),
  "bun-nest": member("bun-nest", {
    dependencies: { "@fx/bun-common": "workspace:^" },
    peerDependencies: { "@fx/bun-jobs": "workspace:^" },
    peerDependenciesMeta: { "@fx/bun-jobs": { optional: true } },
  }),
  "bun-jobs-ui": member("bun-jobs-ui", {
    dependencies: { "@fx/bun-common": "workspace:^" },
    peerDependencies: { "@fx/bun-jobs": "workspace:^" },
    devDependencies: { "@fx/bun-nest": "workspace:^" },
  }),
};

const EIGHT_ORDER = [
  "@fx/bun-contract",
  "@fx/bun-client",
  "@fx/bun-common",
  "@fx/bun-api-docs-ui",
  "@fx/bun-cache",
  "@fx/bun-jobs",
  "@fx/bun-jobs-ui",
  "@fx/bun-nest",
];

let fixtures = 0;

/** Writes a workspace: root manifest, lerna.json, CHANGELOG.md, and each member with its LICENSE and consumer-check.json. */
function workspace(
  members: Record<string, Manifest>,
  options: {
    /** Files to leave out of a member (`"bun-auth/LICENSE"`). */
    omit?: string[];
    /** The CHANGELOG.md text; default one with an entry for VERSION. */
    changelog?: string;
    /** The root's workspace globs; default `["packages/*"]`. */
    patterns?: string[];
  } = {},
): string {
  const root = join(scratch, `ws-${++fixtures}`);
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write(
    "package.json",
    JSON.stringify({
      name: "root",
      private: true,
      workspaces: {
        packages: options.patterns ?? ["packages/*"],
        catalog: { typescript: "^6.0.3" },
      },
    }),
  );
  write("lerna.json", JSON.stringify({ version: VERSION }));
  write(
    "CHANGELOG.md",
    options.changelog ??
      `# Changelog\n\n## ${VERSION} (2026-11-04)\n\nThe release candidate.\n`,
  );
  for (const [dir, manifest] of Object.entries(members)) {
    write(`packages/${dir}/package.json`, JSON.stringify(manifest));
    for (const [file, text] of [
      ["LICENSE", "MIT"],
      [
        "consumer-check.json",
        JSON.stringify({ entries: [{ spelling: manifest.name }] }),
      ],
    ] as const)
      if (!options.omit?.includes(`${dir}/${file}`))
        write(`packages/${dir}/${file}`, text);
  }
  return root;
}

/**
 * A packer that does what `bun pm pack` does to the manifest
 * (`workspace:^` → `^<version>`, `catalog:` → the catalog's range), or,
 * with `npmLike`, what `npm pack` does: nothing.
 */
function fakePack(calls: string[], npmLike = false) {
  return (dir: string, dest: string): string => {
    calls.push(dir);
    const manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    if (!npmLike)
      for (const field of [
        "dependencies",
        "peerDependencies",
        "devDependencies",
      ]) {
        const deps = manifest[field] as
          Record<string, string> | null | undefined;
        for (const name of Object.keys(deps ?? {}))
          if (deps![name] === "workspace:^") deps![name] = `^${VERSION}`;
          else if (deps![name] === "catalog:") deps![name] = "^6.0.3";
      }
    const name = String(manifest.name).replace("@", "").replace("/", "-");
    const stage = mkdtempSync(join(scratch, "stage-"));
    mkdirSync(join(stage, "package"));
    writeFileSync(
      join(stage, "package", "package.json"),
      JSON.stringify(manifest),
    );
    const tarball = join(dest, `${name}-${VERSION}.tgz`);
    const r = Bun.spawnSync({
      cmd: ["tar", "-czf", tarball, "-C", stage, "package"],
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return tarball;
  };
}

/** Every call the fakes saw, and what they answer. */
interface World {
  /** Packed member directories. */
  packed: string[];
  /** `npm publish` calls. */
  published: {
    tarball: string;
    tag: string;
    otp: string | undefined;
    dryRun: boolean;
  }[];
  /** git calls, args joined. */
  git: string[];
  /** gh calls, args joined. */
  gh: string[];
  /** Prompts asked. */
  prompts: number;
  /** Log lines. */
  log: string[];
  /** Waits. */
  sleeps: number[];
}

/** Fakes for every outside effect: a registry, a packer, a prompt, git and gh. */
function fakes(
  options: {
    /** `name@version`s the registry already has. */
    onRegistry?: string[];
    /** `npm whoami`'s answer. */
    user?: string;
    /** Publish answers per package name, consumed in turn; default ok. */
    publish?: Record<string, PublishResult[]>;
    /** The codes the prompt answers, in turn. */
    codes?: string[];
    /** Overrides of git answers, by args joined with spaces (a list is consumed in turn). */
    git?: Record<string, CommandResult | CommandResult[]>;
    /** Overrides of gh answers, likewise. */
    gh?: Record<string, CommandResult | CommandResult[]>;
    /** Pack as npm does (no rewriting). */
    npmLike?: boolean;
  } = {},
): { io: PublishIo; world: World } {
  const world: World = {
    packed: [],
    published: [],
    git: [],
    gh: [],
    prompts: 0,
    log: [],
    sleeps: [],
  };
  const codes = [...(options.codes ?? [OTP])];
  const answer = (
    table: Record<string, CommandResult | CommandResult[]>,
    defaults: Record<string, CommandResult>,
    key: string,
  ): CommandResult => {
    const entry = table[key];
    if (Array.isArray(entry)) return entry.shift() ?? { code: 0, out: "" };
    if (entry) return entry;
    for (const [prefix, result] of Object.entries(defaults))
      if (key.startsWith(prefix)) return result;
    return { code: 0, out: "" };
  };
  const gitDefaults: Record<string, CommandResult> = {
    "status --porcelain": { code: 0, out: "" },
    "rev-parse HEAD": { code: 0, out: `${HEAD}\n` },
    "remote get-url origin": {
      code: 0,
      out: "git@github.com:owner/repo.git\n",
    },
    "rev-parse -q --verify": { code: 1, out: "" },
    "ls-remote": { code: 0, out: "" },
    "config gpg.format": { code: 0, out: "ssh\n" },
  };
  const ghDefaults: Record<string, CommandResult> = {
    "auth status": { code: 0, out: "Logged in" },
    "api user": { code: 0, out: "owner\n" },
    "api repos/owner/repo": { code: 0, out: "true\n" },
    "release view": { code: 1, out: "release not found" },
    "release create": {
      code: 0,
      out: "https://github.com/owner/repo/releases/tag/v3.0.0-rc.0\n",
    },
  };
  const publishQueue = Object.fromEntries(
    Object.entries(options.publish ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const io: PublishIo = {
    registry: {
      whoami: async () => options.user ?? "owner",
      isPublished: async (name, version) =>
        (options.onRegistry ?? []).includes(`${name}@${version}`),
      distTag: async () => VERSION,
      publish: async (tarball, { tag, otp, dryRun }) => {
        world.published.push({ tarball, tag, otp, dryRun });
        const name = `@fx/${/fx-(.+)-3\.0\.0/.exec(tarball)![1]}`;
        return (
          publishQueue[name]?.shift() ?? {
            ok: true,
            otpError: false,
            output: "+ ok",
          }
        );
      },
    },
    pack: fakePack(world.packed, options.npmLike),
    promptOtp: async () => {
      world.prompts++;
      return codes.shift() ?? "";
    },
    git: async (args) => {
      world.git.push(args.join(" "));
      return answer(options.git ?? {}, gitDefaults, args.join(" "));
    },
    gh: async (args) => {
      world.gh.push(args.join(" "));
      return answer(options.gh ?? {}, ghDefaults, args.join(" "));
    },
    sleep: async (ms) => {
      world.sleeps.push(ms);
    },
    log: (line) => world.log.push(line),
  };
  return { io, world };
}

/** runPublish's refusal reasons, or a failure when it did not refuse. */
async function refusal(
  options: PublishOptions,
  io: PublishIo,
): Promise<string[]> {
  try {
    await runPublish(options, io);
  } catch (error) {
    if (error instanceof PublishRefusal) return error.reasons;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("discovery and order", () => {
  it("finds the members from workspaces.packages globs, with ! exclusions, and orders them from the graph", () => {
    const root = workspace(
      { ...EIGHT, scratchpad: { name: "@fx/scratchpad", private: true } },
      { patterns: ["packages/*", "!packages/bun-cache"] },
    );
    const members = discoverMembers(root);
    expect(members.map((m) => m.dir)).not.toContain("packages/bun-cache");
    expect(members.map((m) => m.dir)).toContain("packages/scratchpad");
    const publishable = members.filter((m) => !m.manifest.private);
    expect(publishOrder(publishable).map((m) => m.manifest.name)).toEqual(
      EIGHT_ORDER.filter((n) => n !== "@fx/bun-cache"),
    );
  });

  it("orders the eight like the repo's graph, whatever order they are listed in", () => {
    const members: Member[] = Object.entries(EIGHT).map(([dir, manifest]) => ({
      dir,
      manifest,
    }));
    expect(publishOrder(members).map((m) => m.manifest.name)).toEqual(
      EIGHT_ORDER,
    );
    expect(
      publishOrder([...members].reverse()).map((m) => m.manifest.name),
    ).toEqual(EIGHT_ORDER);
  });

  it("refuses a cycle of dependencies or required peers, naming it; optional peers never order", () => {
    const a = {
      dir: "a",
      manifest: member("a", { dependencies: { "@fx/b": "workspace:^" } }),
    };
    const b = {
      dir: "b",
      manifest: member("b", { peerDependencies: { "@fx/a": "workspace:^" } }),
    };
    expect(() => publishOrder([a, b])).toThrow(
      "dependency cycle among @fx/a, @fx/b",
    );
    // The negative control: the same edge made optional is no cycle.
    b.manifest.peerDependenciesMeta = { "@fx/a": { optional: true } };
    expect(publishOrder([a, b]).map((m) => m.manifest.name)).toEqual([
      "@fx/b",
      "@fx/a",
    ]);
  });

  it("picks up a ninth package with no code change, in its place in the graph", async () => {
    const nine = {
      ...EIGHT,
      "bun-auth": member("bun-auth", {
        dependencies: { "@fx/bun-jobs": "workspace:^" },
      }),
    };
    const { io, world } = fakes();
    const report = await runPublish({ root: workspace(nine) }, io);
    expect(report.order).toEqual([
      "@fx/bun-contract",
      "@fx/bun-client",
      "@fx/bun-common",
      "@fx/bun-api-docs-ui",
      "@fx/bun-cache",
      "@fx/bun-jobs",
      "@fx/bun-auth",
      "@fx/bun-jobs-ui",
      "@fx/bun-nest",
    ]);
    expect(report.published).toEqual(report.order);
    expect(world.packed).toHaveLength(9);
    expect(world.log).toContain("  7. @fx/bun-auth  after @fx/bun-jobs");
  });

  it("refuses a new member that lacks what publishing needs, naming each", async () => {
    const nine = {
      ...EIGHT,
      "bun-auth": {
        name: "@fx/bun-auth",
        version: "3.0.0-rc.1",
        scripts: { prepack: "echo" },
        dependencies: {
          "@fx/bun-common": "^3.0.0-rc.0",
          "@fx/scratch": "workspace:^",
        },
      },
      scratch: { name: "@fx/scratch", private: true },
    };
    const root = workspace(nine, {
      omit: ["bun-auth/LICENSE", "bun-auth/consumer-check.json"],
    });
    const { io, world } = fakes();
    const reasons = await refusal({ root }, io);
    const at = "packages/bun-auth (@fx/bun-auth)";
    expect(reasons).toEqual([
      `${at}: version 3.0.0-rc.1, not lerna.json's 3.0.0-rc.0`,
      `${at}: a scoped package needs "publishConfig": { "access": "public" }`,
      `${at}: no "files" (what the tarball ships, e.g. ["dts", "lib"])`,
      expect.stringContaining(
        `${at}: "scripts.prepack" must build the declarations`,
      ) as string,
      `${at}: no LICENSE file (copy the root's)`,
      expect.stringContaining(`${at}: no consumer-check.json`) as string,
      `${at}: dependencies.@fx/bun-common is ^3.0.0-rc.0; a workspace package is named "workspace:^"`,
      `${at}: dependencies.@fx/scratch is a private package, which is never published`,
    ]);
    expect(world.packed).toEqual([]);
    // The negative control: the eight alone pass.
    expect((await runPublish({ root: workspace(EIGHT) }, fakes().io)).ok).toBe(
      true,
    );
  });
});

describe("preconditions", () => {
  it("refuses a dirty tree, and --allow-dirty or --skip-whoami without --dry-run", async () => {
    const root = workspace(EIGHT);
    const dirty = fakes({
      git: { "status --porcelain": { code: 0, out: " M package.json\n" } },
    });
    expect(await refusal({ root }, dirty.io)).toEqual([
      "the tree is not clean (git status --porcelain):\n     M package.json",
    ]);
    expect(
      await refusal({ root, allowDirty: true, skipWhoami: true }, dirty.io),
    ).toEqual([
      "--allow-dirty is only for --dry-run",
      "--skip-whoami is only for --dry-run",
      expect.stringContaining("the tree is not clean") as string,
    ]);
    const rehearsal = await runPublish(
      { root, dryRun: true, allowDirty: true, skipWhoami: true },
      fakes({
        git: { "status --porcelain": { code: 0, out: " M package.json\n" } },
      }).io,
    );
    expect(rehearsal.ok).toBe(true);
  });

  it("refuses when nobody is logged in to npm", async () => {
    const { io, world } = fakes({ user: "" });
    expect(await refusal({ root: workspace(EIGHT) }, io)).toEqual([
      expect.stringContaining("npm whoami: not logged in") as string,
    ]);
    expect(world.packed).toEqual([]);
  });

  it("defaults the tag from the version and refuses latest for a prerelease", async () => {
    expect(defaultTag("3.0.0-rc.0")).toBe("next");
    expect(defaultTag("3.0.0")).toBe("latest");
    expect(tagProblems("latest", "3.0.0")).toEqual([]);
    expect(tagProblems("next", "3.0.0-rc.0")).toEqual([]);
    expect(tagProblems("1.2.3", "3.0.0")).toEqual([
      "--tag 1.2.3: a tag is a word, such as next or latest",
    ]);
    expect(tagProblems("v3", "3.0.0")).toEqual([
      "--tag v3: npm refuses a tag that reads as a version or range",
    ]);
    expect(
      await refusal({ root: workspace(EIGHT), tag: "latest" }, fakes().io),
    ).toEqual([
      expect.stringContaining(
        "--tag latest for the prerelease 3.0.0-rc.0",
      ) as string,
    ]);
  });

  it("refuses without a CHANGELOG entry for the version", async () => {
    const root = workspace(EIGHT, {
      changelog: "# Changelog\n\n## 2.2.0\n\nOld.\n",
    });
    expect(await refusal({ root }, fakes().io)).toEqual([
      "CHANGELOG.md has no entry for 3.0.0-rc.0: bun scripts/changelog.ts 3.0.0-rc.0 writes one (commit it first)",
    ]);
  });

  it("refuses when gh is not logged in or cannot push, unless --no-release", async () => {
    const root = workspace(EIGHT);
    const out = fakes({
      gh: {
        "auth status": {
          code: 1,
          out: "You are not logged into any GitHub hosts.",
        },
      },
    });
    expect(await refusal({ root }, out.io)).toEqual([
      expect.stringContaining("gh is not logged in (gh auth status)") as string,
    ]);
    const reader = fakes({
      gh: {
        "api repos/owner/repo --jq .permissions.push": {
          code: 0,
          out: "false\n",
        },
      },
    });
    expect(await refusal({ root }, reader.io)).toEqual([
      expect.stringContaining(
        "the active gh account (owner) cannot push to owner/repo",
      ) as string,
    ]);
    const skipped = await runPublish({ root, noRelease: true }, out.io);
    expect(skipped.ok).toBe(true);
    expect(skipped.release).toBe("skipped");
  });

  it("refuses when v<version> exists at another commit, locally or on origin", async () => {
    const root = workspace(EIGHT);
    const local = fakes({
      git: {
        "rev-parse -q --verify refs/tags/v3.0.0-rc.0^{commit}": {
          code: 0,
          out: `${OTHER}\n`,
        },
      },
    });
    expect(await refusal({ root }, local.io)).toEqual([
      `the tag v3.0.0-rc.0 exists locally at ${OTHER}, not HEAD (${HEAD})`,
    ]);
    const remote = fakes({
      git: {
        "ls-remote --tags origin refs/tags/v3.0.0-rc.0 refs/tags/v3.0.0-rc.0^{}":
          {
            code: 0,
            out: `${HEAD}\trefs/tags/v3.0.0-rc.0\n${OTHER}\trefs/tags/v3.0.0-rc.0^{}\n`,
          },
      },
    });
    expect(await refusal({ root }, remote.io)).toEqual([
      `origin's tag v3.0.0-rc.0 is at ${OTHER}, not HEAD (${HEAD})`,
    ]);
    expect(local.world.packed).toEqual([]);
  });

  it("retries an unreadable origin, then refuses before anything is packed", async () => {
    const down = {
      code: 128,
      out: "ssh: connect to host github.com port 22: Connection timed out",
    };
    const { io, world } = fakes({
      git: {
        "ls-remote --tags origin refs/tags/v3.0.0-rc.0 refs/tags/v3.0.0-rc.0^{}":
          [down, down, down],
      },
    });
    expect(await refusal({ root: workspace(EIGHT) }, io)).toEqual([
      expect.stringContaining(
        "could not read origin's tags after 3 attempts",
      ) as string,
    ]);
    expect(world.sleeps).toEqual([5000, 10000]);
    expect(world.packed).toEqual([]);
  });

  it("reads the peeled commit of an annotated tag from ls-remote", () => {
    const lines = `${OTHER}\trefs/tags/v1\n${HEAD}\trefs/tags/v1^{}\n`;
    expect(remoteTagCommit(lines, "v1")).toBe(HEAD);
    expect(remoteTagCommit(`${OTHER}\trefs/tags/v1\n`, "v1")).toBe(OTHER);
    expect(remoteTagCommit("", "v1")).toBeUndefined();
  });
});

describe("skip, pack and guard", () => {
  it("skips what the registry has: not packed, not published, and a re-run carries on", async () => {
    const onRegistry = EIGHT_ORDER.slice(0, 3).map((n) => `${n}@${VERSION}`);
    const { io, world } = fakes({ onRegistry });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.skipped).toEqual(EIGHT_ORDER.slice(0, 3));
    expect(report.published).toEqual(EIGHT_ORDER.slice(3));
    expect(world.packed).toHaveLength(5);
    expect(world.published).toHaveLength(5);
  });

  it("with everything on the registry, publishes nothing and still finishes the release", async () => {
    const { io, world } = fakes({
      onRegistry: EIGHT_ORDER.map((n) => `${n}@${VERSION}`),
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(true);
    expect(world.packed).toEqual([]);
    expect(world.prompts).toBe(0);
    expect(report.release).toBe("created");
    expect(world.gh.some((c) => c.startsWith("release create"))).toBe(true);
  });

  it("refuses tarballs that still name workspace: or catalog: (npm pack), before asking for a code", async () => {
    const { io, world } = fakes({ npmLike: true });
    const reasons = await refusal({ root: workspace(EIGHT) }, io);
    expect(reasons).toContain(
      "@fx/bun-common: unresolved workspace protocol: dependencies.@fx/bun-contract: workspace:^",
    );
    expect(reasons).toContain(
      "@fx/bun-contract: unresolved workspace protocol: devDependencies.typescript: catalog:",
    );
    expect(world.prompts).toBe(0);
    expect(world.published).toEqual([]);
  });
});

describe("the one-time code", () => {
  it("asks once, passes it to every publish, and never logs it", async () => {
    const { io, world } = fakes();
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(true);
    expect(world.prompts).toBe(1);
    expect(world.published.map((p) => p.otp)).toEqual(
      Array.from({ length: 8 }, () => OTP),
    );
    expect(world.published.every((p) => p.tag === "next" && !p.dryRun)).toBe(
      true,
    );
    expect(world.log.join("\n")).not.toContain(OTP);
  });

  it("on EOTP asks for a new code and retries that package, then carries on", async () => {
    const { io, world } = fakes({
      codes: [OTP, "246802"],
      publish: {
        "@fx/bun-common": [
          {
            ok: false,
            otpError: true,
            output: `npm error code EOTP (code ${OTP} rejected)`,
          },
        ],
      },
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(true);
    expect(world.prompts).toBe(2);
    expect(world.published.map((p) => p.otp)).toEqual([
      OTP,
      OTP,
      OTP,
      ...Array.from({ length: 6 }, () => "246802"),
    ]);
    expect(report.published).toEqual(EIGHT_ORDER);
    expect(world.log.join("\n")).not.toContain(OTP);
    expect(world.log.join("\n")).not.toContain("246802");
  });

  it("stops on any other failure, saying what was published and what was not, with no tag or release", async () => {
    const { io, world } = fakes({
      publish: {
        "@fx/bun-cache": [
          {
            ok: false,
            otpError: false,
            output: "npm error code E403 forbidden",
          },
        ],
      },
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(false);
    expect(report.published).toEqual(EIGHT_ORDER.slice(0, 4));
    expect(report.notPublished).toEqual(EIGHT_ORDER.slice(4));
    expect(world.prompts).toBe(1);
    expect(report.release).toBe("not-reached");
    expect(
      world.git.some((c) => c.startsWith("tag ") || c.startsWith("push ")),
    ).toBe(false);
    expect(world.log).toContain(
      `not published: ${EIGHT_ORDER.slice(4).join(", ")}`,
    );
  });

  it("takes --otp without asking, and --no-otp asks for nothing", async () => {
    const given = fakes();
    await runPublish({ root: workspace(EIGHT), otp: "111222" }, given.io);
    expect(given.world.prompts).toBe(0);
    expect(given.world.published[0].otp).toBe("111222");
    const none = fakes();
    await runPublish({ root: workspace(EIGHT), otp: false }, none.io);
    expect(none.world.prompts).toBe(0);
    expect(none.world.published[0].otp).toBeUndefined();
  });
});

describe("dry run", () => {
  it("rehearses every upload with npm publish --dry-run, asks for no code, and only prints the release", async () => {
    const { io, world } = fakes();
    const report = await runPublish(
      { root: workspace(EIGHT), dryRun: true },
      io,
    );
    expect(report.ok).toBe(true);
    expect(report.release).toBe("dry-run");
    expect(world.prompts).toBe(0);
    expect(world.published.every((p) => p.dryRun && p.otp === undefined)).toBe(
      true,
    );
    expect(world.git.some((c) => /^(?:tag|push) /.test(c))).toBe(false);
    expect(world.gh.some((c) => c.startsWith("release create"))).toBe(false);
    expect(world.log).toContain(
      `  git tag -s -a v${VERSION} -m v${VERSION} ${HEAD}`,
    );
    expect(world.log).toContain(`  npm view @fx/bun-nest@next version`);
    // The notes are written, so the rehearsal shows them.
    const notes = world.log.find((l) => l.startsWith("release notes: "))!;
    expect(
      readFileSync(notes.slice("release notes: ".length), "utf8"),
    ).toContain("The release candidate.");
  });
});

describe("the work directory", () => {
  const madeWork = (log: string[], verb: string) =>
    log
      .find((l) => l.startsWith(`${verb} the work directory `))
      ?.slice(`${verb} the work directory `.length)
      .replace(/ \(remove it when done\)$/, "");

  it("is removed after a real run publishes everything, when the run made it", async () => {
    const { io, world } = fakes();
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(true);
    const dir = madeWork(world.log, "removed");
    expect(dir).toBeDefined();
    expect(existsSync(dir!)).toBe(false);
    expect(report.work).toBe("");
  });

  it("is kept when the run fails, so the tarballs can be inspected", async () => {
    const down = { code: 128, out: "Connection closed by remote host" };
    const { io, world } = fakes({
      git: { [`push origin refs/tags/v${VERSION}`]: [down, down, down] },
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.ok).toBe(false);
    const dir = madeWork(world.log, "kept");
    expect(dir).toBeDefined();
    expect(existsSync(dir!)).toBe(true);
  });

  it("is never removed when it was given", async () => {
    const { io } = fakes();
    const work = join(scratch, "given-work");
    const report = await runPublish({ root: workspace(EIGHT), work }, io);
    expect(report.ok).toBe(true);
    expect(existsSync(work)).toBe(true);
  });
});

describe("the release step", () => {
  it("tags (signed), pushes and creates a prerelease with the CHANGELOG entry and npm links", async () => {
    const { io, world } = fakes();
    const work = join(scratch, "release-work");
    const report = await runPublish({ root: workspace(EIGHT), work }, io);
    expect(report.release).toBe("created");
    expect(world.git).toContain(`tag -s -a v${VERSION} -m v${VERSION} ${HEAD}`);
    expect(world.git).toContain(`push origin refs/tags/v${VERSION}`);
    const notesFile = join(work, `release-notes-v${VERSION}.md`);
    expect(world.gh).toContain(
      `release create v${VERSION} --title v${VERSION} --notes-file ${notesFile} --verify-tag --prerelease`,
    );
    const notes = readFileSync(notesFile, "utf8");
    expect(notes).toStartWith("The release candidate.\n\n### npm\n\n");
    expect(notes).toContain(
      `- [@fx/bun-nest@${VERSION}](https://www.npmjs.com/package/@fx/bun-nest/v/${VERSION})`,
    );
  });

  it("retries a failing push, then prints the commands that finish the release", async () => {
    const down = { code: 128, out: "Connection closed by remote host" };
    const { io, world } = fakes({
      git: { [`push origin refs/tags/v${VERSION}`]: [down, down, down] },
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.published).toEqual(EIGHT_ORDER);
    expect(report.release).toBe("failed");
    expect(report.ok).toBe(false);
    expect(world.git.filter((c) => c.startsWith("push "))).toHaveLength(3);
    expect(world.log).toContain(`  git push origin refs/tags/v${VERSION}`);
    expect(world.gh.some((c) => c.startsWith("release create"))).toBe(false);
  });

  it("skips each step already done: the tag at HEAD, on origin, and the release", async () => {
    const { io, world } = fakes({
      onRegistry: EIGHT_ORDER.map((n) => `${n}@${VERSION}`),
      git: {
        [`rev-parse -q --verify refs/tags/v${VERSION}^{commit}`]: {
          code: 0,
          out: `${HEAD}\n`,
        },
        [`ls-remote --tags origin refs/tags/v${VERSION} refs/tags/v${VERSION}^{}`]:
          {
            code: 0,
            out: `${OTHER}\trefs/tags/v${VERSION}\n${HEAD}\trefs/tags/v${VERSION}^{}\n`,
          },
      },
      gh: {
        [`release view v${VERSION} --json tagName`]: { code: 0, out: "{}" },
      },
    });
    const report = await runPublish({ root: workspace(EIGHT) }, io);
    expect(report.release).toBe("created");
    expect(world.git.some((c) => /^(?:tag|push) /.test(c))).toBe(false);
    expect(world.gh.some((c) => c.startsWith("release create"))).toBe(false);
  });

  it("makes a final version's release no prerelease, on latest", async () => {
    const root = workspace(
      Object.fromEntries(
        Object.entries(EIGHT).map(([d, m]) => [d, { ...m, version: "3.0.0" }]),
      ),
      { changelog: "# Changelog\n\n## 3.0.0\n\nFinal.\n" },
    );
    writeFileSync(
      join(root, "lerna.json"),
      JSON.stringify({ version: "3.0.0" }),
    );
    const { io, world } = fakes();
    // The fake packer writes VERSION's file names; only the release is read here.
    const report = await runPublish(
      { root, noRelease: false },
      {
        ...io,
        registry: { ...io.registry, isPublished: async () => true },
      },
    );
    expect(report.tag).toBe("latest");
    const create = world.gh.find((c) => c.startsWith("release create"))!;
    expect(create).toContain("--title v3.0.0");
    expect(create).not.toContain("--prerelease");
  });
});

describe("parseArgs", () => {
  it("reads every flag and refuses unknown ones", () => {
    expect(
      parseArgs(
        [
          "--dry-run",
          "--tag",
          "beta",
          "--no-otp",
          "--allow-dirty",
          "--skip-whoami",
          "--no-release",
        ],
        "/r",
      ),
    ).toEqual({
      root: "/r",
      dryRun: true,
      tag: "beta",
      otp: false,
      allowDirty: true,
      skipWhoami: true,
      noRelease: true,
    });
    expect(parseArgs(["--otp", "123"], "/r").otp).toBe("123");
    expect(() => parseArgs(["--tag"], "/r")).toThrow("--tag needs a value");
    expect(() => parseArgs(["--publish-everything"], "/r")).toThrow(
      "unknown argument",
    );
  });
});
