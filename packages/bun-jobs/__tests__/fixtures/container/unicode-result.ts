/**
 * Returns a quiet, non-ASCII result of about 3.6M JSON characters, and
 * prints nothing: what an earlier framing tripled in memory, getting the
 * container OOM-killed at the default 256m.
 */
export default async () => ({ s: "é😀\u007F\u0000ʃ".repeat(300_000) });
