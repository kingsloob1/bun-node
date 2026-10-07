// Installs the machine's shared heavy-run tools from this repository:
// `scripts/heavy-run.sh` and `scripts/heavy-queue.sh` become
// `/tmp/claude-1000/bun-node-heavy-run.sh` and `bun-node-heavy-queue.sh`.
//
//   bun scripts/install-heavy-run.ts              # install or refresh
//   bun scripts/install-heavy-run.ts --dry-run    # print the plan, write nothing
//   bun scripts/install-heavy-run.ts --dir <path> # somewhere else
//
// Run it after any change to those scripts, and again after a reboot clears
// /tmp. Each file is written to a temporary name beside its target, made
// executable and renamed over it, so a reader never sees half a file and a job
// already running keeps the file it opened: bash reads its script as it goes,
// and a rename leaves the old inode alone where writing in place would change
// the script under it. The wrapper it replaces is kept as
// `bun-node-heavy-run.prev.sh`.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

/** Where the installed copies live unless `--dir` says otherwise. */
export const DEFAULT_DIR = "/tmp/claude-1000";

/** Each source file in `scripts/`, and the name it is installed under. */
export const INSTALLED = [
  { source: "heavy-run.sh", target: "bun-node-heavy-run.sh" },
  { source: "heavy-queue.sh", target: "bun-node-heavy-queue.sh" },
] as const;

/** The name the replaced wrapper is kept under. */
export const PREVIOUS_WRAPPER = "bun-node-heavy-run.prev.sh";

export interface InstallOptions {
  /** The directory to install into. Default `/tmp/claude-1000`. */
  dir?: string;
  /** Plan only: report each step, write nothing. Default `false`. */
  dryRun?: boolean;
  /** Where the source scripts are. Default this file's directory. */
  sourceDir?: string;
}

export interface InstallStep {
  /**
   * `create-dir`: the directory was missing. `keep-previous`: the installed
   * wrapper is saved as `.prev`. `install`: the file is new or changed.
   * `unchanged`: the installed copy is already identical, so nothing is written.
   */
  action: "create-dir" | "keep-previous" | "install" | "unchanged";
  /** The file or directory the step writes, or would write. */
  path: string;
}

/**
 * Writes `content` to `target` atomically: a temporary file in the same
 * directory, made executable, then renamed over the target.
 */
function writeAtomically(target: string, content: Uint8Array) {
  const temp = `${target}.tmp-${process.pid}`;
  try {
    // Exclusive: a leftover temporary file of this pid is a bug worth failing
    // on, not one to write through.
    writeFileSync(temp, content, { flag: "wx" });
    chmodSync(temp, 0o755);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Installs (or with `dryRun`, plans) the heavy-run scripts; returns the steps. */
export function installHeavyRun(options: InstallOptions = {}): InstallStep[] {
  const dir = options.dir ?? DEFAULT_DIR;
  const sourceDir = options.sourceDir ?? import.meta.dir;
  const dryRun = options.dryRun ?? false;
  const steps: InstallStep[] = [];

  // Read every source first, so a missing one fails before anything changes.
  const files = INSTALLED.map(({ source, target }) => ({
    content: readFileSync(join(sourceDir, source)),
    target: join(dir, target),
  }));

  if (!existsSync(dir)) {
    steps.push({ action: "create-dir", path: dir });
    if (!dryRun) mkdirSync(dir, { recursive: true });
  }

  for (const { content, target } of files) {
    const current = existsSync(target) ? readFileSync(target) : undefined;
    if (current?.equals(content)) {
      steps.push({ action: "unchanged", path: target });
      continue;
    }
    if (current && target.endsWith(INSTALLED[0].target)) {
      const previous = join(dir, PREVIOUS_WRAPPER);
      steps.push({ action: "keep-previous", path: previous });
      if (!dryRun) {
        const temp = `${previous}.tmp-${process.pid}`;
        try {
          copyFileSync(target, temp);
          chmodSync(temp, 0o755);
          renameSync(temp, previous);
        } catch (error) {
          rmSync(temp, { force: true });
          throw error;
        }
      }
    }
    steps.push({ action: "install", path: target });
    if (!dryRun) writeAtomically(target, content);
  }
  return steps;
}

const USAGE = `usage: bun scripts/install-heavy-run.ts [--dir <path>] [--dry-run]

Installs scripts/heavy-run.sh and scripts/heavy-queue.sh as
<dir>/bun-node-heavy-run.sh and <dir>/bun-node-heavy-queue.sh
(default dir ${DEFAULT_DIR}), keeping the replaced wrapper as
${PREVIOUS_WRAPPER}. --dry-run prints the plan and writes nothing.`;

/** Parses the command line; returns the options, or a usage error message. */
export function parseArgs(argv: string[]): InstallOptions | { error: string } {
  const options: InstallOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--dir") {
      const value = argv[++i];
      if (!value) return { error: "--dir needs a path" };
      options.dir = value;
    } else if (arg.startsWith("--dir="))
      options.dir = arg.slice("--dir=".length);
    else return { error: `unknown argument: ${arg}` };
  }
  return options;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`${options.error}\n\n${USAGE}`);
    process.exit(2);
  }
  const steps = installHeavyRun(options);
  const verb = options.dryRun ? "would " : "";
  for (const { action, path } of steps) {
    const text = {
      "create-dir": `${verb}create ${path}`,
      "keep-previous": `${verb}keep the installed wrapper as ${path}`,
      install: `${verb}install ${path}`,
      unchanged: `${path} is already current`,
    }[action];
    console.log(text);
  }
  if (!options.dryRun && steps.some((s) => s.action === "install")) {
    console.log("Jobs already running keep the copy they started with.");
  }
}

if (import.meta.main) main();
