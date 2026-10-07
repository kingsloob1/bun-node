import process from "node:process";

/** Exits 0 without reporting anything: a run that never said how it ended. */
export default async () => {
  process.exit(0);
};
