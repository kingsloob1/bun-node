import process from "node:process";
import { ConfigError } from "./errors";

/**
 * What a child process's environment is built from: the policy behind
 * `SpawnOptions.env` and `SpawnOptions.passEnv`.
 *
 * A child used to receive `...process.env`, so every secret the host held —
 * a database URL, a cloud key — was in every job's environment. By default it
 * now receives an **allowlist**: {@link CHILD_BASE_ENV}, the names asked for
 * in `passEnv`, and the literal values in `env`. `env: "inherit"` restores
 * the whole environment.
 *
 * Kept free of the runner and the queue so that anything in the package that
 * starts a child process applies the same policy with the same names.
 *
 * **What it bounds, and what it does not.** It decides the environment of the
 * child bun-jobs itself starts. It does not touch the parent's own
 * `process.env`, so a job that can read the parent's memory or files (an
 * `in-process` or `worker-thread` target) is not stopped by it, and a child
 * that starts processes of its own passes them whatever it has. A child
 * running as the parent's user can also read the parent's *startup*
 * environment from `/proc/<ppid>/environ` on Linux (measured); running it as
 * another user (`uid`/`gid`) closes that.
 */

/**
 * The variables every child receives from the parent's **live**
 * `process.env` (when set there) unless `env: "inherit"` gives it everything.
 *
 * Each one configures *how a process runs* and none carries a credential:
 *
 * - `PATH`, `HOME`, `TMPDIR` (and Windows' `TMP`, `TEMP`): finding
 *   executables, the home directory and a temporary directory — what a
 *   handler that spawns a tool or writes a scratch file needs;
 * - `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TZ`: locale and time zone, so
 *   a child formats dates and text the way its parent does;
 * - `TERM`, `NO_COLOR`, `FORCE_COLOR`: how output is coloured;
 * - `NODE_ENV`: the switch libraries read to choose development or
 *   production behaviour;
 * - `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`: paths to the
 *   trusted certificates, without which a job's HTTPS calls fail behind a
 *   corporate proxy;
 * - `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `APPDATA`,
 *   `LOCALAPPDATA`: what a Windows process needs to load system libraries
 *   and find its profile. Absent elsewhere, and then simply not copied.
 *
 * Left out on purpose: the proxy variables (`HTTP_PROXY`, …), which can carry
 * a password in their URL, and anything named after a service. Ask for those
 * by name with `passEnv`.
 */
export const CHILD_BASE_ENV: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

/**
 * The `env` option of a child: literal values over the allowlist, or
 * `"inherit"` for the parent's whole live environment.
 */
export type ChildEnv = "inherit" | Readonly<Record<string, string | undefined>>;

/** The two options a child's environment is built from. */
export interface ChildEnvPolicy {
  /**
   * The child's environment. An object (the default, `{}`): these literal
   * values, over {@link CHILD_BASE_ENV} and `passEnv`; a value of `undefined`
   * removes a variable the base set would have copied. `"inherit"`: the
   * parent's whole live `process.env`, the behaviour before the allowlist.
   */
  env?: ChildEnv;
  /**
   * Names of variables to copy from the parent's live `process.env` at each
   * spawn, beyond {@link CHILD_BASE_ENV}. A name the parent does not have is
   * skipped. Contradicts `env: "inherit"`, which already copies everything.
   */
  passEnv?: readonly string[];
}

/** A variable name: no `=` and no NUL, which no environment can hold. */
const NAME = /^[^=\0]+$/;

/**
 * Checks a policy as plain JavaScript may have written it, and throws a
 * `ConfigError` naming the bad value. `where` prefixes the message, e.g.
 * `"spawn."`.
 */
export function checkChildEnv(policy: ChildEnvPolicy, where = ""): void {
  const { env, passEnv } = policy as { env?: unknown; passEnv?: unknown };

  if (env !== undefined && env !== "inherit") {
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      throw new ConfigError(
        `${where}env must be "inherit" or an object of string values, not ${describe(env)}`,
        { env: describe(env) },
      );
    }
    for (const [name, value] of Object.entries(env)) {
      if (!NAME.test(name)) {
        throw new ConfigError(
          `${where}env key "${name}" is not a variable name`,
          { name },
        );
      }
      if (value !== undefined && typeof value !== "string") {
        throw new ConfigError(
          `${where}env.${name} must be a string or undefined, not ${typeof value}`,
          { name, type: typeof value },
        );
      }
    }
  }

  if (passEnv !== undefined) {
    if (!Array.isArray(passEnv)) {
      throw new ConfigError(
        `${where}passEnv must be an array of variable names, not ${describe(passEnv)}`,
        { passEnv: describe(passEnv) },
      );
    }
    for (const name of passEnv) {
      if (typeof name !== "string" || !NAME.test(name)) {
        throw new ConfigError(
          `${where}passEnv entry ${JSON.stringify(name)} is not a variable name`,
          { name: String(name) },
        );
      }
    }
    if (env === "inherit" && passEnv.length > 0) {
      throw new ConfigError(
        `${where}passEnv has no effect with env: "inherit", which already passes every variable; drop one of them`,
        { passEnv },
      );
    }
  }
}

/**
 * The environment a child gets under `policy`, built from `source` — the
 * parent's **live** `process.env` by default, read now.
 *
 * Always pass the result to `Bun.spawn` explicitly: with no `env`, Bun hands
 * a child the environment this process *started* with, so a variable set or
 * deleted since would be wrong in it.
 */
export function buildChildEnv(
  policy: ChildEnvPolicy = {},
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};

  if (policy.env === "inherit") {
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) {
        out[name] = value;
      }
    }
    return out;
  }

  for (const name of [...CHILD_BASE_ENV, ...(policy.passEnv ?? [])]) {
    const value = source[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  for (const [name, value] of Object.entries(policy.env ?? {})) {
    if (value === undefined) {
      delete out[name];
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** A value, briefly, for a message. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return value === null ? "null" : typeof value;
}
