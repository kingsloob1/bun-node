import process from "node:process";

/**
 * Prints a line that starts with the channel's prefix but is no frame — what
 * a processor printing its own argv, or `ps` output, can produce — and
 * returns `"ok"`. The worker must keep the whole line as output.
 */
export default async () => {
  // eslint-disable-next-line no-console -- the line is the point
  console.log(
    `${process.argv.at(-2)} is my argv: ${process.argv.slice(-2).join(" ")}`,
  );
  return "ok";
};
