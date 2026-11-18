/**
 * A draft's effect on each service under its scope (PR-U4F, ui.md §3): each
 * affected service's effective policy as published and with the scope's
 * draft in its place, as the differences between the two. Bounded like the
 * impact estimate (at most {@link DRAFT_EFFECT_LIMITS}'s services); each
 * service shown only to an operator with `policy:read` on it, redacted as a
 * policy read is. Browser-safe: types and constants only.
 */
import type { PolicyChangeDto, PolicyScopeId } from "./types";

/** The bounds of `GET /policies/:scope/draft/effect`. */
export const DRAFT_EFFECT_LIMITS = /* @__PURE__ */ Object.freeze({
  /** The most services compared. */
  maxServices: 200,
  /** The most changes listed per service; the rest are counted. */
  maxChanges: 500,
});

/** One service's effective policy, before and after the draft. */
export interface DraftServiceEffectDto {
  /** The service. */
  readonly service: string;
  /** The differences, published → with the draft, at most {@link DRAFT_EFFECT_LIMITS}'s `maxChanges`. */
  readonly changes: readonly PolicyChangeDto[];
  /** How many more differences there are than listed. */
  readonly more: number;
  /** Why the draft cannot apply to it, when its effective policy with the draft does not compile (no changes then). */
  readonly error?: string;
}

/** `GET /policies/:scope/draft/effect`. */
export interface DraftEffectDto {
  /** The draft's scope. */
  readonly scope: PolicyScopeId;
  /** The services compared, by id; one the draft leaves unchanged has no changes. */
  readonly services: readonly DraftServiceEffectDto[];
  /** The services left out: one the operator may not read. */
  readonly skipped: readonly {
    readonly service: string;
    readonly reason: string;
  }[];
  /** How many services past the bound were not compared. */
  readonly notCompared: number;
}
