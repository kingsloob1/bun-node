import process from "node:process";
import { defineProcessor } from "../../../lib/queue/types";

/** Returns the processor's whole environment, as its own process sees it. */
export default defineProcessor(
  async () => ({ ...process.env }) as Record<string, string>,
);
