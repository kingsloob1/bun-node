import type { ErrorDto } from "../../api/types";

/** How many causes are followed; the API itself stops at five. */
const MAX_CAUSES = 5;

/** The error and its causes, outermost first. */
export function causeChain(error: ErrorDto): ErrorDto[] {
  const chain: ErrorDto[] = [error];
  let current = error.cause;
  while (current && chain.length <= MAX_CAUSES) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}
