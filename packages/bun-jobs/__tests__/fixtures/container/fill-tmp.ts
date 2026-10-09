import { Buffer } from "node:buffer";
import { appendFileSync } from "node:fs";

/** Writes 1 MiB at a time to /tmp until refused or 120 MiB, and says which. */
export default async () => {
  const mib = Buffer.alloc(1024 * 1024, 1);
  for (let i = 0; i < 120; i++) {
    try {
      appendFileSync("/tmp/fill", mib);
    } catch (error) {
      return `stopped at ${i} MiB: ${(error as { code?: string }).code}`;
    }
  }
  return "wrote 120 MiB to /tmp";
};
