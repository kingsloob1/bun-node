import { createContext, use } from "react";

/** What a {@link Field} tells the control inside it. */
export interface FieldControlProps {
  /** The control's `id`; the field's `<label htmlFor>` points at it. */
  id: string;
  /** Ids of the hint and error (and any extra description), space separated; `undefined` when there are none. */
  "aria-describedby": string | undefined;
  /** `true` while the field shows an error. */
  "aria-invalid": boolean | undefined;
  /** Whether the field is marked required. */
  required: boolean | undefined;
}

/** Carries the enclosing field's wiring; `null` outside a field. */
export const FieldContext = createContext<FieldControlProps | null>(null);

/** The enclosing {@link Field}'s wiring, or `null` when the control stands alone. */
export function useField(): FieldControlProps | null {
  return use(FieldContext);
}

/** Joins ids for `aria-describedby`, skipping empty ones; `undefined` when none are left. */
export function joinIds(
  ...ids: (string | false | null | undefined)[]
): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined === "" ? undefined : joined;
}
