/** Throws, every time: an ordinary, retryable failure. */
export default async () => {
  throw new Error("boom in the container");
};
