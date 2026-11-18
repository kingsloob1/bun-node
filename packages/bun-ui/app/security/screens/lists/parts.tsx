/**
 * Small parts the lists screens share: an entry's subject (through the
 * app's `Subject`; a raw account id never), and the save's one-time echo
 * of the account ids the operator typed.
 */
import type { ListEntryDto } from "./entries";
import type { EnteredAccount } from "./policy";
import { Button } from "../../../kit/components/Button";
import { Subject } from "../../components/Subject";

/** Props of {@link EntrySubject}. */
export interface EntrySubjectProps {
  /** The entry. */
  entry: ListEntryDto;
}

/** An entry's subject; see the module's description. */
export function EntrySubject({ entry }: EntrySubjectProps) {
  if (entry.ip !== undefined) {
    return (
      <Subject
        kind={entry.ip.includes("/") ? "cidr" : "ip"}
        value={entry.ip}
      />
    );
  }
  if (entry.userHash !== undefined)
    return (
      <Subject
        kind="user"
        value={entry.userHash}
      />
    );
  if (entry.apiKeyHash !== undefined)
    return (
      <Subject
        kind="apiKey"
        value={entry.apiKeyHash}
      />
    );
  if (entry.user !== undefined || entry.apiKey !== undefined) {
    // Typed and not yet saved: the control plane keys it on save.
    return (
      <span
        className="subject"
        data-kind={entry.user === undefined ? "apiKey" : "user"}
      >
        <span className="subject-kind">
          {entry.user === undefined ? "API key id" : "User id"}
        </span>{" "}
        <span className="muted">(keyed when saved)</span>
      </span>
    );
  }
  return entry.country !== undefined ? (
    <Subject
      kind="country"
      value={entry.country}
    />
  ) : (
    <Subject
      kind="asn"
      value={`AS${String(entry.asn)}`}
    />
  );
}

/** Props of {@link EnteredEcho}. */
export interface EnteredEchoProps {
  /** The accounts the save's answer echoed. */
  accounts: readonly EnteredAccount[];
  /** Dismisses it (for good: it is not stored anywhere). */
  onDismiss: () => void;
}

/**
 * The account ids the operator typed and the keys they became, from the
 * save's answer: shown this once (the control plane never stores the ids,
 * and no later read returns them).
 */
export function EnteredEcho({ accounts, onDismiss }: EnteredEchoProps) {
  return (
    <div
      className="notice lists-entered"
      role="status"
      data-testid="lists-entered"
    >
      <p>
        <strong>Saved as keys.</strong> The account ids you typed are shown this
        once: only their keys are stored.
      </p>
      <ul>
        {accounts.map((account) => (
          <li
            key={`${account.kind}:${account.key}`}
            data-testid="lists-entered-item"
          >
            {account.kind === "user" ? "User id" : "API key id"}{" "}
            <code>{account.typed}</code> → key <code>{account.key}</code>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="ghost"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}
