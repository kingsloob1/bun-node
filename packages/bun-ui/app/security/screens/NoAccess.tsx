/**
 * What a deep link to a section shows when the operator may not read it on
 * the scope (the user's decision): which section, which scope, and the
 * permission it needs, with the scope picker still in the header.
 */
import { scopeLabel } from "../scope/scope";

/** Props of {@link NoAccess}. */
export interface NoAccessProps {
  /** The section's label. */
  section: string;
  /** The scope on screen, or `null` when the operator can read none. */
  scope: string | null;
  /** The permission the section needs. */
  needs: string;
}

/** See the module's description. */
export function NoAccess({ section, scope, needs }: NoAccessProps) {
  return (
    <div
      className="screen"
      data-testid="no-access"
    >
      <h1>No access</h1>
      <p>
        {scope === null
          ? `You may not read any scope, so ${section} has nothing to show. Ask an owner for a role.`
          : `You may not see ${section} in ${scopeLabel(scope)}: it needs the ${needs} permission there. Choose another scope, or ask an owner for a role.`}
      </p>
    </div>
  );
}
