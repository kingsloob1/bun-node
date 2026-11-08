import { EmptyState } from "../components/EmptyState";
import { Link } from "../router";

/** The 404 screen: an unknown path, or a screen this caller cannot use. */
export function NotFoundScreen() {
  return (
    <div
      className="screen"
      data-testid="not-found"
    >
      <h1 className="screen-title">Page not found</h1>
      <EmptyState
        title="There is nothing here"
        description="The page does not exist, or this API does not offer it to you."
        action={<Link to="/">Go to the start page</Link>}
      />
    </div>
  );
}
