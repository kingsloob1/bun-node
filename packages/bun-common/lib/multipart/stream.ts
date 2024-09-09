import { pipeline } from "node:stream";
import { promisify } from "node:util";

export const pump = promisify(pipeline);
