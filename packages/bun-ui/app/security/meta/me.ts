/** Who the operator is (`GET /operators/me`): their role bindings drive the scope picker. */
import type { Routes } from "../api/routes.gen";
import { createContext, use } from "react";

/** `GET /operators/me`. */
export type MeDto = Routes["GET /operators/me"]["responses"][200];

/** The loaded operator. */
export const MeContext = createContext<MeDto | null>(null);

/** The loaded operator (inside `<MetaProvider>`). */
export function useMe(): MeDto {
  const me = use(MeContext);
  if (me === null)
    throw new Error("useMe must be used inside a loaded <MetaProvider>");
  return me;
}
