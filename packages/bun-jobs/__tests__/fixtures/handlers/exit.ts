import process from "node:process";
import { defineHandler } from "../../../lib/index";

/** Ends the process without reporting a result, as a crash would. */
export default defineHandler(async () => {
  process.exit(3);
});
