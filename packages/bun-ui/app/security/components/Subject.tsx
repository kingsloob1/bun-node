/**
 * A subject as the API reports it: an address, a range, or an account's key
 * (its HMAC under the fleet's secret, never the id), with its country and
 * ASN when known. One place, so every screen shows subjects alike.
 */
import type { SubjectKind } from "./subjects";
import { SUBJECT_LABELS } from "./subjects";

export type { SubjectKind } from "./subjects";

/** Props of {@link Subject}. */
export interface SubjectProps {
  /** Its kind. */
  kind: SubjectKind;
  /** Its value, as the API reports it. */
  value: string;
  /** Its country (ISO 3166-1 alpha-2), when known. */
  country?: string;
  /** Its autonomous system number, when known. */
  asn?: number;
}

/** See the module's description. */
export function Subject({ kind, value, country, asn }: SubjectProps) {
  const facts = [country, asn === undefined ? undefined : `AS${asn}`].filter(
    (part): part is string => part !== undefined,
  );
  return (
    <span
      className="subject"
      data-kind={kind}
    >
      <span className="subject-kind">{SUBJECT_LABELS[kind]}</span>{" "}
      <code className="subject-value">{value}</code>
      {facts.length === 0 ? null : (
        <span className="subject-facts"> ({facts.join(", ")})</span>
      )}
    </span>
  );
}
