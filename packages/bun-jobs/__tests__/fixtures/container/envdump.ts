import process from "node:process";

/** Returns its whole environment and argv. */
export default async () => ({ env: { ...process.env }, argv: process.argv });
