/**
 * The break-glass sign-in (the user's decision, PR-U1): the account's
 * password and an authenticator code, `POST /break-glass/session`; the
 * token answered is kept in `sessionStorage` (cleared when the tab closes,
 * on expiry, or on a `401`) and sent with every call. Offered from the
 * "Sign in required" view only when the API has the account.
 */
import { useState } from "react";
import { Button } from "../../kit/components/Button";
import { Field } from "../../kit/components/Field";
import { TextInput } from "../../kit/components/inputs";
import { dataOf } from "../api/client";
import { isApiError } from "../api/errors";
import { useSecurityClient } from "../context";

/** Props of {@link BreakGlassForm}. */
export interface BreakGlassFormProps {
  /** Called once a session is kept. */
  onSignedIn: () => void;
}

/** See the module's description. */
export function BreakGlassForm({ onSignedIn }: BreakGlassFormProps) {
  const api = useSecurityClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await dataOf(
        api.client.post("/break-glass/session", { body: { password, code } }),
      );
      api.breakGlass.save({
        token: session.token,
        expiresAt: session.expiresAt,
        header: session.header,
      });
      setPassword("");
      setCode("");
      onSignedIn();
    } catch (failure) {
      setError(
        isApiError(failure) && failure.status === 429
          ? "The break-glass account is locked after too many failed attempts. Try again in 15 minutes."
          : isApiError(failure) && failure.status === 401
            ? "The password or the code is wrong."
            : "The break-glass sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="break-glass-form"
      data-testid="break-glass-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Break-glass sign-in</h2>
      <p>
        For when the identity provider is down during an incident. Every use is
        recorded and alerted, and the session ends after 15 minutes.
      </p>
      <Field
        label="Password"
        required
      >
        <TextInput
          placeholder="The break-glass password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
      </Field>
      <Field
        label="Authenticator code"
        required
      >
        <TextInput
          placeholder="e.g. 492039"
          value={code}
          onChange={setCode}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
        />
      </Field>
      {error === null ? null : (
        <p
          className="break-glass-error"
          role="alert"
          data-testid="break-glass-error"
        >
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || password === "" || code.length !== 6}
      >
        Sign in with break-glass
      </Button>
    </form>
  );
}
