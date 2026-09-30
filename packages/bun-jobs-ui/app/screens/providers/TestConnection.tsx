import { useMutation } from "@tanstack/react-query";
import { validateProvider } from "../../api/providers";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { ProblemBanner } from "../../components/ProblemBanner";
import { useApiClient } from "../../context";
import { displayText } from "../../format";
import { providerCheck, validationSummary } from "./providerText";

/** Props of {@link TestConnection}. */
export interface TestConnectionProps {
  /** The provider's id, `name@version~n`. */
  providerId: string;
  /** What the button's accessible name says it tests, e.g. the provider's name. */
  label: string;
}

/**
 * "Test connection": runs the provider's preflight (`POST
 * /providers/:id/validate`) and shows what it found in place, the summary
 * first and then each check. The caller renders it only where the provider
 * has a preflight and the caller may validate (`providers.validate`, never
 * read-only).
 *
 * A failed preflight is an answer, not an error: it says whose problem it
 * is (the config's, the credentials', the platform's) or that it timed out.
 * Only a refused or broken request shows as a problem banner.
 */
export function TestConnection({ providerId, label }: TestConnectionProps) {
  const api = useApiClient();
  const test = useMutation({
    mutationFn: () => validateProvider(api, providerId),
  });
  const result = test.data;
  return (
    <div
      className="provider-test"
      data-testid={`provider-test-${providerId}`}
    >
      <Button
        size="sm"
        onClick={() => test.mutate()}
        disabled={test.isPending}
        aria-label={`Test connection: ${label}`}
      >
        {test.isPending ? "Testing…" : "Test connection"}
      </Button>
      {test.isError && (
        <ProblemBanner
          error={test.error}
          title="Could not run the test"
        />
      )}
      {result !== undefined && !test.isPending && (
        <div
          className="provider-test-result"
          role="status"
          data-testid="provider-test-result"
          data-ok={String(result.ok)}
        >
          <p className={result.ok ? "provider-test-ok" : "provider-test-fail"}>
            {validationSummary(result)}
          </p>
          {result.checks.length > 0 && (
            <ul className="provider-checks">
              {result.checks.map((check) => {
                const status = providerCheck(check.status);
                return (
                  <li
                    key={check.id}
                    data-testid={`provider-check-${check.id}`}
                  >
                    <Badge tone={status.tone}>{status.label}</Badge>{" "}
                    <code>{displayText(check.id)}</code>
                    {check.detail !== undefined && (
                      <span className="muted">
                        {" "}
                        — {displayText(check.detail)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
