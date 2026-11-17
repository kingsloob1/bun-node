/** A path under the mount that is no screen. */
import { Link } from "../router";

/** See the module's description. */
export function NotFound() {
  return (
    <div
      className="screen"
      data-testid="not-found"
    >
      <h1>Not found</h1>
      <p>
        There is no screen here. <Link to="/">Go to the Overview</Link>.
      </p>
    </div>
  );
}
