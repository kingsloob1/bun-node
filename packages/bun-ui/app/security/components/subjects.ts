/** Subjects' kinds and their labels (`Subject.tsx` renders them). */

/** A subject's kinds. */
export type SubjectKind =
  "ip" | "cidr" | "user" | "apiKey" | "username" | "country" | "asn";

/** Each kind's label. */
export const SUBJECT_LABELS: Readonly<Record<SubjectKind, string>> = {
  ip: "Address",
  cidr: "Range",
  user: "User key",
  apiKey: "API key key",
  username: "Username key",
  country: "Country",
  asn: "ASN",
};
