/**
 * What the ban form needs of addresses, on the app's one parser
 * (`cidr.ts`): whether text is an address or a range, and whether a range
 * holds an address, so the form can warn before banning the operator's
 * own.
 */
import type { Cidr } from "./cidr";
import { cidrContains, parseCidr } from "./cidr";

/** An address or a range (a bare address is a /32 or /128), or `null`. */
export function parseAddressOrRange(text: string): Cidr | null {
  return parseCidr(text);
}

/** Whether `subject` (an address or a CIDR range) holds `address`. */
export function covers(subject: string, address: string): boolean {
  const range = parseCidr(subject);
  const target = parseCidr(address);
  return range !== null && target !== null && cidrContains(range, target);
}
