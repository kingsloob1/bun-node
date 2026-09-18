import type { ErrorDto } from "../../api/types";
import { JsonView } from "../../components/JsonView";
import { causeChain } from "./errorChain";

/** Props of {@link ErrorDetails}. */
export interface ErrorDetailsProps {
  /** The error, as the API serialises it. */
  error: ErrorDto;
  /** Accessible name of the block, e.g. "Failure". Defaults to `"Error"`. */
  label?: string;
}

/** One level of an error: `Name: message`, its code, extra data and stack. */
function ErrorLevel({ error }: { error: ErrorDto }) {
  return (
    <>
      <p className="job-error-line">
        <strong className="job-error-name">{error.name}</strong>
        {": "}
        <span className="job-error-message">{error.message}</span>
        {error.code !== undefined && (
          <code className="job-error-code">code {String(error.code)}</code>
        )}
      </p>
      {error.data && Object.keys(error.data).length > 0 && (
        <JsonView
          value={error.data}
          label={`${error.name} data`}
          expandDepth={1}
        />
      )}
      {error.stack && <pre className="job-error-stack">{error.stack}</pre>}
    </>
  );
}

/** A serialised error with its cause chain ("Caused by …"). */
export function ErrorDetails({ error, label = "Error" }: ErrorDetailsProps) {
  const [outer, ...causes] = causeChain(error);
  return (
    <div
      className="job-error"
      role="group"
      aria-label={label}
    >
      <ErrorLevel error={outer!} />
      {causes.length > 0 && (
        <ol
          className="job-error-causes"
          aria-label="Causes"
        >
          {causes.map((cause, index) => (
            // The chain is positional: a cause has no identity of its own.
            // eslint-disable-next-line react/no-array-index-key
            <li key={index}>
              <span className="job-error-caused-by muted">Caused by</span>
              <ErrorLevel error={cause} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
