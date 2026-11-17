/**
 * The agent's last known good (topologies.md §4, the user's decisions for
 * PR-CP4): one file, written atomically (a temporary file in the same
 * directory, `0600`, then a rename), read before the agent talks to the
 * control plane. It holds the last verified bundle and its `ETag`, the
 * highest bundle version ever accepted (a floor no later bundle may go
 * below, across restarts), and the last verified full ban batch. Nothing
 * in it is trusted as read: the bundle and the ban batch are verified again
 * with the deploy-time keys at start.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import type { BanBatch } from "../bundle/bans";
import type { SecurityBundle } from "../bundle/bundle";

/** The state file's format id. */
export const AGENT_STATE_FORMAT = "bun-security.agent-state/1";

/** What the state file holds. */
export interface AgentState {
  /** {@link AGENT_STATE_FORMAT}. */
  readonly format: typeof AGENT_STATE_FORMAT;
  /** The last bundle accepted, as signed. */
  readonly bundle: SecurityBundle | null;
  /** Its `ETag`. */
  readonly etag: string | null;
  /** The highest bundle version ever accepted. */
  readonly floor: number;
  /** The last full ban batch accepted, as signed. */
  readonly bans: BanBatch | null;
}

/** An empty state. */
export const EMPTY_STATE: AgentState = Object.freeze({
  format: AGENT_STATE_FORMAT,
  bundle: null,
  etag: null,
  floor: 0,
  bans: null,
});

/** What reading the state file found. */
export type StateRead =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly error: string }
  | { readonly kind: "read"; readonly state: AgentState };

/** Reads the state file. */
export async function readState(path: string): Promise<StateRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT")
      return { kind: "missing" };
    return {
      kind: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const value = JSON.parse(text) as Partial<AgentState>;
    if (
      value.format !== AGENT_STATE_FORMAT ||
      !Number.isSafeInteger(value.floor) ||
      (value.floor as number) < 0
    ) {
      return { kind: "unreadable", error: "not an agent state file" };
    }
    return {
      kind: "read",
      state: {
        format: AGENT_STATE_FORMAT,
        bundle: value.bundle ?? null,
        etag: typeof value.etag === "string" ? value.etag : null,
        floor: value.floor as number,
        bans: value.bans ?? null,
      },
    };
  } catch (error) {
    return {
      kind: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Writes the state file atomically, `0600`. */
export async function writeState(
  path: string,
  state: AgentState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    // The mode a umask may have narrowed is narrowed further, never widened.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
