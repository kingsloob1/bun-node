/**
 * What every part of the policy editor reads: the scope, the policy being
 * edited (the draft, else the published version), the scope's published
 * effective policy (origins and locks; none on global), whether the
 * operator may change it, how to change one field, and the issues a save's
 * `422` named, by path.
 */
import type { EffectiveView, JsonObject, PolicyPath } from "./paths";
import { createContext, useContext } from "react";

/** The editor's state; see the module's description. */
export interface PolicyEditorState {
  /** The scope edited. */
  readonly scope: string;
  /** The policy being edited, with the unsaved changes. */
  readonly working: JsonObject;
  /** The published effective policy, on a service or a group. */
  readonly effective: EffectiveView | undefined;
  /** Whether the operator may change the draft (`policy:draft`). */
  readonly canEdit: boolean;
  /** Sets one field (`undefined` removes it from the scope's policy). */
  readonly set: (path: PolicyPath, value: unknown) => void;
  /** The save's issues at exactly `path`. */
  readonly issuesAt: (path: PolicyPath) => readonly string[];
}

/** The editor's context. */
export const PolicyEditorContext = createContext<PolicyEditorState | null>(
  null,
);

/** The editor's state; throws outside the editor. */
export function usePolicyEditor(): PolicyEditorState {
  const state = useContext(PolicyEditorContext);
  if (state === null)
    throw new Error("usePolicyEditor() outside the policy editor");
  return state;
}
