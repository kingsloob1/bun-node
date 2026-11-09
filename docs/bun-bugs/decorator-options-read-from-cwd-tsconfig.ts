// Bun-only reproduction: `experimentalDecorators` and `emitDecoratorMetadata`
// are read from the working directory's tsconfig.json, not from the tsconfig
// that covers the file. One project, one file, one tsconfig beside it that
// enables both: run from the project's own directory its decorators apply, and
// run from the directory above (no tsconfig) a parameter decorator silently
// does nothing and no metadata is emitted. Exits 1 while the bug is present.
//
//   bun docs/bun-bugs/decorator-options-read-from-cwd-tsconfig.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

console.log(`Bun ${Bun.version} (${Bun.revision})`);

const root = mkdtempSync(join(tmpdir(), "decorator-options-"));
const project = join(root, "project");
mkdirSync(project);
writeFileSync(
  join(project, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  }),
);
writeFileSync(
  join(project, "probe.ts"),
  `
const applied: string[] = [];
const emitted: string[] = [];
(Reflect as any).metadata = (key: string) => () => { emitted.push(key); };
function Mark(_target: unknown, _key: unknown, index: number) { applied.push(String(index)); }
class Dependency {}
class Service { constructor(@Mark readonly dependency: Dependency) {} }
console.log(JSON.stringify({ parameterDecorator: applied.length === 1, metadata: emitted.includes("design:paramtypes"), service: typeof Service }));
`,
);

/** Runs the same file from a directory; what its decorators did. */
function run(cwd: string): {
  parameterDecorator: boolean;
  metadata: boolean;
} {
  const child = Bun.spawnSync([process.execPath, join(project, "probe.ts")], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
  });
  return JSON.parse(child.stdout.toString());
}

const fromProject = run(project);
const fromParent = run(root);
rmSync(root, { recursive: true, force: true });

console.log("run from the file's own project:", fromProject);
console.log("run from the directory above:   ", fromParent);

const expected = fromProject.parameterDecorator && fromProject.metadata;
const present =
  expected && !(fromParent.parameterDecorator && fromParent.metadata);
console.log(
  present
    ? "BUG: the same file's decorators depend on the working directory"
    : "fixed: the tsconfig covering the file decides, wherever Bun was started",
);
process.exit(present ? 1 : 0);
