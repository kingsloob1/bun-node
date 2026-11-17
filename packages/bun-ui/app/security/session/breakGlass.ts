/**
 * The break-glass session (the user's decision, PR-U1): the token
 * `POST /break-glass/session` answered, kept in `sessionStorage` (gone when
 * the tab closes) with its expiry, sent in `x-bun-security-break-glass` on
 * every call while it lasts, and cleared on expiry or a `401`.
 */

/** Where the session is kept. */
export const BREAK_GLASS_STORAGE_KEY = "bun-security-ui:break-glass";

/** A held session. */
export interface BreakGlassSession {
  /** The token. */
  readonly token: string;
  /** When it expires, epoch ms. */
  readonly expiresAt: number;
  /** The header it travels in. */
  readonly header: string;
}

/** Reads and writes the session; `storage` is `sessionStorage` (tests pass their own). */
export interface BreakGlassStore {
  /** The session while it lasts; an expired one is cleared and answers `null`. */
  readonly current: () => BreakGlassSession | null;
  /** Keeps a new session. */
  readonly save: (session: BreakGlassSession) => void;
  /** Forgets it. */
  readonly clear: () => void;
}

/** The store over `storage` and the clock `now`. */
export function breakGlassStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
  now: () => number = Date.now,
): BreakGlassStore {
  /** The session when storage refuses it: it then lasts only for this page. */
  let memory: BreakGlassSession | null = null;
  const clear = () => {
    memory = null;
    try {
      storage?.removeItem(BREAK_GLASS_STORAGE_KEY);
    } catch {
      // Storage refused: nothing kept anyway.
    }
  };
  return Object.freeze({
    current: () => {
      let raw: string | null;
      try {
        raw = storage?.getItem(BREAK_GLASS_STORAGE_KEY) ?? null;
      } catch {
        raw = null;
      }
      if (raw === null) {
        if (memory !== null && !(memory.expiresAt > now())) memory = null;
        return memory;
      }
      try {
        const session = JSON.parse(raw) as BreakGlassSession;
        if (typeof session.token !== "string" || !(session.expiresAt > now())) {
          clear();
          return null;
        }
        return session;
      } catch {
        clear();
        return null;
      }
    },
    save: (session: BreakGlassSession) => {
      memory = session;
      try {
        storage?.setItem(BREAK_GLASS_STORAGE_KEY, JSON.stringify(session));
      } catch {
        // Storage refused: the session lasts only for this page.
      }
    },
    clear,
  });
}
